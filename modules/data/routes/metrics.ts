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
import { requesterOf, writeOutcome } from './context'
import { saveMetricDraft, loadMetricDraft, clearMetricDraft, metricBasisOf } from '../domain/metric-governance'
import { ColumnAggDraftSchema, MetricDraftSpecSchema } from '../domain/metric-governance'
import { certifyMetric, updateMetricMeta } from '../domain/metric-write'
import { confirmOverrideDeclaration, createOverrideDeclaration, createTenantDeclaration, deleteOverrideDeclaration } from '../domain/tenant-declaration-write'
import { metricUsageStats, retireCandidatesOf } from '../domain/metric-usage'
import { paramFaceOf, visibleMetrics } from '../domain/authz'
import type { MetricParamDef, Requester } from '../domain/authz'
import { loadMergedCatalog, listOverrideDeclarations } from '../domain/metric-store'
import { beijingTodayOf, freshnessFaceFor } from '../domain/query-service'
import type { MetricFreshnessFace } from '../domain/query-service'
import { warehouseConfigured, warehousePool } from '../domain/warehouse'
import { listMetricAudit } from '../domain/metric-audit-store'
import type { MetricRow } from '../domain/metric-store'
import { L2RefineDeclarationSchema, L2ExprDeclarationSchema, L2DeclarationSchema, exceedsNesting } from '../domain/semantic-compiler'
// 写/删的判定链在域层**只有一份**（HTTP 面与 MCP 写面共用）——本文件只做
// 「参数形状校验 + 域层结果 → HTTP」，不再内联任何闸门。
import { confirmPrivateMeasureDraft, deleteMetricDeclaration, writeL2Declaration } from '../domain/metric-write'
import type { MetricWriteDeps, MetricWriteOutcome, PrivateMeasureWriteDeps } from '../domain/metric-write'

/**
 * 写路径的 body = L2 声明的**外层信封**（id 是行的稳定句柄，不属于「声明」本身）。
 *
 * ★ `.strict()` 是「禁任意 SQL」的机检落点，不是风格：它让**任何**未列出的键
 *   （含 `selectSql` / `subjectColumn` / `groupBy` / `params` / `source`）直接 400。
 *   若用 zod 默认的 strip 行为，调用方传 `selectSql` 会**静默无效**——最坏的失败形态：
 *   他以为定义了自己的 SQL，而线上跑的是编译产物。
 *   B 中档起 body 是**两层 union**（refine 支 / expr 支），各自 `.extend()` 后再 union ——
 *   ZodUnion 本身没有 `.extend()`，而两支的宽容度不同，本来也必须分开校验。
 */
const L2RefineBody = L2RefineDeclarationSchema.extend({ id: z.string().min(1).max(64) }).strict()
const L2ExprBody = L2ExprDeclarationSchema.extend({ id: z.string().min(1).max(64) }).strict()
const L2Body = z.union([L2RefineBody, L2ExprBody])

type L2BodyType = z.infer<typeof L2Body>

/**
 * 词表投影：id/标题/说明 + **参数面形状**（type/required）——模型据此才知道能填什么键。
 * `column` 是 SQL 内部面，不出词表响应（与头注「selectSql/subjectColumn 不外泄」同口径）。
 * 投影本体在 `paramFaceOf`（authz.ts，纯函数）：spec 2026-10-15 §2.4「`list_metrics`
 * （agent 工具）与 HTTP 词表共用该投影」——两处各写一份必漂开，见该函数头注。
 * 入参按**结构**收窄，不写 `MetricRow`：`visibleMetrics` 的契约是 `MetricDef`
 * （授权核心不认来源）⇒ 写死 MetricRow 会让「裁剪后的词表」传不进来。
 */
