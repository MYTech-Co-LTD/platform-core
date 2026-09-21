// loader.ts — 模块装载器（Task 15）：扫描 modules/*/manifest.yaml → 校验 → 迁移 →
// 权限码 upsert → 动态 import index.ts → createRouter 收集；ModulesRuntime 暴露
// modules / mount / enabledFor。整个底座架构的心脏：模块接入协议（@platform/sdk
// ManifestSchema）唯一的运行时消费方（scripts/check-manifests.mjs 是静态消费方）。
//
// 失败语义：manifest 缺失/不合法、id 重复、index.ts 非 defineModule 产物——全部抛错
// 带绝对路径，宿主（Task 16）启动即死（fail-fast），绝不带病挂半个模块。
//
// 权限码供给的 org 策略（M1）：权限码是平台级能力，但 Casdoor 的权限记录按 org（owner=）
// 存储，而读侧按租户 org 读（session-middleware.ts 的 casdoor(p.org)）——故装载器遍历
// platform.tenant 的每个 casdoor_org 各建一套码（provisionModulePermissions）。
// 权威租户清单来自 DB，**不是 PLATFORM_ORG 环境变量**（后者只服务 single 的租户解析）。
// 只写一个 org 的旧策略会让其余租户 effectiveScopes 恒空 ⇒ 模块 API 全线 403 而宿主全绿。
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { enabledFromSubscriptions, SubscriptionCache } from './subscription-source'
import { parse as parseYaml } from 'yaml'
import type { CasdoorClient } from '@platform/auth-core'
import {
  DECLARED_GATE_APPROVED,
  ManifestSchema,
  TENANT_STORAGE,
  declaredScopeGate,
  type DeclaredEndpoint,
  type Identity,
  type ModuleDefinition,
  type ModuleManifest,
  type ModulePorts,
  type TenantStorageConfig,
} from '@platform/sdk'
import { Hono } from 'hono'
import type { Env, MiddlewareHandler } from 'hono'
import type { Pool } from 'pg'
import { runMigrations } from './migrate'
import { resolveTenantStorage } from './tenant-storage'
import type { TenantRow } from './tenant'

/** 装载完成的模块：manifest（协议）+ router（createRouter 产物） */
export interface LoadedModule {
  manifest: ModuleManifest
  router: Hono
}

/**
 * mount 内两条中间件（启用闸门 `gate` + M3c 存储投影 `project`）**用到的**全部变量。
 * **只用于给它们各自的 body 定类型**（`MiddlewareHandler<MountEnv>`），不是 mount 形参的类型
 * —— 见下面 `mount<E extends Env>`。
 *
 * 闸门读它们是为了判定「这个租户停用了这个模块吗」：`tenant` 定租户、`identity` 判匿名。
 * 两个都**可以缺席**，且闸门对缺席有显式分支（无租户/匿名一律放行给后续层）——这正是
 * 闸门类型写得比宿主 Env 宽的原因，也是 mount 形参能不挑 Env 的原因。
 *
 * `[TENANT_STORAGE]` 是**投影中间件的产出位**（不是它读的）：键可选是因为「不注入」是常态
 * ——模块没声明 `storage`（不挂投影）、或声明了但没有可用配置（env 不全 / 部分填写）⇒ 不 set。
 * 写在 Variables 里是 Hono 的硬要求（`Context.set` 的键必须 ∈ E['Variables']），
 * 键名用**计算属性**引 SDK 常量：写死字符串就是第二份事实源（改名时它不会跟着改，静默失效）。
 */
export interface MountEnv {
  Variables: { tenant: TenantRow; identity: Identity; [TENANT_STORAGE]?: TenantStorageConfig }
}

