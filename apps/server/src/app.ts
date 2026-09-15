// app.ts — 宿主组装（Task 16）：Task 11-15 全部产物拧成一个可启动进程
//
// 顺序（I-1 硬契约，Task 15 移交）：runtime.mount(app) 之前必须已全局挂
// 「租户解析 → 会话」两道中间件——模块路由的 requireScope 读 c.get('identity')，
// 会话层少一道即模块 API 全线 401（未登录）/漏身份（已登录）。
//   loadConfig → getPool → runMigrations(platform) → seed(可选) → loadModules →
//   Hono：安全头 → /healthz → 租户 → 会话 → /api/platform/* → auth → wecom →
//   runtime.mount(/api/modules/* + userApp) → web 静态 → notFound
//
// overrides 供冒烟/测试注入：config（免 env 装配）与 modules（免磁盘模块的 fixture
// runtime）——注入 modules 时跳过磁盘扫描，但挂载顺序契约不变（I-1 对 fixture 同样成立）。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Pool } from 'pg'
import { CasdoorClient } from '@platform/auth-core'
import { loadConfig, type AppConfig } from './config'
import { getPool } from './db'
import { loadModules, type ModulesRuntime } from './loader'
import { runMigrations } from './migrate'
import { seedDemo } from './seed'
import { getTenantByHost, resolveTenantMiddleware, type TenantEnv } from './tenant'
import { sessionMiddleware, type CasdoorFactory, type SessionEnv } from './session-middleware'
import { platformRoutes, type ModuleInfo } from './routes/platform'
import { authRoutes } from './routes/auth'
import { adminRoutes } from './routes/admin'
import { PLATFORM_BUILTIN_PERMISSIONS } from './loader'
import { wecomRoutes } from './routes/auth-wecom'
import { wechatOaRoutes } from './routes/auth-wechat-oa'
import { createLoginLimiter } from './rate-limit'

/** platform schema 迁移（Task 11 产物目录）——按本文件位置解析，与 cwd 无关 */
const platformMigrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * modules/ 目录：按约定 `process.cwd() + ../../modules`（pnpm 脚本 cwd=apps/server →
 * 仓根 modules/）。宿主必须经 pnpm 脚本（pnpm dev / pnpm --filter @platform/server dev /
 * Docker pnpm start）启动——裸 cwd 仓根直跑 tsx 时该相对路径不成立（详见任务报告）。
 */
const modulesDir = path.resolve(process.cwd(), '../../modules')

/**
 * 全仓请求体上限（M1 闭债 R4）。此前只有登录路做了有界读取（routes/auth.ts 的
 * readBodyBounded，上限 8192），其余 `/api/*` 端点无任何上限 —— 未认证请求即可用大 body
 * 撑内存。用 hono 自带的 body-limit（不手搓）。
 *
 * 取值理由：本仓已知的最大正当载荷是便签正文 2000 字符（modules/demo 的 MAX_NOTE_LEN），
 * 1 MiB 留出两个数量级余量；将来若出现上传类端点，应**按路由**单列而非抬这个全局值。
 * 登录路自己的 8192 上限更严，仍然生效（它读 body 时走 readBodyBounded）。
 */
export const MAX_API_BODY_BYTES = 1024 * 1024

/**
 * 静态响应的两个缓存档（M1 闭债 R5）。此前全仓 `Cache-Control` 零命中：vite 产物与 SPA 兜底
 * 一视同仁，浏览器只能吃启发式缓存——**带内容哈希的产物每次白重验**，而 index.html 又可能被
 * 缓存住 ⇒ 发版后用户拿到旧壳去请求已删除的旧 assets，页面白屏。
 * 全仓统一选 `no-cache`，不用 `max-age=0, must-revalidate`——两者语义等价，但 `no-cache`
 * 是各家代理/CDN 都认的写法。
 *
 * `no-cache` 的**代价要说准**（R5 三路评审必须改 2，原文此处误写成"每次带 ETag/Last-Modified
 * 重验，命中则 304"）：本栈的静态托管（`@hono/node-server@2.1.1` 的 `serveStatic`）
 * **不发 ETag，也不处理条件请求**——其实现只有 Range 分支，不看 `If-None-Match` /
 * `If-Modified-Since`（全仓 `grep -rni etag` **只命中注释**，无任何实现/依赖在用）。**实测**：首响应
 * `etag=null`；拿同一 `Last-Modified` 回发 `If-Modified-Since` 仍得 `200` + 全量 body。
 * 所以 `no-cache` 在这里的真实含义是**每次 200 全量重传**，而不是"命中则 304"——后来者别
 * 据此判断"重验很便宜"。实测代价可接受（index.html 约 461B），这也是选 `no-cache` 而非
 * `max-age=0, must-revalidate` 的**唯一书面依据**。
 * 真要有 304 需先加条件请求支持（`hono/etag`）——超出本任务范围，见任务报告的【遗留】。
 */