const publicView = (
  m: { id: string; title: string; description: string; params?: Record<string, MetricParamDef>; certified?: 'certified' | 'draft'; source?: 'l1' | 'l2'; createdBy?: string | null; bizDescription?: string | null; unit?: string | null; caliberNote?: string | null; overrideOf?: string | null },
  freshness?: MetricFreshnessFace,
) => {
  const out: Record<string, unknown> = {
    id: m.id, title: m.title, description: m.description,
    params: paramFaceOf(m.params),
    // 可信度徽标（spec 2026-11-01 §10.4：L1 与 L2 并存，用户得知道信哪个）——观看面就带：
    // 「信不信这个数」是看数人的问题，不是管理员才有的问题。
    certified: m.certified,
    // 来源与创建者（spec §10.2 判定表）：移动卡片要显「来源=平台声明/自建」，
    // creator 判定（「我的」标记 + 编辑入口）要 createdBy。站内用户名不是敏感面。
    source: m.source, createdBy: m.createdBy ?? null,
    // 元数据三件套（030，spec §10.4.3）：#1284 时「观看面暂不带」的边界随移动卡消费面
    // （#1292）如实更新——看数人要靠业务描述/单位读懂口径；未标注 = null（不编默认值）。
    bizDescription: m.bizDescription ?? null, unit: m.unit ?? null, caliberNote: m.caliberNote ?? null,
    // 租户口径覆盖（W8，041）：true = 本数字用的是本租户覆盖的平台口径，不是平台默认值。
    // 观看面必须带——「这个数和别家不一样」是说清口径的前提，不是管理员才需要的信息。
    override: m.overrideOf != null,
  }
  // 新鲜度徽标（spec §10.4.2）：unknown = 没有可判的 sla/水位 ⇒ **字段缺席**（不捏造，
  // 与 runQuery 的 data_as_of 同一口径）；移动端卡片据此渲染 绿/黄/红/灰。
  if (freshness !== undefined && freshness.status !== 'unknown') {
    out.freshness = { status: freshness.status, watermark: freshness.watermark }
  }
  return out
}

/**
 * 管理面投影：带上 `source`——它是「这行能不能经 API 改」的**唯一**判据面，
 * 管理员必须一眼看出哪条是平台词表（只读）、哪条是本租户的（可改）。
 */
const adminView = (m: MetricRow) => ({
  id: m.id, title: m.title, description: m.description,
  requiredScope: m.requiredScope, subjectColumn: m.subjectColumn,
  selectSql: m.selectSql, groupBy: m.groupBy, params: m.params, source: m.source,
  // #489：列表两列的数据源（页面按 /metrics/all 一次拉齐，不为每行再打一次请求）
  updatedBy: m.updatedBy, version: m.version,
  // 治理（spec §10.4）：可信度（读侧已推导：L1 恒 certified）+ 创建者（creator 判定面）。
  // 「所有者」列（#1268 的 updatedBy）之外，管理员还要看「谁建的」与「审过没」。
  certified: m.certified, createdBy: m.createdBy,
  // 元数据（030，§10.4.3）：治理标注三件套（管理面可编辑/可见）。
  bizDescription: m.bizDescription, unit: m.unit, caliberNote: m.caliberNote,
  overrideOf: m.overrideOf,
  // 测度档（W8）：declared = 租户全额声明（编辑走「删除+重建」，不走 L2 结构化编辑器）
  basis: m.basis,
  // 归属面（047 列，P1 Task 8a）：部门桶（同名互斥的判据桶）/ 概念 / 差异说明。
  // 真值来自变更单写入（opts.ownership）；L1 行 ownerDept/variantNote 恒 null、entity 由物化带。
  // 只进管理面投影（console 口径展开层消费）：GET /metrics 的词表面（publicView）不扩——
  // 消费方（移动卡 / agent 词表）没有这个读面，「默认层零新增词」同样适用于 API 词表形状。
  ownerDept: m.ownerDept ?? null,
  entity: m.entity,
  variantNote: m.variantNote ?? null,
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

/** 私有测度路径的 deps（三闸 + D6 确认共用）：生产 warehouse 缺省，测试可注入。 */
function privateMeasureDeps(ctx: RouteCtx, requester: Requester): PrivateMeasureWriteDeps {
  return {
    pool: ctx.pool,
    requester,
    ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }),
  }
}

