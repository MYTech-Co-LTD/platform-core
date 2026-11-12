// mcp-metric-tools.ts — 管理面 MCP 端点的**口径片**（本租户口径的定义）。
//
// 门禁由宿主按 manifest 的 `scope: data:manage` 施加——**本文件不写 requireScope**。
// 与读面分成两个端点（而不是把写工具塞进 /mcp）的理由：写工具所需的能力必须出现在清单里，
// 否则「声明即授权」这条单一事实源就被削弱了。设计见
// docs/superpowers/specs/2026-10-07-mcp-write-face-design.md。
//
// 判定不自建：写/删一律经 domain/metric-write（与 HTTP 面**同一份**判定），
// 本文件只做「入参形状校验 + 域层结果 → MCP 工具级错误」。
//
// ⚠️ 本文件内容是从 mcp-manage.ts **原样搬**过来的（2026-10-07 分片，为报表片腾位）：
//    注释与判定一行未改；唯一差别是 `call` 的认领判定——不认领返回 `null` 交给合成方
//   （「unknown_tool」兜底随之上移到合成方，见 mcp-manage.ts）。
import { z } from 'zod'
import { visibleMetrics } from '../domain/authz'
import { loadMergedCatalog } from '../domain/metric-store'
import { L2RefineDeclarationSchema, L2ExprDeclarationSchema, ExprNodeSchema, dimensionNamesOf } from '../domain/semantic-compiler'
import { deleteMetricDeclaration, writeL2Declaration } from '../domain/metric-write'
import type { L2DeclarationBody, MetricWriteOutcome } from '../domain/metric-write'
import { listChanges, submitChange } from '../domain/metric-change'
import type { ChangeKind } from '../domain/metric-change'
import { applyPreview, runPreview } from '../domain/metric-change-preview'
import { analystPool, runWarehouseSqlParams } from '../domain/warehouse'
import { mutatingAllowed } from '../domain/toolbox/registry'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

/**
 * 工具入参 = L2 声明的**去掉 op**（`target` 也不收）：
 *   · `op` **不**出现在工具面：判别键由面**按入参归一**（给了 `expr` 就是 expr 支，否则 refine 支）
 *     ——让 agent 去写它只会多一个「可能写错、而错法是 zod 先拦成 400」的噪音；
 *   · `target` 本就不受支持（域层会拒），干脆不出现在工具面。
 * `.strict()` 与 HTTP 面的 L2Body 同规：多写 sql 类字段一律拒，**不是**静默忽略。
 */
const CustomizeRefineArgs = L2RefineDeclarationSchema
  .omit({ op: true, target: true })
  .extend({ id: z.string().min(1).max(64) })
  .strict()
const CustomizeExprArgs = L2ExprDeclarationSchema
  .omit({ op: true })
  // 域层把表达式树收在 `op.expr` 里，而工具面对 agent 只暴露顶层的 `expr`（省掉那一层，
  // 判别键由面归一）⇒ 这里把 `expr` **加**回工具面，处理时再收进 `op`（见 call 里的归一）。
  .extend({ id: z.string().min(1).max(64), expr: ExprNodeSchema })
  .strict()
const CustomizeArgs = z.union([CustomizeRefineArgs, CustomizeExprArgs])

const DeleteArgs = z.object({ id: z.string().min(1).max(64) }).strict()

/**
 * 变更单提案入参（P0 Task 6）：形状闸在本文件（与 customize/delete 同规，INVALID_BODY）；
 * 「能不能立单」的语义闸在 domain/metric-change（与 HTTP 面同一份 submitChange）。
 * `payload` 形状按 kind 分派给域层 zod（refine/expr union / meta 三键 / delete 空对象），面级不复制。
 */
const SubmitArgs = z.object({
  metricId: z.string().min(1).max(128),
  kind: z.enum(['create', 'update', 'meta', 'delete']),
  payload: z.unknown().optional(),
}).strict()
/** list 的可选档：pending（默认，待人工裁决的队列）与 rejected（读驳回原因）。 */
const ListChangesArgs = z.object({
  status: z.enum(['pending', 'rejected']).optional(),
}).strict()

/**
 * 试算执行器（与 routes/metric-changes.ts 的 previewExecOf **同构**，注入缝不同——那边是
 * RouteCtx.execute，这边是壳组装的 `deps.wh`）：
 * · `deps.wh` 注入（测试缝）＝对象行假执行器，直接透传。`SqlExecutor` 的「数组行」形状是 query
 *   面的契约，预览面统一对象行——这里的 cast 是**显式表态**（两个注入面形状不同，不是疏忽）。
 * · 生产（deps.wh 缺省）＝ `analystPool` 只读池。⚠️ 用 `runWarehouseSqlParams` 而不是
 *   `runWarehouseSql`：后者**不收 params**（窗口过滤 `between $1 and $2` 参数送不进库），
 *   且回的是列优先的数组行——这里把它 zip 回对象行归一到 PreviewDeps 形状。
 */
