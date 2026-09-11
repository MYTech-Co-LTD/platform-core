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
import { wecomRoutes } from './routes/auth-wecom'

/** platform schema 迁移（Task 11 产物目录）——按本文件位置解析，与 cwd 无关 */
const platformMigrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * modules/ 目录：按约定 `process.cwd() + ../../modules`（pnpm 脚本 cwd=apps/server →
 * 仓根 modules/）。宿主必须经 pnpm 脚本（pnpm dev / pnpm --filter @platform/server dev /
 * Docker pnpm start）启动——裸 cwd 仓根直跑 tsx 时该相对路径不成立（详见任务报告）。
 */
const modulesDir = path.resolve(process.cwd(), '../../modules')

/** apps/web/dist（Task 17 构建产物）：按本文件位置解析（src/ → ../../web/dist），与 cwd 无关 */
const webDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url))

export interface BuildAppOverrides {
  /** 显式注入配置（冒烟/测试免 process.env 装配）；缺省 loadConfig() fail-fast */
  config?: AppConfig
  /** 注入 fixture ModulesRuntime（跳过磁盘 loadModules；I-1 挂载顺序契约不变） */
  modules?: ModulesRuntime
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
    runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactory })
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

  // ⑤ /healthz —— 在租户中间件之前：探活不带业务 Host（LB/容器探针无租户域）
  app.get('/healthz', (c) => c.json({ ok: true }))

  // ⑥ 租户 → 会话（I-1：全局、先于一切业务路由与 runtime.mount）
  app.use('*', resolveTenantMiddleware({
    pool,
    mode: config.tenantMode,
    platformOrg: config.platformOrg,
  }))
  app.use('*', sessionMiddleware({ casdoor: casdoorFactory, sessionSecret: config.sessionSecret }))

  // ⑦ 平台路由：branding/config（modules 注入 = runtime 的 console 数据 + enabledFor 闸门）
  app.route('/api/platform', platformRoutes({
    pool,
    modules: () => toModuleInfos(runtime),
    enabledFor: runtime.enabledFor,
  }))
  // ⑧ 登录三路：账密 + 企微 qr/silent（platformRoutes 同前缀，注册序不影响——路径不重叠）
  app.route('/api/platform/auth', authRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
  }))
  app.route('/api/platform/auth/wecom', wecomRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    casdoorUrl: config.casdoor.url,
    casdoorClientId: config.casdoor.clientId,
    casdoorClientSecret: config.casdoor.clientSecret,
    publicOrigin: config.publicOrigin,
  }))

  // ⑨ 模块 API（/api/modules/<id>/*）+ 模块 userApp 静态（mount 内部处理）。
  // cast 说明：mount 的签名收 Hono（BlankEnv），本 app 带 TenantEnv&SessionEnv——
  // Hono 泛型协变不接受（TS2345），但 mount 内只 route/use 不触碰变量表，运行时同构
  runtime.mount(app as unknown as Hono)

  // ⑩ web 静态（Task 17 dist 产物）：/console/* 文件命中直出、未命中回退 SPA index；
  // 其余非 /api GET（/、/login 等 SPA 路由）回退 index.html。dist 不存在 → warn 跳过
  if (existsSync(webDistDir)) {
    const stripConsole = (p: string) => p.slice('/console'.length) || '/'
    const spaIndex = serveStatic({ root: webDistDir, path: 'index.html' })
    // dist 根路径静态文件（/assets/*.js|css、/favicon.svg）：vite 构建的 index.html 以
    // 站点绝对路径引用这些产物，缺这道中间件时它们会落进 SPA 兜底拿到 index.html，
    // 浏览器永远白屏（Task 19 浏览器验证暴露）。未命中 next() 放行给 SPA 兜底
    app.use('*', serveStatic({ root: webDistDir }))
    app.use('/console', serveStatic({ root: webDistDir, rewriteRequestPath: stripConsole }))
    app.use('/console/*', serveStatic({ root: webDistDir, rewriteRequestPath: stripConsole }))
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
      `[web] ${webDistDir} 不存在，跳过静态托管（登录页/控制台不可用——先 pnpm --filter @platform/web build）`,
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
