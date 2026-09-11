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
import { parse as parseYaml } from 'yaml'
import type { CasdoorClient } from '@platform/auth-core'
import {
  DECLARED_GATE_APPROVED,
  ManifestSchema,
  declaredScopeGate,
  type DeclaredEndpoint,
  type ModuleDefinition,
  type ModuleManifest,
} from '@platform/sdk'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { Pool } from 'pg'
import { runMigrations } from './migrate'
import type { TenantRow } from './tenant'

/** 装载完成的模块：manifest（协议）+ router（createRouter 产物） */
export interface LoadedModule {
  manifest: ModuleManifest
  router: Hono
}

/**
 * 装载结果。mount 前中间件链由宿主负责（租户解析 → 会话中间件 → 模块自加
 * requireScope），mount 只做挂载；enabledFor 按「无行=启用默认」求租户可见集。
 *
 * `enabledFor` 有**两个**消费方，且共用同一份实现（见 loadModules 的 enabledForImpl）：
 * routes/platform.ts 的 /config 清单闸门，以及 mount() 挂的 API 启用闸门（M1 闭债 R4）。
 * 两者必须同源——清单里看不到却仍能调通的模块，正是停用语义只落一半时的样子。
 */
export interface ModulesRuntime {
  modules: LoadedModule[]
  mount(app: Hono): void
  enabledFor(tenantId: number): Promise<Set<string>>
}

export interface LoadModulesDeps {
  pool: Pool
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

    loaded.push({
      manifest,
      router: applyDeclaredApiGate(def.createRouter({ pool: deps.pool }), manifest),
      dir,
    })
  }

  // ⑤ 权限码供给：全部模块的权限码一次性供给到每个租户各自的 org（见 provisionModulePermissions）。
  //    放在循环之后而非之内：租户清单只需查一次，且 manifest 全部校验通过后才产生副作用
  const allPermissions = loaded.flatMap((m) => m.manifest.permissions)
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
  const enabledForImpl = async (tenantId: number): Promise<Set<string>> => {
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
    mount(app: Hono): void {
      for (const m of loaded) {
        const base = moduleApiBasePath(m.manifest.id)

        // ⑥.5 启用闸门（M1 闭债 R4）：停用 = **该租户看不到这个模块** ⇒ 404，不是 403
        //      （404 与「这个模块不存在」同形 ⇒ 停用状态本身不可枚举；403 才泄露"存在但被停用"）。
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
        const gate: MiddlewareHandler = async (c, next) => {
          const tenant = c.get('tenant') as TenantRow | undefined
          // 无租户上下文（未过租户中间件）不在本闸门职责内，放行给后续层。真实链路上这道
          // 中间件先于一切业务路由，未命中 Host 早已 404/抛错 ⇒ 闸门见到的请求必带租户。
          if (!tenant) return next()
          // **无 identity（匿名）同样直接放行**（R4 评审 S5，协调者裁定）。两个理由：
          //   ① 闸门挂在模块**自身门卫**之前，匿名请求反正会被门卫挡下（401），到这里查库
          //      纯属白费——改动前匿名命中模块 API 是 **0 次 DB**，加了闸门变成每请求 1 次，
          //      而模块 API **没有独立限流** ⇒ 匿名流量可被用来放大 DB 压力。
          //   ② 不构成信息泄露，**反而更**不可枚举：匿名打**停用**模块与打**启用**模块，落点
          //      都是模块门卫的 401 UNAUTHENTICATED（两条响应逐字相同），停用与否无从区分；
          //      而已登录用户拿到的仍是 404，语义不变。loader.test.ts 里有这条的用例。
          if (!c.get('identity')) return next()
          const enabled = await enabledForImpl(tenant.id)
          if (!enabled.has(m.manifest.id)) {
            // 形状与宿主 /api 未命中兜底一致（app.ts 的 app.notFound）
            return c.json({ error: 'NOT_FOUND' }, 404)
          }
          await next()
        }
        app.use(base + '/*', gate)

        app.route(base, m.router)

        const userApp = m.manifest.frontend?.userApp
        if (!userApp) continue
        const dist = path.resolve(m.dir, userApp.dist)
        if (!existsSync(dist)) continue // 目录不存在静默跳过（模块未构建前端）
        const mountPath = userApp.mount.replace(/\/+$/, '') // 去尾斜杠，统一拼 /* 后缀
        // serveStatic 以 root+完整请求路径拼文件名，须剥掉挂载前缀还原 dist 内相对路径
        app.use(
          mountPath + '/*',
          serveStatic({
            root: dist,
            rewriteRequestPath: (p) => p.slice(mountPath.length) || '/',
          }),
        )
      }
    },

    enabledFor: enabledForImpl,
  }
}