type PreviewExec = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const previewExecOf = (deps: McpDeps): PreviewExec =>
  deps.wh !== undefined
    ? deps.wh as unknown as PreviewExec
    : async (sql, params) => {
        const r = await runWarehouseSqlParams(analystPool(), sql, params ?? [])
        return { rows: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))) }
      }

const ok = (o: Record<string, unknown>) => ({ text: JSON.stringify({ status: 'ok', ...o }), isError: false })

/** 域层判别式结果 → 工具级错误。`http` **不出现在工具面**（那是 HTTP 语义），只留可解释的 error 码。 */
const refused = (r: MetricWriteOutcome) => ({
  text: JSON.stringify({
    status: 'refused',
    error: r.ok ? 'UNKNOWN' : r.error,
    ...(r.ok ? {} : (r.extra ?? {})),
  }),
  isError: true,
})

/**
 * 只投影**口径本身**：不回 selectSql（上游 spec §4.4：给人/给 agent 看的是口径，不是 SQL）。
 *
 * `params`（name/type/required）与 `totalable` 是**动作面**信息，不是实现细节：
 *   · 缺参数面 ⇒ agent 只能靠试错撞「缺参数 / 参数类型错」；
 *   · 缺可加标记 ⇒ agent 无从知道哪些指标能画 line/bar、能进 kpi（写入侧会拒）。
 * 与 HTTP 词表的 `paramFaceOf` 同源事实，但形状是 MCP 友好的数组（spec 计划 Task 5）。
 */
const view = (m: Parameters<typeof dimensionNamesOf>[0] & { id: string; title: string; description: string }) =>
  ({
    id: m.id, title: m.title, description: m.description, dimensions: dimensionNamesOf(m),
    params: Object.entries(m.params).map(([name, p]) => ({ name, type: p.type, required: p.required === true })),
    totalable: m.totalable === true,
  })