/**
 * 装载结果。mount 前中间件链由宿主负责（租户解析 → 会话中间件 → 模块自加
 * requireScope），mount 只做挂载；enabledFor 按「无行=启用默认」求租户可见集。
 *
 * `enabledFor` 有**两个**消费方，且共用同一份实现（见 loadModules 的 enabledForImpl）：
 * routes/platform.ts 的 /config 清单闸门，以及 mount() 挂的 API 启用闸门（M1 闭债 R4）。
 * 两者必须同源——清单里看不到却仍能调通的模块，正是停用语义只落一半时的样子。
 *
 * **`mount` 的形参为什么是 `<E extends Env>(app: Hono<E>)` 而不是 `(app: Hono)`**（issue #68
 * Step 3 实测订正）：Hono 的 Env 在类型层是**不变**的——`E` 既出现在 `Handler<E>` 的参数位
 * （handler 的 `c: Context<E>`），又经 `Set<E>` / 返回的 `Hono<E, …>` 出现在产出位。实测三种
 * 形参都收不下真实调用点：
 *   · `(app: Hono)`（缺省 = `Hono<BlankEnv>`）⇒ 收不下任何带变量表的 app（TS2345）；
 *   · `(app: Hono<MountEnv>)` ⇒ 连 `MountEnv` 的**真超集** `TenantEnv & SessionEnv` 也收不下
 *     （反方向同样 TS2345，缺 `session` 键）；
 *   · 泛型 `E` ⇒ 两边都收得下（E 由调用点推出，app.ts 推 `TenantEnv & SessionEnv`、
 *     测试推各自的 TestEnv）。
 * app.ts 里那句 `runtime.mount(app as unknown as Hono)` 就是被第一条逼出来的双向断言，
 * 已随本次签名订正删除。**闸门 body 的类型没有因此变松**：`gate` 自己注的是
 * `MiddlewareHandler<MountEnv>`，`c.get('tenant')` / `c.get('identity')` 的**键名仍受检**
 * （实测：body 里写 `c.get('zzzNope')` 报 TS2769「'zzzNope' 不可赋给 'identity' | 'tenant'」）。
 */
export interface ModulesRuntime {
  modules: LoadedModule[]
  mount<E extends Env>(app: Hono<E>): void
  enabledFor(tenantId: number): Promise<Set<string>>
  /**
   * 取某模块声明的**端口**（能力，正典 `docs/module-protocol.md`「模块端口：`createPorts`」）。
   *
   * 宿主必须在 `runtime.mount` **之前**拿到某些能力（最典型：PAT 凭证解析——`patIdentityMiddleware`
   * 要在模块路由之前把 `Bearer dkq_…` 解析成主体），而这些能力的数据在模块自己的 schema 里。
   * 宿主直接查 = B1 违规，故由模块经 `createPorts` 供给，宿主在这里**运行时取用**（不是 import，
   * 模块缺席时宿主只是拿到 `undefined`，没有编译期依赖）。
   *
   * 未装载该模块 / 模块没声明 `createPorts` / 没声明这个成员 ⇒ `undefined`，**不抛错**：
   * 缺席是**正常状态**（该部署没装那个模块），由调用方按通道语义处置（如 PAT 端口缺失 ⇒ 503
   * fail-closed，**不是**放行）。
   */
  port<K extends keyof ModulePorts>(moduleId: string, name: K): NonNullable<ModulePorts[K]> | undefined
  /** 该租户已启用模块声明的访客码（manifest guest.scope，售后 spec §1.3：wechat-oa 签访客 session 用） */
  enabledGuestScopes(tenantId: number): Promise<string[]>
}

export interface LoadModulesDeps {
  pool: Pool
  /** 订阅源（spec D5/D6）：platform=旧表（默认）| casdoor=Active 订阅；非法值按 platform */
  subscriptionSource?: 'platform' | 'casdoor'
  /** casdoor 源的订阅缓存 TTL（ms，默认 60000） */
  subscriptionCacheTtlMs?: number
  /**
   * 按 org 返回 CasdoorClient 的工厂（宿主传 casdoorFactory，内部按 org 缓存实例）。
   *
   * 可选**只服务 loader 测试与注入式用法**：宿主 `app.ts` 无条件传工厂，生产上不存在缺省
   * 路径（`config.ts` 已把 admin 凭据设为必填）。缺省时按 warn 跳过供给。
   *
   * 注意别把这里的可选读成「存在一种不配凭据也能用的部署形态」——**没有那种形态**：
   * 登录签发前必调 getUser + getPermissions，两者都走 admin 会话，缺凭据时无人能拿到会话。
   */
  casdoorFor?: (org: string) => CasdoorClient
}

/** 待供给的权限码（manifest.permissions 的元素形状） */
export interface ProvisionPermission {
  code: string
  name: string
}

/**
 * 平台内置权限码（spec D9）：不来自任何模块 manifest，随装载器按租户 org 扇出供给。
 * `tenant:admin` = 租户管理员识别——console「管理」菜单组与 /api/platform/admin/* 的门禁。
 * 授权动作在 Casdoor 完成（给用户挂码）；授予/回收的 UI 在 M3 授权页。
 */
