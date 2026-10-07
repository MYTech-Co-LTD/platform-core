// metrics.ts — 指标词表路由：GET /metrics（词表裁剪后的，给对话/管理界面选）、
// GET /metrics/all（管理面，全量）、POST/PUT/DELETE（管理面）。
// **门禁由宿主施加**（manifest 的 api.internal），本文件不写 requireScope；
// 词表裁剪只调 T2 的 visibleMetrics（授权核心单实现，路由层不自建权限判定）。
//
// ⚠️ 隔离键 org 一律取 `c.get('tenant').casdoor_org`（text）——**不是** `.id`（数字）：
// T3 存储层的 org 参数就是 Casdoor org 字符串，传数字既过不了 typecheck 也查不到行。
//
// ── T8：定义面从「自由 SQL」收成「结构化声明」────────────────────────────────────
// 本文件**曾经**直接收 `{ subjectColumn, selectSql, groupBy }`（自由 SQL 入参）。T8 之后：
//   · 入参只有 `L2Declaration`（结构化、可机检）⇒ SQL 由 domain/semantic-compiler.ts 生成；
//   · `selectSql` / `subjectColumn` / `groupBy` / `params` / `source` 出现在 body 里 ⇒ **400**
//     （见 `L2Body` 的 `.strict()`）——不是「忽略」，是「拒绝」：静默忽略会让调用方以为
//     自己写的那段 SQL 生效了，随后在线上查出别的口径。
//   · L1 行（org='platform'，由 scripts/sync-data-semantics.mjs 物化）对本文件**只读**：
//     改它只能改仓内 dbt YAML 再物化（口径变更走代码评审，不能经 API 就地改）。
import { z } from 'zod'
import type { Context } from 'hono'
import { TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { requesterOf } from './context'
import { visibleMetrics } from '../domain/authz'
import type { Requester } from '../domain/authz'
import { loadMergedCatalog } from '../domain/metric-store'
import type { MetricRow } from '../domain/metric-store'
import { L2DeclarationSchema } from '../domain/semantic-compiler'
// 写/删的判定链在域层**只有一份**（HTTP 面与 MCP 写面共用）——本文件只做
// 「参数形状校验 + 域层结果 → HTTP」，不再内联任何闸门。
import { deleteMetricDeclaration, writeL2Declaration } from '../domain/metric-write'
import type { MetricWriteDeps, MetricWriteOutcome } from '../domain/metric-write'

/**
 * 写路径的 body = L2 声明的**外层信封**（id 是行的稳定句柄，不属于「声明」本身）。
 *
 * ★ `.strict()` 是「禁任意 SQL」的机检落点，不是风格：它让**任何**未列出的键
 *   （含 `selectSql` / `subjectColumn` / `groupBy` / `params` / `source`）直接 400。
 *   若用 zod 默认的 strip 行为，调用方传 `selectSql` 会**静默无效**——最坏的失败形态：
 *   他以为定义了自己的 SQL，而线上跑的是编译产物。
 */
const L2Body = L2DeclarationSchema.extend({ id: z.string().min(1).max(64) }).strict()

type L2BodyType = z.infer<typeof L2Body>

/**
 * 只投影消费面要的字段：`selectSql` / `subjectColumn` 属实现细节，不外泄。
 * 参数按**结构**收窄（只要三字段），不写 `MetricRow`：`visibleMetrics` 的契约是
 * `MetricDef`（授权核心不认来源）⇒ 写死 MetricRow 会让「裁剪后的词表」传不进来。
 */
const publicView = (m: { id: string; title: string; description: string }) =>
  ({ id: m.id, title: m.title, description: m.description })

/**
 * 管理面投影：带上 `source`——它是「这行能不能经 API 改」的**唯一**判据面，
 * 管理员必须一眼看出哪条是平台词表（只读）、哪条是本租户的（可改）。
 */
const adminView = (m: MetricRow) => ({
  id: m.id, title: m.title, description: m.description,
  requiredScope: m.requiredScope, subjectColumn: m.subjectColumn,
  selectSql: m.selectSql, groupBy: m.groupBy, params: m.params, source: m.source,
})

/**
 * 指标 id 的**唯一**解析口径（PUT / DELETE 共用，两边必须同形）。
 *
 * ⚠️ 这里**不能**用 `parseIdParam`（T1 那个 `Number()` 解析器）：指标 id 是 `text`
 * （外部系统来的命名，如 `sales_daily`），数字解析器会把合法 id 判成非法 ⇒ 写操作**永远 404**。
 * `parseIdParam` 只服务 bigint 主键（T7 的 `query_keys.id` 用它，见那个任务的注记）。
 *
 * 形状校验的**真实承担者**是写入侧的 `L2Body`（`z.string().min(1).max(64)`）；
 * 这里只挡「空/缺失」，一律 404 —— 与 aftersales 的「非法 id 一律 404」一致，不给存在性探针。
 */
const metricIdOf = (raw: string | undefined): string | null =>
  raw === undefined || raw === '' ? null : raw

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

/**
 * 宿主投影的「本租户已接入源」（计划 5）→ 裁剪/写闸用的集合。
 *
 * `?? []` 的语义是**刻意的 fail-closed**：宿主没投影（本模块没声明 `tenantSources`、或请求
 * 不在租户上下文里）⇒ 空集 ⇒ **看不到任何 L1 行**（L2 行不受影响）。反过来（缺投影就不裁）
 * 是 fail-open，正是 spec §3⑧ 要堵的。两种「空」的区别见 `ModuleVars` 里那个键的注记。
 */
const adoptedSourcesOf = (c: Context<ModuleVars>): ReadonlySet<string> =>
  new Set(c.get(TENANT_SOURCES) ?? [])

/**
 * 域层 deps 的**唯一**组装点：org 与已接入源都从宿主投影读，写/删两条路径共用。
 * （org 取 `casdoor_org` 而不是数字 id —— 见文件头那条注记。）
 */
function writeDeps(ctx: RouteCtx, c: Context<ModuleVars>, requester: Requester): MetricWriteDeps {
  return { pool: ctx.pool, adoptedSources: adoptedSourcesOf(c), requester }
}

/**
 * 域层判别式结果 → HTTP（**唯一**映射点）。`okStatus` 区分建 201 / 改 200——
 * 那是路由层才知道的事（HTTP 语义不属于判定链）。
 *
 * 判定链本体（禁 target / 撞 L1 保留 id / 基底必须是 L1 / 源接入闸 / 编译 / 落库；
 * 以及「先删自己的 L2 再判 L1」那条顺序）已搬到 `domain/metric-write.ts`——
 * 那里同时服务 MCP 写面，两边必须是**同一份**判定，否则分叉的那条通常是漏判的那条。
 */
function writeOutcome(c: Context<ModuleVars>, r: MetricWriteOutcome, okStatus: 200 | 201) {
  return r.ok
    ? c.json({ ok: true }, okStatus)
    : c.json({ error: r.error, ...(r.extra ?? {}) }, r.http)
}

export function registerMetrics(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/metrics', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：词表对其「看不见」（约束 3）——空词表，不是报错。
    //
    // ⚠️ 这条分支**只有 `identity.orgId === ''`（宿主门卫放行之后）才够得着**。
    //    「无身份」根本不进本模块：**401 是宿主门卫给的**（`declaredScopeGate`，
    //    packages/platform-sdk/src/module.ts 里 `if (!identity) return 401 UNAUTHENTICATED`），
    //    本模块**没有**任何鉴权代码（manifest 的 api.internal 由宿主施加）。
    //    这不是模块自己判的，是门卫判的——spec §3⑧ 记的那条 fail-open（「无身份」与
    //    「没接入任何源」都回空列表 ⇒ agent 把"没认证"误读成"词表坏了"）正是靠这条 401 修的。
    //    断言在 metrics.test.ts（两条分开钉：门卫在 ⇒ 401；放行但 org 空 ⇒ 空列表）。
    if (requester === null) return c.json({ metrics: [] })
    // 消费面词表 = L1（平台）∪ L2（本 org），再按 **scope + 已接入源** 裁（计划 5 §3⑧）
    const all = await loadMergedCatalog(ctx.pool, orgOf(c))
    return c.json({ metrics: visibleMetrics(all, requester, adoptedSourcesOf(c)).map(publicView) })
  })

  r.get('/metrics/all', async (c) => {
    const all = await loadMergedCatalog(ctx.pool, orgOf(c))
    return c.json({ metrics: all.map(adminView) })
  })

  r.post('/metrics', async (c) => {
    const requester = requesterOf(c)
    // 写入必须能归属到人（审计要记人）——无身份 ⇒ 拒，**不写一条「无主」审计**（#489）
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const parsed = L2Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, ...decl } = parsed.data
    return writeOutcome(c, await writeL2Declaration(writeDeps(ctx, c, requester), orgOf(c), id, decl), 201)
  })

  r.put('/metrics/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = L2Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 路径 id 与 body id 必须同值：否则「改 A 结果写了 B」是静默的数据事故。
    if (parsed.data.id !== id) return c.json({ error: 'ID_MISMATCH' }, 400)
    const { id: _bodyId, ...decl } = parsed.data
    return writeOutcome(c, await writeL2Declaration(writeDeps(ctx, c, requester), orgOf(c), id, decl), 200)
  })

  r.delete('/metrics/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 判定链（含「先删本租户自己的 L2 行、再判 L1」那条顺序及其理由）在 domain/metric-write.ts。
    return writeOutcome(c, await deleteMetricDeclaration(writeDeps(ctx, c, requester), orgOf(c), id), 200)
  })
}