// 注：域层判别式结果 → HTTP 的唯一映射点已上收到 `routes/context.ts`（`writeOutcome`）——
// 已验证问答等其它路由也要用同一份「错误码 → HTTP」映射，留在本文件会逼后来者复制。
// 判定链本体（禁 target / 撞 L1 保留 id / 基底必须是 L1 / 源接入闸 / 编译 / 落库；
// 以及「先删自己的 L2 再判 L1」那条顺序）已搬到 `domain/metric-write.ts`——
// 那里同时服务 MCP 写面，两边必须是**同一份**判定，否则分叉的那条通常是漏判的那条。

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
    const visible = visibleMetrics(all, requester, adoptedSourcesOf(c))
    // 新鲜度面（spec §10.4.2）：水位查询走**仓库池**（load_log 在数据面，与 data_as_of 同通路，
    // 不走 ctx.pool）；按关系集分组（同组共享一次 load_log 查询）；整面 fail-open——
    // 仓库未配/查询失败都降级成 unknown（字段缺席），词表本身绝不因徽标面 500。
    let fresh = new Map<string, MetricFreshnessFace>()
    if (warehouseConfigured()) {
      try {
        fresh = await freshnessFaceFor(warehousePool(), visible, beijingTodayOf())
      } catch {
        fresh = new Map()
      }
    }
    // self：移动端「我的」判定与「管理员动作」的门（createdBy === self.userId；
    // scopes ∋ data:manage ⇒ 认证升降按钮）。同 requester 的既有投影，不引第二套身份面。
    return c.json({
      metrics: visible.map((m) => publicView(m, fresh.get(m.id))),
      self: { userId: requester.userId, scopes: requester.scopes },
    })
  })

  r.get('/metrics/all', async (c) => {
    const all = await loadMergedCatalog(ctx.pool, orgOf(c))
    return c.json({ metrics: all.map(adminView) })
  })

  /**
   * 某条口径的**变更史**（#489）——谁、何时、从什么到什么。
   * 门 = `data:manage`（与 `/metrics/all` 同档）：能看到「谁改的」本身是管理信息。
   * ⚠️ 这是**租户对自己单条口径的历史**，不是平台运营面的全局审计视图——
   *    后者仍不在本模块（见 domain/audit-store.ts 文件头那条分工）。
   */
  r.get('/metrics/:id/audit', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ audit: await listMetricAudit(ctx.pool, orgOf(c), id) })
  })

  r.post('/metrics', async (c) => {
    const requester = requesterOf(c)
    // 写入必须能归属到人（审计要记人）——无身份 ⇒ 拒，**不写一条「无主」审计**（#489）
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    // 结构预检必须**先于** L2Body.safeParse：ExprNodeSchema 是递归 schema，撞上超深输入会爆栈
    // 冒成 500（#593 实测 1600 层过、3200 层 RangeError）。预检是迭代的，自己不会爆。
    if (exceedsNesting(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    const parsed = L2Body.safeParse(body)
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, ...decl } = parsed.data
    return writeOutcome(c, await writeL2Declaration(writeDeps(ctx, c, requester), orgOf(c), id, decl), 201)
  })

  // 租户语义自治（W8，issue #1716）：新建全额声明。只收声明（YAML 条目等价物），不收 SQL；
  // 校验与 L1/apply 同一把尺，写库后即时生效（无需部署）。覆盖平台口径是 P2 的独立入口。
  r.post('/metrics/declarations', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    if (body === null || typeof body !== 'object' || !('declaration' in body)) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const out = await createTenantDeclaration(
      { pool: ctx.pool, ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }) },
      orgOf(c), requester, (body as { declaration: unknown }).declaration,
    )
    if (out.ok) return c.json({ ok: true, id: out.id }, 201)
    return writeOutcome(c, out, 201)
  })

  // 覆盖平台口径（W8 P2）：草稿→确认→生效（D6）。entry.name 必须等于被覆盖的 L1 id。
  // 覆盖清单（W8 管理面）：草稿不在合并词表里（L1 赢），必须单独可见才能「确认/取消」。
  r.get('/metrics/overrides', async (c) => {
    return c.json({ overrides: await listOverrideDeclarations(ctx.pool, orgOf(c)) })
  })

  r.post('/metrics/:id/override', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = await c.req.json().catch(() => null)
    if (body === null || typeof body !== 'object' || !('declaration' in body)) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const out = await createOverrideDeclaration(
      { pool: ctx.pool, ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }) },
      orgOf(c), requester, id, (body as { declaration: unknown }).declaration,
    )
    if (out.ok) return c.json({ ok: true, id: out.id, certified: 'draft' }, 201)
    return writeOutcome(c, out, 201)
  })

  r.post('/metrics/:id/override/confirm', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const out = await confirmOverrideDeclaration({ pool: ctx.pool }, orgOf(c), requester, id)
    if (out.ok) return c.json({ ok: true, id: out.id, certified: 'certified' })
    return writeOutcome(c, out, 200)
  })

  r.delete('/metrics/:id/override', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const out = await deleteOverrideDeclaration({ pool: ctx.pool }, orgOf(c), requester, id)
    if (out.ok) return c.json({ ok: true, id: out.id })
    return writeOutcome(c, out, 200)
  })

  r.put('/metrics/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = await c.req.json().catch(() => null)
    // 结构预检必须**先于** L2Body.safeParse：ExprNodeSchema 是递归 schema，撞上超深输入会爆栈
    // 冒成 500（#593 实测 1600 层过、3200 层 RangeError）。预检是迭代的，自己不会爆。
    if (exceedsNesting(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    const parsed = L2Body.safeParse(body)
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

  // ── 指标治理（spec 2026-11-01 §10.4 P0）：L2 草稿→确认→生效 ─────────────────
  // 只面向 L2 且 creator；L1 只读（管理按钮不出现）。授权判定在 metric-governance.ts。

  // 草稿保存：只写 draft_spec，不触发编译点（数字不变）。
  // 形状在**存的时候就校验**（L2DeclarationSchema + 深度预检）而不是留到确认时——
  // 「草稿已保存」必须意味着「这是一份完整的合法声明」，否则确认页才爆错等于骗了保存的人。
  // 确认时仍可能失败（ref 指向的 L1 被下线/源被摘），那类**状态**错误编译点会响亮地拒。
  r.put('/metrics/:id/draft', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = await c.req.json().catch(() => null)
    // 结构预检必须**先于**递归 schema：超深输入会在 zod 里爆栈冒成 500（#593，与 POST /metrics 同款）
    if (exceedsNesting(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    const parsed = z.object({ draftSpec: MetricDraftSpecSchema }).safeParse(body)
    if (!parsed.success) return c.json({ error: 'INVALID_DRAFT' }, 400)
    // basis 感知（W2）：column_agg 行只收列级聚合草稿；树形行拒收 column_agg 草稿。
    // 档位不符是 400（请求形状问题，不是权限问题）。
    const saved = await saveMetricDraft(ctx.pool, orgOf(c), id, requester.userId, parsed.data.draftSpec)
    if (saved.ok) return c.json({ ok: true })
    return saved.error === 'DRAFT_BASIS_MISMATCH'
      ? c.json({ error: 'DRAFT_BASIS_MISMATCH' }, 400)
      : c.json({ error: 'NOT_EDITABLE' }, 403)
  })

  // 草稿读取（预览确认页）
  r.get('/metrics/:id/draft', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const draft = await loadMetricDraft(ctx.pool, orgOf(c), id, requester.userId)
    return draft === null ? c.json({ error: 'NOT_FOUND' }, 404) : c.json({ draftSpec: draft })
  })

  // 确认生效（spec §10.4 D6）：草稿走**唯一编译点**（writeL2Declaration = POST/PUT 同一份实现：
  // 编译 + 事务 + 审计同生共死），编译过了才清草稿、再发变更通知。
  //
  // 为什么编译在清草稿**之前**：编译失败 ⇒ 409/400 原样返回，草稿**原地保留**（creator 改了再确认）；
  // 先清后编等于把编译失败变成「草稿白丢」。
  //
  // 为什么清草稿要带**内容条件**（评审 #1271-#7）：load → 编译 → clear 之间若 creator 在另一
  // 标签页存了 v2，无条件 clear 会把 v2 吞掉。带上「等于刚才读到的那份」做守卫——被并发写入
  // 抢过 ⇒ rowCount=0 ⇒ 409，v2 原样保留（可重试），不静默丢数据。
  r.post('/metrics/:id/confirm-draft', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const org = orgOf(c)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const draft = await loadMetricDraft(ctx.pool, org, id, requester.userId)
    if (draft === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // basis 分档（W2 Task 3 评审 Important）：私有测度的草稿是列级聚合声明，确认走
    // `confirmPrivateMeasureDraft`（三闸重校验 + 重编译 + 写生效列 + 审计）；树形路径原样。
    const basis = await metricBasisOf(ctx.pool, org, id)
    if (basis === null) return c.json({ error: 'NOT_FOUND' }, 404)
    let out: MetricWriteOutcome
    if (basis === 'column_agg') {
      const parsedDraft = ColumnAggDraftSchema.safeParse(draft)
      if (!parsedDraft.success) return c.json({ error: 'INVALID_DRAFT' }, 400)
      out = await confirmPrivateMeasureDraft(privateMeasureDeps(ctx, requester), org, id, parsedDraft.data)
    } else {
      // 显式重解析（不是断言式转型）：draft_spec 是 jsonb，读回来的形状不因为是「自己存的」就免检
      // ——027 之前的脏数据/手工改库都要在这里被拦住（400），而不是漏进编译点冒 500。
      const parsedDecl = L2DeclarationSchema.safeParse(draft)
      if (!parsedDecl.success) return c.json({ error: 'INVALID_DRAFT' }, 400)
      out = await writeL2Declaration(writeDeps(ctx, c, requester), org, id, parsedDecl.data, { keepDraft: true })
    }
    if (!out.ok) return writeOutcome(c, out, 200)
    const cleared = await clearMetricDraft(ctx.pool, org, id, requester.userId, draft)
    if (!cleared) return c.json({ error: 'DRAFT_CHANGED_RETRY' }, 409)
    // 变更通知（fail-open，模块协议 12：emit 的返回不参与业务分支；事件已在 manifest 声明）。
    // 收件人由 notify 层按绑定规则解析（scope_holders: data:query）——模块只报事实，不自己找收件人。
    if (ctx.notify) {
      try {
        const row = await ctx.pool.query(`select title, version from data.metrics where org = $1 and id = $2`, [org, id])
        await ctx.notify.emit(c.get('identity'), {
          eventKey: 'data.metric.definition.changed',
          eventId: `data.metric.definition.changed:${org}:${id}:${row.rows[0]?.version ?? 0}`,
          scope: id,
          payload: {
            metricId: id,
            title: String(row.rows[0]?.title ?? id),
            changedBy: requester.userId,
            link: `${process.env.PLATFORM_CONSOLE_BASE_URL ?? ''}/console/data`,
          },
        })
      } catch (e) {
        console.warn('[data] metric.definition.changed emit failed（不阻断业务）:', e instanceof Error ? e.message : e)
      }
    }
    return c.json({ ok: true })
  })

  // 可信度分级升降（spec §10.4 D7）：管理员把 L2 在 certified/draft 间切换。
  // 门 = data:manage（管理员动作，与草稿流的 data:query 不同档）；L1 只读由 certifyMetric 判（403）。
  r.put('/metrics/:id/certified', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = z.object({ certified: z.enum(['certified', 'draft']) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    return writeOutcome(c, await certifyMetric(writeDeps(ctx, c, requester), orgOf(c), id, parsed.data.certified), 200)
  })

  // 元数据写路径（spec 2026-11-01 §10.4.3 P1）：业务描述/单位/口径说明。
  // 申报 data:query（同 draft 的口径：写闸是 manage ∪ creator 的并集，单一宿主 scope 表达不了
  // 并集——取低档让双方都能进门，真判据 updateMetricMeta 在域层；持有 data:manage 的 PAT
  // 需同时持 data:query 才能走此端，与草稿端点的取舍一致）。
  r.put('/metrics/:id/meta', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = z.object({
      bizDescription: z.string().max(2000).nullable().optional(),
      unit: z.string().max(64).nullable().optional(),
      caliberNote: z.string().max(2000).nullable().optional(),
    }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    return writeOutcome(c, await updateMetricMeta(writeDeps(ctx, c, requester), orgOf(c), id, parsed.data), 200)
  })

  // 使用统计读面（spec 2026-11-01 §10.4.3 P1）：query_audit 按 metricId 聚合 + 下线候选。
  // 门 = data:manage（与 /metrics/audit 同档——「谁在用」是管理信息）。
  // days 缺省 30、钳 1..365（给个能交互的窗口上限，别让一次聚合扫全史）。
  r.get('/metrics/usage', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const daysRaw = c.req.query('days')
    let days = 30
    if (daysRaw !== undefined) {
      const n = Number(daysRaw)
      if (!Number.isInteger(n) || n < 1 || n > 365) return c.json({ error: 'INVALID_DAYS' }, 400)
      days = n
    }
    const [stats, retireCandidates] = await Promise.all([
      metricUsageStats(ctx.pool, orgOf(c), days),
      retireCandidatesOf(ctx.pool, orgOf(c), days),
    ])
    // self：候选卡的删除入口按 creator 门显示（与 DELETE 的后端 creator 闸对齐——
    // 给所有人放删除按钮 = 假 affordance；#1294）。与 GET /metrics 的 self 同形。
    return c.json({ days, stats, retireCandidates, self: { userId: requester.userId } })
  })
}