export const metricTools: McpToolGroup = {
  async list(deps: McpDeps) {
    // M3 守卫同读面：空身份 ⇒ 空工具面。守卫必须在加载词表**之前**（否则空身份先炸在加载上）。
    if (deps.requester === null) return []
    const all = await loadMergedCatalog(deps.pool, deps.org)
    const bases = visibleMetrics(
      all.filter((m) => m.source === 'l1'), deps.requester, deps.adoptedSources)
    const custom = all.filter((m) => m.source === 'l2')
    return [
      {
        name: 'list_metrics',
        description: '列出可用作基底的平台口径（含可用维度），以及本租户已定义的口径。定义前先调它。',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'customize_metric',
        description: [
          '基于已有平台口径定义本租户口径：裁剪 / 改名 / 收窄可见维度 / 加过滤（refine），',
          '或用**受限算术**把多条口径组合成新测度（expr，例如两条口径相除得客单价）。',
          '**只能基于已有口径裁剪，不能凭空造新指标**：baseMetric 必须是 list_metrics 里出现的',
          '平台口径 id，expr 里的 ref 也只能指向它们；可用维度以基底为准（越界会被拒）。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '本租户口径的 id（≤64 字，不能与平台口径重名）' },
            baseMetric: { type: 'string', description: '基底平台口径 id（取自 list_metrics）' },
            expr: { type: 'object', description: '受限算术表达式树（与 baseMetric 二选一）；节点 kind ∈ ref/num/add/sub/mul/div' },
            alias: { type: 'string', description: '展示名' },
            visibility: { type: 'object', description: '可见维度（决定外层聚合口径）' },
            filters: { type: 'array', description: '等值过滤' },
          },
          required: ['id'],
          anyOf: [{ required: ['baseMetric'] }, { required: ['expr'] }],
        },
      },
      {
        name: 'delete_custom_metric',
        description: '删除本租户自定义的口径。**平台口径不可删**（会被拒）。',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '口径 id' } },
          required: ['id'],
        },
      },
      {
        // 描述从紧：合并面 tools/list 有 10KB 静态预算（本片不在 check-mcp-toolface 的
        // 三份代理清单里，门禁测不到——加字前先用合并面自测脚本量，见 task-6 报告）。
        name: 'submit_metric_change',
        description: '提交指标变更单：**只提案不生效，等待人工采纳**；采纳/驳回仅人工，不提供工具。驳回原因在 list_metric_changes 里读。',
        inputSchema: {
          type: 'object',
          properties: {
            metricId: { type: 'string', description: '目标口径 id' },
            kind: { type: 'string', enum: ['create', 'update', 'meta', 'delete'] },
            payload: { type: 'object', description: 'create/update=口径声明；meta=业务键；delete 留空' },
          },
          required: ['metricId', 'kind'],
        },
      },
      {
        name: 'list_metric_changes',
        description: '列出本租户指标变更单：默认 pending；status=rejected 读驳回原因。',
        inputSchema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['pending', 'rejected'] } },
        },
      },
    ]
  },

  async call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    // 认领判定：不是口径片的工具 ⇒ 交回合成方（差别**只有**这一行与其返回类型）
    if (name !== 'customize_metric' && name !== 'delete_custom_metric' && name !== 'list_metrics'
      && name !== 'submit_metric_change' && name !== 'list_metric_changes') return null
    if (deps.requester === null) {
      return { text: JSON.stringify({ status: 'error', reason: 'unauthenticated' }), isError: true }
    }
    // 守卫已在上方拒掉空身份 ⇒ 这里 requester 必非空（写路径的 deps 要求非空，见 metric-write）
    const requester = deps.requester
    const writeDeps = { pool: deps.pool, adoptedSources: deps.adoptedSources, requester }

    if (name === 'list_metrics') {
      const all = await loadMergedCatalog(deps.pool, deps.org)
      const bases = visibleMetrics(
        all.filter((m) => m.source === 'l1'), deps.requester, deps.adoptedSources)
      return ok({ bases: bases.map(view), custom: all.filter((m) => m.source === 'l2').map(view) })
    }

    if (name === 'submit_metric_change') {
      // 写总闸与管线提案片同规（DATA_MCP_ALLOW_MUTATING 恰为 'true' 才开）：
      // 拒的形态也同款（denied/mutating_disabled，工具级错误）。
      if (!mutatingAllowed(process.env as Record<string, string | undefined>)) {
        return { text: JSON.stringify({ status: 'denied', reason: 'mutating_disabled' }), isError: true }
      }
      const parsed = SubmitArgs.safeParse(args)
      if (!parsed.success) return refused({ ok: false, http: 400, error: 'INVALID_BODY' })
      // submitted_channel 用 'mcp'（不是 'pat'）：区分「工具面提的单」与「HTTP 面提的单」，
      // 决策端点的 session-only 闸只看 requester.channel，不受此值影响。
      const out = await submitChange(deps.pool, deps.org,
        { userId: requester.userId, channel: 'mcp' },
        parsed.data.metricId, parsed.data.kind as ChangeKind, parsed.data.payload ?? {})
      if (!out.ok) return { text: JSON.stringify({ status: 'refused', error: out.error }), isError: true }
      // 提交即试算（与 HTTP 面 POST /metric-changes 同契，P0 终审 F1）：试算成功 ⇒ preview_ready
      //（控制台的采纳按钮只认这个态，见 console/changes）；失败 ⇒ preview_failed——单据仍可见、
      // 可驳，不是死单。生效依旧只发生在人采纳（adoptChange）之后，本工具不接 adopt/reject。
      // 试算任何环节出意外都不 error 工具调用：单已立，人能在控制台重跑试算或驳回。
      let state = out.change.status
      try {
        const preview = await runPreview({ pool: deps.pool, execute: previewExecOf(deps) }, deps.org, out.change)
        await applyPreview(deps.pool, out.change.id, preview)
        state = preview.ok ? 'preview_ready' : 'preview_failed'
      } catch (e) {
        console.warn('[data] submit_metric_change 试算意外失败（单据保留提交态，仍可驳回）:',
          e instanceof Error ? e.message : e)
      }
      return ok({ changeId: out.change.id, state })
    }

    if (name === 'list_metric_changes') {
      const parsed = ListChangesArgs.safeParse(args)
      if (!parsed.success) return refused({ ok: false, http: 400, error: 'INVALID_BODY' })
      const changes = await listChanges(deps.pool, deps.org, parsed.data.status ?? 'pending')
      return ok({ changes: changes.map((c) => ({
        id: c.id, metricId: c.metricId, kind: c.kind, status: c.status, preview: c.preview,
        submittedBy: c.submittedBy, submittedAt: c.submittedAt, rejectReason: c.rejectReason,
      })) })
    }

    if (name === 'customize_metric') {
      const parsed = CustomizeArgs.safeParse(args)
      if (!parsed.success) return refused({ ok: false, http: 400, error: 'INVALID_BODY' })
      const { id, ...decl } = parsed.data
      // 工具面**不暴露 `op`**（判别键由面按入参归一，见 CustomizeArgs 的注释）：给了 `expr` 就是
      // expr 支、否则 refine 支。expr 支把顶层 `expr` 收回声明里的 `op` 那一层 —— 工具面为 agent
      // 省掉的正是这一层。面级只做形状校验；「能不能写」的语义闸在域层，与 HTTP 面同一份。
      let body: L2DeclarationBody
      if ('expr' in decl) {
        const { expr, ...rest } = decl
        body = { ...rest, op: { kind: 'expr', expr } }
      } else {
        body = { ...decl, op: { kind: 'refine' } }
      }
      const r = await writeL2Declaration(writeDeps, deps.org, id, body)
      return r.ok ? ok({ id }) : refused(r)
    }

    // delete_custom_metric（唯一剩下的认领工具；上面的判定已保证 name 合法）
    const parsed = DeleteArgs.safeParse(args)
    if (!parsed.success) return refused({ ok: false, http: 400, error: 'INVALID_BODY' })
    const r = await deleteMetricDeclaration(writeDeps, deps.org, parsed.data.id)
    return r.ok ? ok({ id: parsed.data.id }) : refused(r)
  },
}