const CACHE_ASSET = 'public, max-age=31536000, immutable'
const CACHE_REVALIDATE = 'no-cache'

/** apps/web/dist（Task 17 构建产物）：按本文件位置解析（src/ → ../../web/dist），与 cwd 无关 */
const webDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url))

export interface BuildAppOverrides {
  /** 显式注入配置（冒烟/测试免 process.env 装配）；缺省 loadConfig() fail-fast */
  config?: AppConfig
  /** 注入 fixture ModulesRuntime（跳过磁盘 loadModules；I-1 挂载顺序契约不变） */
  modules?: ModulesRuntime
  /**
   * 注入 fixture web dist（M1 闭债 R5）：静态托管的行为测试**不能依赖真机构建产物**——
   * CI 的 `unit` job 只跑 `pnpm test`、从不构建 web（见 .github/workflows/ci.yml 的分工：
   * dist 相关工作归 `smoke` job，它自己先 build），真按 apps/web/dist 断言只会红在 CI 上。
   * 缺省 = apps/web/dist，生产与冒烟路径一字未变。
   */
  webDistDir?: string
}

export async function buildApp(overrides: BuildAppOverrides = {}): Promise<{
  app: Hono<TenantEnv & SessionEnv>
  config: AppConfig
  modules: ModulesRuntime
}> {
  const config = overrides.config ?? loadConfig()
  const pool = getPool(config)

  // ① platform schema 先行（tenant/tenant_domain/tenant_module/audit 四表）
  await runMigrations(pool, 'platform', platformMigrationsDir)

  // CasdoorClient 工厂：按 org 缓存实例。构造本身轻量，但 admin 会话缓存在实例内——
  // 同 org 复用即免重复登 admin；multi 模式各租户 org 各自实例（Task 13 移交项）
  const casdoorByOrg = new Map<string, CasdoorClient>()
  const casdoorFactory: CasdoorFactory = (org: string): CasdoorClient => {
    let client = casdoorByOrg.get(org)
    if (!client) {
      client = new CasdoorClient({
        origin: config.casdoor.url,
        clientId: config.casdoor.clientId,
        clientSecret: config.casdoor.clientSecret,
        org,
        application: config.casdoor.application,
        adminUser: config.casdoor.adminUser,
        adminPwd: config.casdoor.adminPwd,
      })
      casdoorByOrg.set(org, client)
    }
    return client
  }

  // ② demo 种子（SEED_DEMO=1；幂等收敛，重跑安全）。**必须先于装载**：装载器的权限码
  //    供给按 platform.tenant 取租户 org，全新库上租户还不存在时会一个码都建不出来
  //    （本设计引入的次序约束，见 docs/superpowers/specs/2026-09-11-*）
  if (config.seedDemo) await seedDemo(pool)

  // ③ 模块装载（overrides.modules 注入时跳过）。权限码供给交给工厂：装载器自己按
  //    platform.tenant 的各租户 org 逐个 upsert —— multi 下每个租户各有一套码，
  //    写侧与读侧（session-middleware 的 casdoor(p.org)）因此同源。
  //    这里无条件传工厂：admin 凭据在 config 层已是必填，装载器拿不到工厂的情形
  //    在生产上不存在（该可选参数只服务测试与注入式用法）
  let runtime: ModulesRuntime
  if (overrides.modules) {
    runtime = overrides.modules
  } else {
    runtime = await loadModules(modulesDir, {
      pool,
      casdoorFor: casdoorFactory,
      // spec D6 灰度开关：默认 platform（旧表）；显式 casdoor 才切订阅源
      subscriptionSource: process.env.PLATFORM_SUBSCRIPTION_SOURCE === 'casdoor' ? 'casdoor' : 'platform',
      subscriptionCacheTtlMs: Number(process.env.PLATFORM_SUBSCRIPTION_CACHE_TTL_MS) || 60_000,
    })
  }

  const app = new Hono<TenantEnv & SessionEnv>()

  // ④ 安全头基线（全局，含 /healthz 与静态）。next 前后各设一次：前=覆盖经 Context
  // 构造的响应（c.json/body/redirect/preparedHeaders 路径），后=覆盖 handler 直接
  // return 的裸 Response / 兜底 notFound；重复赋同值幂等无副作用
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    await next()
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    c.res.headers.set('Referrer-Policy', 'no-referrer')
  })

  // ④.5 请求体上限（M1 闭债 R4）：早于租户解析（拒绝超大载荷不应先做 DB 查询）。
  // 挂在 /api/* 子树——用 hono 自带的 body-limit（不手搓）；超限返 413 + 同一 JSON 形状。
  // 顺序约束（Hono 实测）：中间件只对**其后注册**的路由生效，故必须挂在这里（所有
  // /api/* 路由都在下面 ⑦⑧⑨ 注册）；挂到路由之后再 use 会永不执行。
  //
  // **登录路同样先落在这里（R4 评审 S2，有意为之）**：>1 MiB 的登录体被这道全局上限拒掉
  // ⇒ 它**到不了** routes/auth.ts 的三层登录限速器，而那里的注释说"超限计数照记"——两句
  // 说的是**两件事**，别当成矛盾：auth.ts 那句管的是**它自己** 8192 那道有界读取
  // （readBodyBounded 越界 ⇒ 计数照记）；1 MiB 以上的体在本层就被拒，**不读体、不写 audit、
  // 不调 Casdoor**。这是刻意取舍：1 MiB 这个量级已经明确是滥用流量，为它保留一条"解析出
  // username 再按用户维度计数"的路径，等于让滥用者用最大成本换最精确的计数。代价说清楚：
  // 本层挂在租户解析（⑥）**之前**，而限速器在 authRoutes（⑧）里 ⇒ 被这里拒掉的登录请求
  // **三层限速器一层都不计**（连租户桶都不记）。这是有意的，若要改这条口径，上面两处注释
  // 必须一起改。
  app.use('/api/*', bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: async (c) => {
      // **必须先把请求体流 cancel 掉再回 413**（M1 闭债 R4 评审 must-fix 2）。
      // 不 cancel 时 @hono/node-server 会直接销毁 socket，客户端还在写 body 就拿到
      // ECONNRESET/EPIPE 而**不是这个 413**——真 socket 探针实测 25–35% 的超限请求如此
      // （进程内 app.request() 无 socket，看不见这条；回归面在 app.test.ts 的
      //  「真 HTTP（真 @hono/node-server + 真 socket）」describe）。
      // 触发条件**两个条件缺一不可**（R4 复审 S-a 四格实测，每格 40 次）：
      //   ① **提前返回发生在中间件里**（onError 直接回 413、不 next），**且**
      //   ② 返回前**访问过请求体流又弃之不用**。
      //   裸 handler 里碰 body ⇒ 40/40 干净；中间件里提前返回但不碰 body ⇒ 40/40 干净；
      //   **中间件提前返回 + 碰过 body ⇒ 27/40 回归**（本任务修的正是这一格）；同格再加下面
      //   那句 cancel ⇒ 40/40 回到对照基线。缺任一条件都不复现——只写"碰了 body"会把结论推宽。
      // 机制：hono/body-limit 首行 `if (!c.req.raw.body) return next()` 一旦读了 body 就不再
      // 有"没碰过它"这条退路。
      // 适用面（标定过，别把结论推得更广）：这是 **keep-alive 客户端**的回归——不 cancel
      // 26/40 干净，cancel 后 40/40 回到"从不碰 body"的对照基线（评审探针同结论 120/120）。
      // 声明 `Connection: close` 的客户端在 cancel 后仍会重置——但那**不是本次改动引入的**：
      // 同样条件下"从不碰 body"的对照本身就只有 ~70% 干净，属 @hono/node-server 的固有行为。
      // catch 吞掉：流已被对端掐断时 cancel 会抛，那不该盖过 413 本身——这个 413 才是
      // 客户端该看到的东西。返回 Promise 是刻意的：bodyLimit 的 onError 允许 async，
      // 不 await 就返回会让 cancel 与响应写出赛跑，把刚修好的竞态又放回来。
      await c.req.raw.body?.cancel().catch(() => {})
      return c.json({ error: 'PAYLOAD_TOO_LARGE' }, 413)
    },
  }))

  // ⑤ /healthz —— 在租户中间件之前：探活不带业务 Host（LB/容器探针无租户域）
  app.get('/healthz', (c) => c.json({ ok: true }))

  // ⑥ 租户 → 会话（I-1：全局、先于一切业务路由与 runtime.mount）
  app.use('*', resolveTenantMiddleware({
    pool,
    mode: config.tenantMode,
    platformOrg: config.platformOrg,
  }))
  // guestScopes（审查 I1）：访客 session（wechat-oa）的 scopes 刷新不查 Casdoor（openid 在
  // Casdoor 无账户——查了必 userGone 清会话，7 天 TTL 实际活不过 5 分钟），改由 loader 的
  // enabledGuestScopes 按当前租户已启用模块重算（停用模块即掉码）；runtime 已在 ③ 产出
  app.use('*', sessionMiddleware({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    guestScopes: runtime.enabledGuestScopes,
  }))

  // ⑦ 平台路由：branding/config（modules 注入 = runtime 的 console 数据 + enabledFor 闸门）
  app.route('/api/platform', platformRoutes({
    pool,
    modules: () => toModuleInfos(runtime),
    enabledFor: runtime.enabledFor,
  }))
  // ⑧ 登录三路：账密 + 企微 qr/silent（platformRoutes 同前缀，注册序不影响——路径不重叠）
  // 登录限速器（M1 闭债 R2）：**一个实例传两处**（账密 + 企微）——分实例会与分桶一样把额度
  // 按份数放大，却额外放大第 1 层（user 桶），无任何收益（预算口径见 rate-limit.ts 的 Door）
  const limiter = createLoginLimiter()
  app.route('/api/platform/auth', authRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    limiter,
  }))
  app.route('/api/platform/auth/wecom', wecomRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    limiter,
    casdoorUrl: config.casdoor.url,
    casdoorClientId: config.casdoor.clientId,
    casdoorClientSecret: config.casdoor.clientSecret,
    publicOrigin: config.publicOrigin,
  }))
  // ⑧c 公众号访客登录路（售后 spec §1.3）：外部客户 openid 直接签访客 session（不落
  // Casdoor），租户行公众号配置存在即启用。依赖 runtime.enabledGuestScopes——runtime 在
  // ③（装载段）产出、先于整条 Hono 装配链，故此处可直接引用（顺序约束：若日后重构使
  // 装载晚于路由挂载，本块必须随之下移到 runtime 产出之后——Hono 路径不重叠时注册序
  // 不影响分发）。同一 limiter 实例第三处传入，门键 'wechat-oa' 在路由内部独立分桶。
  app.route('/api/platform/auth/wechat-oa', wechatOaRoutes({
    sessionSecret: config.sessionSecret,
    pool,
    limiter,
    publicOrigin: config.publicOrigin,
    enabledGuestScopes: runtime.enabledGuestScopes,
  }))

  // ⑧b 租户管理域（spec D4/D9，M3，issue #46）：/api/platform/admin/*——
  // org 锁本租户 + requireScope('tenant:admin') 门禁 + 写操作 CSRF，全在路由内部结构锁死。
  // 权限码宇宙 = 平台内置码（tenant:admin）+ 已装载模块码——授权页只能看到这两层发得出来的码
  app.route('/api/platform/admin', adminRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    permissions: () => [
      ...PLATFORM_BUILTIN_PERMISSIONS,
      ...runtime.modules.flatMap((m) => m.manifest.permissions),
    ],
    modules: () => runtime.modules.map((m) => ({ id: m.manifest.id, name: m.manifest.name })),
  }))

  // ⑨ 模块 API（/api/modules/<id>/*）+ 模块 userApp 静态（mount 内部处理）。
  // cast 说明：mount 的签名收 Hono（BlankEnv），本 app 带 TenantEnv&SessionEnv——
  // Hono 泛型协变不接受（TS2345），但 mount 内只 route/use 不触碰变量表，运行时同构
  runtime.mount(app as unknown as Hono)

  // ⑩ web 静态（Task 17 dist 产物）：/console/* 文件命中直出、未命中回退 SPA index；
  // 其余非 /api GET（/、/login 等 SPA 路由）回退 index.html。dist 不存在 → warn 跳过
  // （distDir 默认 apps/web/dist；测试可注入 fixture，见 BuildAppOverrides.webDistDir）
  const distDir = overrides.webDistDir ?? webDistDir
  if (existsSync(distDir)) {
    const stripConsole = (p: string) => p.slice('/console'.length) || '/'

    // 缓存头中间件：**必须注册在 serveStatic 之前**。@hono/node-server 的 serveStatic 一旦命中
    // 就 `return result`、**不再 next()**，注册在它之后的中间件对"命中的产物"根本不执行
    // （与 ④ 安全头同一手法：`await next()` 之后再改 c.res，才覆盖得到直出的裸 Response）。
    // 判定只看**实际吐出的产物类型**，不看"路径里有没有点"那类会随 vite 配置漂移的启发式：
    //   · text/html（index.html）——无论来自 `/`、`/login`、`/console` 深链，还是 **/assets/ 下
    //     未命中而落 SPA 兜底**的那份——一律可重验；
    //   · 其余只认 /assets/ 前缀（= vite 带内容哈希的产物）为 immutable，别的一律可重验。
    //
    // **已知边界（R5 三路评审建议 1，有意不改行为）**：分档键取的是**请求路径**而非**实际
    // 命中的产物**，三格会分错档；真实影响 ≈ 0（都是"少优化"或"dev 专属"），故只记不修：
    //   ① `/console/assets/<hash>.js`：stripConsole 剥掉 `/console` 后命中的是**同一份哈希
    //      产物**，但 c.req.path 不以 `/assets/` 开头 ⇒ 拿到 `no-cache`（同产物两个档）。
    //   ② `/ASSETS/<hash>.js`：**大小写不敏感的 FS（macOS 开发机）**上同样命中该产物，
    //      而 startsWith 区分大小写 ⇒ 也拿 `no-cache`。生产是 Linux（FS 区分大小写），
    //      该路径不命中产物、落 SPA 兜底 ⇒ 本就该 no-cache，无障碍。
    //   ③ 反向：`/assets/` 下**无内容哈希**的文件（若将来往 dist/assets/ 放静态资源）会被
    //      按前缀钉成一年 immutable，发版不会失效——往 assets/ 放东西时要记得这点。
    app.use('*', async (c, next) => {
      await next()
      const res = c.res
      // `res.status >= 400` 而非 `!res?.ok`（R5 三路评审建议 4）：`Response.ok` 是
      // **2xx 才为真**，304 会被挡在门外 ⇒ 将来补上 ETag/条件请求（或升级 serveStatic）
      // 后，304 反而漏设 Cache-Control（RFC 9111 §4.3.4 要求 304 携带与 200 一致的
      // Cache-Control）。今天无 304 故非缺陷，但这条耦合太隐蔽，顺手按"只跳过错误响应"写。
      if (!res || res.status >= 400) return
      const isHtml = (res.headers.get('content-type') ?? '').includes('text/html')
      res.headers.set(
        'Cache-Control',
        !isHtml && c.req.path.startsWith('/assets/') ? CACHE_ASSET : CACHE_REVALIDATE,
      )
    })

    const spaIndex = serveStatic({ root: distDir, path: 'index.html' })
    // dist 根路径静态文件（/assets/*.js|css、/favicon.svg）：vite 构建的 index.html 以
    // 站点绝对路径引用这些产物，缺这道中间件时它们会落进 SPA 兜底拿到 index.html，
    // 浏览器永远白屏（Task 19 浏览器验证暴露）。未命中 next() 放行给 SPA 兜底
    app.use('*', serveStatic({ root: distDir }))
    app.use('/console', serveStatic({ root: distDir, rewriteRequestPath: stripConsole }))
    app.use('/console/*', serveStatic({ root: distDir, rewriteRequestPath: stripConsole }))
    // serveStatic 未命中会 next() 放行 → GET 落到这里回退 SPA（/console 深链）
    app.get('/console', spaIndex)
    app.get('/console/*', spaIndex)
    // 非 /api 的 GET 全兜底：/、/login（Task 17 SPA 路由）；/api/* 未命中落 notFound JSON
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next()
      return spaIndex(c, next)
    })
  } else {
    console.warn(
      `[web] ${distDir} 不存在，跳过静态托管（登录页/控制台不可用——先 pnpm --filter @platform/web build）`,
    )
  }

  // ⑪ 兜底：API 未命中/静态未挂时的统一 JSON
  app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404))

  // single 模式 boot 探测（Task 12 M1 决策）：查不到只 warn 不死——seed 顺序问题可自愈
  // （请求期由租户中间件 500 暴露，seed 跑齐后下一请求即恢复）
  if (config.tenantMode === 'single') {
    const probe = await getTenantByHost(pool, undefined, 'single', config.platformOrg)
    if (!probe) {
      console.warn(
        `[boot] TENANT_MODE=single 但租户不存在：casdoor_org=${JSON.stringify(config.platformOrg)}`
          + '（检查 PLATFORM_ORG 配置或先跑 seed）',
      )
    }
  }

  return { app, config, modules: runtime }
}

/** LoadedModule[] → platformRoutes 的 ModuleInfo[]（console 条目只留运行时四字段，entry 不外泄） */
function toModuleInfos(runtime: ModulesRuntime): ModuleInfo[] {
  return runtime.modules.map((m) => ({
    id: m.manifest.id,
    name: m.manifest.name,
    console: (m.manifest.frontend?.console ?? []).map(
      ({ path: p, title, icon, scope }) => ({ path: p, title, icon, scope }),
    ),
  }))
}