export const PLATFORM_BUILTIN_PERMISSIONS: ReadonlyArray<ProvisionPermission> = [
  { code: 'tenant:admin', name: '租户管理员' },
]

/**
 * 把模块权限码供给到【每个租户各自的 Casdoor org】。
 *
 * 为什么必须遍历租户：权限码是平台级能力，但 Casdoor 的权限记录按 org（owner=）存储，
 * 读侧又按租户 org 读（session-middleware.ts 的 casdoor(p.org)）。只写一个 org ⇒
 * 其余租户 effectiveScopes 恒空 ⇒ 模块 API 全线 403 而宿主全绿（issue #3 第一节）。
 *
 * 权威租户清单来自 platform.tenant，**不是 env**：PLATFORM_ORG 只服务 single 的租户解析。
 * 返回实际供给到的 org 列表——调用方据此区分「没有租户可供给」与「没有权限码可供给」。
 */
export async function provisionModulePermissions(
  pool: Pool,
  casdoorFor: (org: string) => CasdoorClient,
  permissions: ReadonlyArray<ProvisionPermission>,
): Promise<string[]> {
  if (permissions.length === 0) return []
  const { rows } = await pool.query<{ casdoor_org: string }>(
    'select distinct casdoor_org from platform.tenant order by casdoor_org',
  )
  for (const { casdoor_org: org } of rows) {
    // 批量接口：每 org 只拉一次 get-permissions（单码版是每码一次，租户扩张下是乘法开销）
    await casdoorFor(org).upsertPermissions(permissions)
  }
  return rows.map((r) => r.casdoor_org)
}

/** 模块 API 在宿主上的挂载前缀。mount() 与门卫声明共用此处，**不许各写一份**（防漂移） */
export function moduleApiBasePath(id: string): string {
  return '/api/modules/' + id
}

/**
 * 按 manifest 声明给模块 router 施加门卫，并核对声明与代码一致（M1 闭债 R2）。
 *
 * **为什么用包裹层而不是对 router 补 use()**：Hono 里 handler 先注册、use 后注册时门卫
 * 【永不执行】（已实证）——那样会造出一个"代码里有门卫、运行时永不生效"的静默洞。
 * 正解是新建 Hono → 先挂门卫 → 再 route('/', router)（已实证：路径合成正确、门卫先跑）。
 *
 * 双向核对：注册的路由集合必须与声明集合完全一致，任一方向的差集都让装载失败（fail-fast，
 * 与"装载器必填"同风格）。这让"声明与代码漂移"不可能悄悄存在。
 *
 * **`method === 'ALL'` ≠ 一定是中间件**（Task 24 评审 R1）：Hono 里 `app.all()` 与 `app.use()`
 * 同走 `#addRoute('ALL', ...)`（hono-base.js），故 ALL 里混着两种东西，必须分开处置：
 *   · **无通配的 ALL**（`app.all('/secret', h)`、`app.use('/backdoor', 终结 handler)`）在 Hono 里
 *     只匹配【它自己那一条】请求路径（实测：`use('/prefix')` 不匹配 `/prefix/notes`）——它就是
 *     一个"多方法端点"，正是本轮要消灭的"改了代码忘了改 manifest"错误类型。旧实现把它当成
 *     "模块自己的 use() 中间件"整条滤掉，于是它既不参与双向核对、又拿不到声明路径上的门卫 ⇒
 *     **匿名 200**。现在：路径不是任何声明路径的 ALL 端点一律**装载失败**（与"未声明但已注册"
 *     同一处置）；路径是声明路径的（`app.all('/x', h)` + 逐 method 声明）视为合法写法——它落在
 *     该声明的门卫下，门卫按 method 逐条判定（未声明的 method 照旧 403）。
 *   · **含 '*' 的 ALL**（`use('*')` / `use('/prefix/*')` / `mount()`）才是真中间件形态。它们
 *     匹配的请求路径集合**大于**任何一条声明路径，逐条声明的门卫盖不住，故另挂**兜底门卫**
 *     （见下方 allWildcard 段）。
 */
