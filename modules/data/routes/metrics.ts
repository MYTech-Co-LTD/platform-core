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
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { requesterOf } from './context'
import { visibleMetrics } from '../domain/authz'
import {
  deleteMetric,
  loadMergedCatalog,
  loadPlatformCatalog,
  upsertMetric,
} from '../domain/metric-store'
import type { MetricRow } from '../domain/metric-store'
import {
  L2DeclarationSchema,
  SemanticCompileError,
  compileL2,
  resolveL1Base,
} from '../domain/semantic-compiler'
import type { L2Declaration } from '../domain/semantic-compiler'

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
 * 编译失败 → HTTP。分两类是**有意的**：
 *   · 调用方的问题（引用不存在的 base、维度越界、过滤子句错）⇒ 400，且回**具体 code**，
 *     让调用方能自助改（而不是猜「400 到底哪里不对」）。
 *   · 平台自己的问题（L1 行的 select_sql 不合形状契约）⇒ 500：那不是调用方能修的，
 *     而且它意味着 sync 物化出来的东西坏了——必须响亮（500 会被监控看见，400 不会）。
 */
function compileFailure(e: SemanticCompileError): { status: 400 | 500; error: string } {
  return e.code === 'BAD_BASE_SQL'
    ? { status: 500, error: 'L1_BASE_SQL_INVALID' }
    : { status: 400, error: e.code }
}

/** 该 id 是否是平台词表（L1）里的行（L1 行对所有租户可见，故「只读」对所有租户成立）。 */
async function isL1Id(ctx: RouteCtx, id: string): Promise<boolean> {
  return (await loadPlatformCatalog(ctx.pool)).some((m) => m.id === id)
}

/**
 * POST / PUT 的公共写路径 —— 两条路由对 L2 的处置必须逐字同形，
 * 否则「改」与「建」会分叉出两条安全语义（而分叉的其中一条通常是漏判的那条）。
 */
async function writeL2(
  c: Context<ModuleVars>,
  ctx: RouteCtx,
  status: 200 | 201,
  id: string,
  decl: Omit<L2BodyType, 'id'>,
) {
  // `target` 在 data.metrics 里**没有存储列**（003 只加了 source）。显式拒绝而不是静默丢弃：
  // 静默丢弃会让调用方以为目标值生效了。见 README「L2 的已知边界」与任务报告。
  if (decl.target !== undefined) return c.json({ error: 'TARGET_NOT_SUPPORTED' }, 400)

  // ★ L2 不能占 L1 的 id：占下之后**加载侧会丢 L2 行**（L1 赢）⇒ 这次写会**静默无效**
  //   （返回 200 而线上口径没变）。故在这里响亮拒绝，而不是让它变成一次「成功的空操作」。
  if (await isL1Id(ctx, id)) return c.json({ error: 'ID_RESERVED_BY_L1' }, 409)

  let base: MetricRow
  try {
    base = resolveL1Base(await loadPlatformCatalog(ctx.pool), decl.baseMetric)
  } catch (e) {
    if (e instanceof SemanticCompileError) {
      const f = compileFailure(e)
      return c.json({ error: f.error }, f.status)
    }
    throw e
  }

  let compiled: { selectSql: string; title: string; groupBy: string }
  try {
    compiled = compileL2(base, decl as L2Declaration)
  } catch (e) {
    if (e instanceof SemanticCompileError) {
      const f = compileFailure(e)
      return c.json({ error: f.error }, f.status)
    }
    throw e
  }

  await upsertMetric(ctx.pool, orgOf(c), {
    id,
    title: compiled.title,
    // 派生关系写进 description：管理面要能看出「这条 L2 是从哪个平台指标裁出来的」
    // （纯 L2 行没有 lineage 面，description 是当前唯一的可见去处）
    description: `L2 派生自 ${base.id}`,
    requiredScope: null,
    // 主体列**继承** L1：它是主体钉死的依据，租户改不了（改了就是跨租户读别人的数据）
    subjectColumn: base.subjectColumn,
    selectSql: compiled.selectSql,
    groupBy: compiled.groupBy,
    params: {},
  })
  return c.json({ ok: true }, status)
}

export function registerMetrics(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/metrics', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：词表对其「看不见」（约束 3）——空词表，不是报错
    if (requester === null) return c.json({ metrics: [] })
    // 消费面词表 = L1（平台）∪ L2（本 org）
    const all = await loadMergedCatalog(ctx.pool, orgOf(c))
    return c.json({ metrics: visibleMetrics(all, requester).map(publicView) })
  })

  r.get('/metrics/all', async (c) => {
    const all = await loadMergedCatalog(ctx.pool, orgOf(c))
    return c.json({ metrics: all.map(adminView) })
  })

  r.post('/metrics', async (c) => {
    const parsed = L2Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, ...decl } = parsed.data
    return writeL2(c, ctx, 201, id, decl)
  })

  r.put('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = L2Body.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 路径 id 与 body id 必须同值：否则「改 A 结果写了 B」是静默的数据事故。
    if (parsed.data.id !== id) return c.json({ error: 'ID_MISMATCH' }, 400)
    const { id: _bodyId, ...decl } = parsed.data
    return writeL2(c, ctx, 200, id, decl)
  })

  r.delete('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // L1 行只读，且是**显式** 409（不是含混的 404）：存储层的 deleteMetric 本来就带
    // `source='l2'`，所以 L1 id 会掉到 404——但 404 会让管理员以为「这行不存在」，
    // 真相是「它在，但只能改 dbt 声明再物化」。故先认出来再拒。
    if (await isL1Id(ctx, id)) return c.json({ error: 'READONLY_L1' }, 409)
    const gone = await deleteMetric(ctx.pool, orgOf(c), id)
    return gone ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND' }, 404)
  })
}