export function applyDeclaredApiGate(
  router: Hono,
  manifest: ModuleManifest,
  mountPath: string = moduleApiBasePath(manifest.id),
): Hono {
  const declared: DeclaredEndpoint[] = manifest.api?.internal ?? []
  const declaredPaths = new Set(declared.map((d) => d.path))

  // 三类注册路由：非 ALL（双向核对用）/ 无通配 ALL（多方法端点）/ 含通配 ALL（中间件形态）
  const registered: string[] = []
  const allExact = new Set<string>()
  const allWildcard = new Set<string>()
  for (const r of router.routes) {
    if (r.method !== 'ALL') {
      registered.push(`${r.method} ${r.path}`)
    } else if (r.path.includes('*')) {
      allWildcard.add(r.path)
    } else {
      allExact.add(r.path)
    }
  }

  const declaredKeys = declared.map((d) => `${d.method} ${d.path}`)
  const declaredSet = new Set(declaredKeys)
  const registeredSet = new Set(registered)
  const undeclared = registered.filter((k) => !declaredSet.has(k))
  // 幽灵声明：既没有同名 method 的注册，也没有一条 ALL 端点坐落在同一路径上。
  // 后半句是"app.all('/x') + 逐 method 声明"这条合法写法的出口：ALL 路由在 routes 里只有一条
  // 'ALL' 记录，若不认它，逐 method 声明会全部被误报成幽灵。
  const phantom = declared
    .filter((d) => !registeredSet.has(`${d.method} ${d.path}`) && !allExact.has(d.path))
    .map((d) => `${d.method} ${d.path}`)
  // 未声明的 ALL 端点：无通配 ALL 只匹配它自己那条路径，路径不在声明里 = 未声明的端点
  const undeclaredAll = [...allExact].filter((p) => !declaredPaths.has(p))

  if (undeclared.length > 0 || phantom.length > 0 || undeclaredAll.length > 0) {
    throw new Error(
      `模块 "${manifest.id}" 的 api.internal 声明与代码不一致：`
      + `未声明但已注册 [${undeclared.join(', ') || '-'}]；`
      + `已声明但未注册 [${phantom.join(', ') || '-'}]；`
      + `未声明的多方法端点（app.all()/use(路径, 终结 handler)）[`
      + `${undeclaredAll.map((p) => `ALL ${p}`).join(', ') || '-'}]`
      + `（未声明 = 不可达；声明与代码必须逐条对齐）`,
    )
  }

  // 门卫的比对表用【宿主绝对路径】，而 use() 的注册路径保持【模块相对】——两者不是一回事：
  // wrapper 被宿主 mount 到 mountPath 后，c.req.routePath 回来的是【绝对】路径（实测：
  // route('/api/modules/mod', wrapper) 下 c.req.routePath === '/api/modules/mod/ping'），
  // 拿模块相对的 '/ping' 去比永远 miss ⇒ 门卫恒 403（"代码里有门卫、运行时全拒"的另一种病）。
  // 注册路径则必须相对：wrapper 自己就挂在 mountPath 上，写成绝对会叠成两段前缀。
  const gate = declaredScopeGate(declared.map((d) => ({ ...d, path: mountPath + d.path })))
  const guarded = new Hono()

  // ① 逐条声明路径挂门卫（先于兜底门卫注册 ⇒ 放行标记在兜底门卫看到它之前就已置位）
  for (const p of new Set(declaredPaths)) guarded.use(p, gate)

  // ② 兜底门卫：只在模块注册了通配 ALL 时才挂（没用 use()/mount() 的模块行为**零变化**）。
  //    它拒掉一切"没被声明门卫放行"的请求——这正是 wildcard 覆盖面大于声明面时的那条缝
  //    （如 use('/prefix/*', mw) 下请求 /prefix/other 会直达模块自己的中间件）。
  //    为什么不能直接在这条通配路径上挂 declaredScopeGate：门卫判定的基准是 c.req.routePath，
  //    而在通配路径上它恒为通配模式本身（已实证：use('*') 下恒为 '/*'），拿去比对必然 miss
  //    ⇒ 恒 403，会把合法的 use('*')/use('/prefix/*') 中间件形态打坏。故用放行标记判定。
  if (allWildcard.size > 0) {
    const fallback: MiddlewareHandler = async (c, next) => {
      if (c.get(DECLARED_GATE_APPROVED)) return next()
      if (!c.get('identity')) return c.json({ error: 'UNAUTHENTICATED' }, 401)
      return c.json({ error: 'FORBIDDEN' }, 403)
    }
    for (const p of allWildcard) guarded.use(p, fallback)
  }

  guarded.route('/', router)
  return guarded
}

/** 内部形态：LoadedModule + 模块目录（userApp dist 相对它解析，不外露） */
interface ModuleEntry extends LoadedModule {
  dir: string
}

export async function loadModules(
  modulesDir: string,
  deps: LoadModulesDeps,
): Promise<ModulesRuntime> {
  // readdir 失败（如 modules/ 目录不存在）自然抛错——宿主启动 fail-fast
  const entries = await readdir(modulesDir, { withFileTypes: true })

  const loaded: ModuleEntry[] = []
  const seen = new Map<string, string>() // id → 首见模块目录（重复 id 报错带两个路径）
  /** id → 该模块声明的端口（`createPorts` 产物）。没声明的模块不入表 ⇒ `port()` 返 undefined */
  const portsByModule = new Map<string, ModulePorts>()

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.resolve(modulesDir, entry.name)
    const manifestPath = path.join(dir, 'manifest.yaml')

    // ① 读 + YAML 解析 + ManifestSchema 校验（失败抛错带绝对路径）
    let manifest: ModuleManifest
    try {
      let parsed: unknown
      try {
        parsed = parseYaml(await readFile(manifestPath, 'utf8'))
      } catch (err) {
        // readFile ENOENT（消息自带绝对路径）原样抛；YAML 语法错包一层带绝对路径
        // （Task 15 评审 M-1：yaml.parse 原始错误只有行号列号，无文件定位）
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
        throw new Error(`${manifestPath}: ${(err as Error).message}`, { cause: err })
      }
      manifest = ManifestSchema.parse(parsed)
    } catch (err) {
      // err?.name 而非 instanceof：manifest 可能来自不同 zod 实例（跨包解析），
      // instanceof 判定会静默退化为"原样抛"（Task 15 评审 M-2）；ZodError.name 是稳定标识
      if ((err as { name?: string } | null)?.name === 'ZodError') {
        throw new Error(`manifest 校验失败 ${manifestPath}: ${(err as Error).message}`, { cause: err })
      }
      throw err
    }

    // ② id 去重：模块 id 是权限/路由命名空间，撞车即协议事故
    const firstDir = seen.get(manifest.id)
    if (firstDir) {
      throw new Error(`模块 id 重复 "${manifest.id}"：${firstDir} 与 ${dir}`)
    }
    seen.set(manifest.id, dir)

    // ③ 模块迁移（目录不存在静默跳过——migrate.ts 约定）
    await runMigrations(
      deps.pool,
      manifest.id,
      path.join(dir, manifest.migrations?.dir ?? 'migrations'),
    )

    // ④ 动态 import index.ts（tsx / vitest 运行时都按 TS 转译）→ defineModule 产物校验
    const entryPath = path.join(dir, 'index.ts')
    const mod = (await import(pathToFileURL(entryPath).href)) as { default?: unknown }
    const def = mod.default as Partial<ModuleDefinition> | undefined
    if (
      !def
      || typeof def !== 'object'
      || !def.manifest
      || typeof def.createRouter !== 'function'
    ) {
      throw new Error(
        `${entryPath} 的 default 导出不是 defineModule 产物（缺 manifest/createRouter）`,
      )
    }

    // ④.5 端口收集（正典「模块端口」）：模块**可选**声明 createPorts，宿主在 mount 前取用。
    //      与 createRouter 同形、同一次装载里建；不声明就跳过（取用侧得 undefined）。
    //      **抛错与 createRouter 同级 fail-fast**：装载期建不起来的端口不该等到第一个请求才暴露。
    if (typeof def.createPorts === 'function') {
      portsByModule.set(manifest.id, def.createPorts({ pool: deps.pool }))
    }

    loaded.push({
      manifest,
      router: applyDeclaredApiGate(def.createRouter({ pool: deps.pool }), manifest),
      dir,
    })
  }

  // ⑤ 权限码供给：平台内置码（D9）+ 全部模块码，一次性供给到每个租户各自的 org。
  //    内置码在前：即使 modules/ 空（零模块）tenant:admin 也要供给——管理员门禁不依赖业务模块。
  //    放在循环之后而非之内：租户清单只需查一次，且 manifest 全部校验通过后才产生副作用
  const allPermissions: ReadonlyArray<ProvisionPermission> = [
    ...PLATFORM_BUILTIN_PERMISSIONS,
    ...loaded.flatMap((m) => m.manifest.permissions),
  ]
  if (deps.casdoorFor) {
    const orgs = await provisionModulePermissions(deps.pool, deps.casdoorFor, allPermissions)
    if (orgs.length === 0 && allPermissions.length > 0) {
      console.warn('[modules] platform.tenant 无租户，权限码未供给任何 org（先跑租户 seed）')
    }
  } else if (allPermissions.length > 0) {
    // warn 说清后果，但**不替调用方断言 HTTP 状态**：这些租户的用户拿不到任何模块权限是
    // 确定的；至于它表现为 403 还是"根本登录不了"，取决于宿主有没有配 admin 凭据（登录
    // 本身就要管理端点）——装载器无从知道，写死 403 就是在许一个自己证明不了的承诺
    const { rows } = await deps.pool.query<{ casdoor_org: string }>(
      'select distinct casdoor_org from platform.tenant order by casdoor_org',
    )
    console.warn(
      '[modules] 未提供 CasdoorClient 工厂，跳过权限码供给：'
        + `${allPermissions.map((p) => p.code).join(', ')} → 租户 org `
        + `[${rows.map((r) => r.casdoor_org).join(', ') || '(无租户)'}]（这些租户的用户将拿不到任何模块权限）`,
    )
  }

  // ⑦ 租户已启用模块集（Task 12 /config 的闸门 + M1 闭债 R4 的 API 启用闸门）。
  //    简报基线 SQL 是 `where tenant_id=$1 and enabled`（只回显式启用行）——「无行=启用默认」
  //    要求把无行模块也并入集合（消费方 routes/platform.ts 直接 .filter(has) 消费），
  //    故取该租户全行后在内存按默认值判定：显式 enabled=true 落集合、false 剔除、
  //    无行视为启用；只回已装载模块的 id（磁盘上已删的模块不在任何租户可见集里）。
  //    提成局部函数是因为 mount 里的启用闸门要用同一份语义——写两遍必然漂移。
  const subCache = new SubscriptionCache({ ttlMs: deps.subscriptionCacheTtlMs ?? 60_000 })
  const enabledForImpl = async (tenantId: number): Promise<Set<string>> => {
    if (deps.subscriptionSource === 'casdoor') {
      const casdoorFor = deps.casdoorFor
      if (!casdoorFor) throw new Error('subscriptionSource=casdoor 需要 casdoorFor（宿主必须注入）')
      const { rows } = await deps.pool.query<{ casdoor_org: string }>(
        'select casdoor_org from platform.tenant where id = $1', [tenantId],
      )
      const org = rows[0]?.casdoor_org
      if (!org) return new Set()
      return subCache.get(org, async () =>
        enabledFromSubscriptions(
          await casdoorFor(org).listSubscriptions(org),
          loaded.map((m) => m.manifest.id),
          Date.now(),
        ))
    }
    const { rows } = await deps.pool.query<{ module_id: string; enabled: boolean }>(
      'select module_id, enabled from platform.tenant_module where tenant_id = $1',
      [tenantId],
    )
    const explicit = new Map(rows.map((r) => [r.module_id, r.enabled]))
    const enabled = new Set<string>()
    for (const m of loaded) {
      if (explicit.get(m.manifest.id) ?? true) enabled.add(m.manifest.id)
    }
    return enabled
  }

  return {
    modules: loaded,

    // ⑥ API 挂 /api/modules/<id>；userApp 静态目录存在才挂（dist 绝对路径，mount 路径来自 manifest）
    mount<E extends Env>(app: Hono<E>): void {
      for (const m of loaded) {
        const base = moduleApiBasePath(m.manifest.id)

        // ⑥.5 启用闸门（M1 闭债 R4）：停用 = **该租户看不到这个模块的 API** ⇒ 404，不是 403
        //      （404 与「这个模块不存在」同形 ⇒ **在模块 API 面内**停用状态不可枚举；403 才泄露
        //      "存在但被停用"）。
        //      ⚠️ 作用域只到**模块 API 面**，不要推成系统级结论（R4 复审 must-fix 2）：宿主
        //      `GET /api/platform/config` 是**有意的披露面**、**只吃租户不吃 identity**（见
        //      routes/platform.ts 的 /config），匿名带 Host 即取到该租户已启用模块清单、停用模块
        //      直接缺席 ⇒ **系统层面可区分停用/不存在**。属存量行为。详见 docs/module-protocol.md
        //      「停用语义」。
        //      **必须 use 在 app.route 之前**：Hono 里 handler 先注册、use 后注册时该中间件
        //      **永不执行**（已实证，见 docs/module-protocol.md「实现注意」第 2 条）——顺序错了
        //      就是一个"代码里有闸门、运行时永不生效"的静默洞。
        //      **只挂 `/*` 一条**（R4 评审 S4）：实测 `use(base + '/*')` 同时命中 `/base`、
        //      `/base/`、`/base/ping`（`/*` 吞空段）——即子树那条**已经覆盖裸 base**。旧写法
        //      另挂一条精确 `use(base)`，看着像"多一层保险"，实际只让裸 base 的请求**跑两次
        //      enabledFor（两次 DB 往返）**，还把冗余钉进了测试（loader.test.ts 曾断言闸门必须
        //      2 条）。精确那条已删。
        //      实测反例：把这条 `use` 挪到 `app.route` 之后 ⇒ 闸门**根本不执行**，请求 200
        //      直达模块（正是「代码里有闸门、运行时永不生效」的静默洞）。
        //      代价：每请求一次 enabledFor 查询（+1 次 DB 往返）。**刻意不做缓存**——「停用后
        //      多久生效」不该有一个隐式窗口；将来若测出瓶颈要加 TTL，必须同时把窗口语义写进
        //      本注释与 docs/module-protocol.md。
        // 闸门的 Env 注 `MountEnv`（本闸门**读到的**变量全集），不注宿主真实装配的
        // `TenantEnv & SessionEnv`：闸门只认这两个键，多注一个 `session` 就是多一处跟着
        // 宿主漂的耦合。注了之后 `c.get(...)` 的键名受检（见 MountEnv 的注释）。
        const gate: MiddlewareHandler<MountEnv> = async (c, next) => {
          const tenant = c.get('tenant') as TenantRow | undefined
          // 无租户上下文（未过租户中间件）不在本闸门职责内，放行给后续层。真实链路上这道
          // 中间件先于一切业务路由，未命中 Host 早已 404/抛错 ⇒ 闸门见到的请求必带租户。
          if (!tenant) return next()
          // **无 identity（匿名）同样直接放行**（R4 评审 S5，协调者裁定）。两个理由：
          //   ① 闸门挂在模块**自身门卫**之前，匿名请求反正会被门卫挡下（401），到这里查库
          //      纯属白费——改动前匿名命中模块 API 是 **0 次 DB**，加了闸门变成每请求 1 次，
          //      而模块 API **没有独立限流** ⇒ 匿名流量可被用来放大 DB 压力。
          //   ② 在**模块 API 面内**不削弱不可枚举性：匿名打**停用**模块与打**启用**模块，落点
          //      都是模块门卫的 401 UNAUTHENTICATED（实测两条响应**逐字相同**），停用与否无从
          //      区分；而已登录用户拿到的仍是 404，语义不变。loader.test.ts 里有这条的用例。
          //      （旧措辞写"**反而更**不可枚举"——那是把面内结论推成了系统级，已订正。宿主
          //        /api/platform/config 匿名可达、且会回该租户已启用清单，见 ⑥.5 与
          //        docs/module-protocol.md「停用语义」。）
          if (!c.get('identity')) return next()
          const enabled = await enabledForImpl(tenant.id)
          if (!enabled.has(m.manifest.id)) {
            // 形状与宿主 /api 未命中兜底一致（app.ts 的 app.notFound）
            return c.json({ error: 'NOT_FOUND' }, 404)
          }
          await next()
        }
        app.use(base + '/*', gate)

        // 存储投影（M3c，正典「租户级配置注入」）：**只对声明了 storage 的模块**挂。
        //   · 位置是硬约束：必须在启用闸门之后（停用模块该拿 404 就先拿 404，不必先花代价解配置）、
        //     在 app.route **之前**（Hono 里 handler 先注册、use 后注册 ⇒ 中间件**永不执行**——
        //     顺序错了的表现是模块 c.get(TENANT_STORAGE) 恒 undefined，代码里看不出问题）。
        //   · 它不是门卫：不做鉴权、不返回 403，只做投影。「宿主施加门禁」与「宿主注入材料」是两件事。
        //   · 无租户上下文 ⇒ 不 set（放行给后续层）。真实链路上租户中间件先于一切业务路由，
        //     这里见到无租户只可能是测试壳或未过租户中间件的装配。
        //   · 不声明就不挂 ⇒ 模块拿到的恒 undefined（与「未声明路径 = 不可达」同构）。
        if (m.manifest.storage) {
          const project: MiddlewareHandler<MountEnv> = async (c, next) => {
            const cfg = resolveTenantStorage(c.get('tenant') as TenantRow | undefined)
            // 不 set 时不「清理旧值」：Hono 的 context 是**每请求**新建的，不存在跨请求残留。
            if (cfg) c.set(TENANT_STORAGE, cfg)
            await next()
          }
          app.use(base + '/*', project)
        }

        app.route(base, m.router)

        // 已收口：静态挂同一 gate（售后 M1）——上面那道启用闸门曾只盖模块 API 子树（R4 复审
        // S-d 记的存量缺口，当时仓内无 userApp 模块、无可观测面故休眠）。现在 userApp 静态在
        // serveStatic 之前挂**同一闭包 gate** ⇒ 停用 = 静态与 API 同形 404，「停用 = 看不到这个
        // 模块」在两面都成立。匿名照旧放行（gate 内既有分支）：SPA 壳登录前必须可载，壳里没有
        // 业务数据，数据面自有门卫把守。
        const userApp = m.manifest.frontend?.userApp
        if (!userApp) continue
        const dist = path.resolve(m.dir, userApp.dist)
        if (!existsSync(dist)) continue // 目录不存在静默跳过（模块未构建前端）
        const mountPath = userApp.mount.replace(/\/+$/, '')
        // 售后 M1（module-protocol「停用语义」休眠缺口收口）：userApp 静态吃同一道启用闸门——
        // 匿名放行（SPA 壳登录前可载，业务 API 自会 401/404），已登录+停用 ⇒ 404 与 API 面同形。
        app.use(mountPath + '/*', gate)
        // serveStatic 以 root+完整请求路径拼文件名，须剥掉挂载前缀还原 dist 内相对路径
        app.use(
          mountPath + '/*',
          serveStatic({
            root: dist,
            rewriteRequestPath: (p) => p.slice(mountPath.length) || '/',
          }),
        )
        // userApp 的 **SPA 兜底**（M3b-2 I1）。必须在这里补，**不能**指望 app.ts 的全局
        // `app.get('*')`：那条兜的是 **web（console）的** index.html ⇒ 深链/刷新
        // `/app/aftersales/<route>` 会拿到 React 控制台壳（同一套 assets 前缀下尤其难查）。
        // 注册点在 §⑨（模块挂载），早于 app.ts §⑩ 的全局兜底 ⇒ Hono 按注册序天然优先。
        // 只挂 `get`：`serveStatic` 未命中的**非 GET** 仍该落 notFound（兜底不是「什么都接」）。
        const userAppIndex = serveStatic({ root: dist, path: 'index.html' })
        app.get(mountPath, userAppIndex)
        app.get(mountPath + '/*', userAppIndex)
      }
    },

    enabledFor: enabledForImpl,

    // 端口取用面（正典「模块端口」）。**不抛错**：缺席由调用方按通道语义处置（见接口注释）。
    // typeof 判定是防御模块把非函数塞进端口槽（类型上该槽位只有可选方法，运行时无保证）。
    port<K extends keyof ModulePorts>(moduleId: string, name: K): NonNullable<ModulePorts[K]> | undefined {
      const candidate = portsByModule.get(moduleId)?.[name]
      return typeof candidate === 'function' ? (candidate as NonNullable<ModulePorts[K]>) : undefined
    },

    /** 该租户已启用模块声明的访客码（manifest guest.scope，售后 spec §1.3：wechat-oa 签访客 session 用） */
    enabledGuestScopes: async (tenantId: number): Promise<string[]> => {
      const enabled = await enabledForImpl(tenantId)
      return loaded
        .filter((m) => enabled.has(m.manifest.id) && m.manifest.guest)
        .map((m) => m.manifest.guest!.scope)
    },
  }
}
