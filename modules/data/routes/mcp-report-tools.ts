// mcp-report-tools.ts — 管理面端点的**报表片**（制作面）。设计：
// docs/superpowers/specs/2026-10-07-report-agent-toolface-design.md
//
// 「能提、不能发」三条**结构**落点（spec §3.3）：
//   ① 建报**不收 `requiredScope`**，平台强制写 FORCED_GATE ⇒ 造不出「已发布」；
//   ② `revise_report_spec` **先读页门**，已发布 ⇒ 拒 ⇒ 碰不到员工看得到的东西；
//   ③ 发布 / 回收**不是工具**（本片里没有它们）。
// 另加第 ④ 条（spec §3.3④，验证时挖出的洞）：`propose_report` 走**原子 create-only**
//   —— 否则同名的「提议」会改写既有报表（包括把已发布的静默撤下）。
//
// 门禁由宿主按 manifest 的 `scope: data:manage` 施加——本文件不写 requireScope（同口径片）。
import { z } from 'zod'
import { withObjectLock } from '../domain/object-lock'
import { loadMergedCatalog } from '../domain/metric-store'
import { parseReportSpec } from '../domain/report-spec'
import type { ReportSpec } from '../domain/report-spec'
import { deriveRequiredScope, validatePanelMetrics } from '../domain/report-scope'
import { getReport, getReportVersion, listReports, updateSpec, upsertReport } from '../domain/report-store'
import { getVersion } from '../domain/report-version'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

/**
 * 建出来的报表页门**恒**取它 = 「未发布」（只有持 `data:manage` 的人能在观看面看到）。
 * agent **改不了**它：工具入参里没有这个字段（spec §3.3①）。要发布，人在 console 把页门改掉或清空。
 */
const FORCED_GATE = 'data:manage'

const ProposeArgs = z.object({
  title: z.string().trim().min(1).max(200),
  spec: z.unknown(),                                  // 形状由 parseReportSpec 判（不在这里复制白名单）
}).strict()

const ReviseArgs = z.object({
  id: z.string().min(1),
  spec: z.unknown(),
  expectedVersion: z.number().int().positive(),
}).strict()

const GetSpecArgs = z.object({ id: z.string().min(1) }).strict()

const NAMES = ['list_reports', 'propose_report', 'revise_report_spec', 'get_report_spec'] as const
const ok = (o: Record<string, unknown>): McpToolResult =>
  ({ text: JSON.stringify({ status: 'ok', ...o }), isError: false })
const refused = (error: string, extra: Record<string, unknown> = {}): McpToolResult =>
  ({ text: JSON.stringify({ status: 'refused', error, ...extra }), isError: true })

/**
 * 提报 / 改报共用的**写入侧校验**（spec §4.2 补强）——与 HTTP 面是同一份判定
 * （domain/report-scope），本面只把结果翻译成工具级错误码：
 *
 *   · `deriveRequiredScope`：指标必须存在；面板不能要多个互不相同的 scope（单值页门表达不了）。
 *   · `validatePanelMetrics`：源未接入 ⇒ 拒（否则报表看着正常、点进去 403）；line/bar/kpi
 *     必须可加（不可加指标求和 = 假数）；ai_text 的结构闸（缺数据面板 / 缺 period）只有
 *     reason、没有 metricId——问题在整份规格，不在某个面板。
 *
 * 返回 `null` 表示通过。顺序即错误归因优先级：存在性 → 源裁剪 → 可加性。
 */
async function validateSpec(deps: McpDeps, spec: ReportSpec): Promise<McpToolResult | null> {
  const catalog = await loadMergedCatalog(deps.pool, deps.org)
  const scope = deriveRequiredScope(spec, catalog)
  if (!scope.ok) {
    return scope.reason === 'UNKNOWN_PANEL_METRIC'
      ? refused(scope.reason, { metricId: scope.metricId })
      : refused(scope.reason, { scopes: scope.scopes })
  }
  const metrics = validatePanelMetrics(spec, catalog, deps.adoptedSources)
  // ai_text 的结构闸没有 metricId 可点名（问题在整份规格）⇒ extra 留空。
  if (!metrics.ok) return refused(metrics.reason, 'metricId' in metrics ? { metricId: metrics.metricId } : {})
  return null
}

export const reportTools: McpToolGroup = {
  async list(deps: McpDeps) {
    if (deps.requester === null) return []
    return [
      { name: 'list_reports',
        description: '列出本租户已有报表（标题 / 渲染器 / 页门 / 版本 / 面板数 / 已发布版本 / 是否有未发布改动）。**提议新报表前先调它查重**。',
        inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_report_spec',
        description: '读一张报表的当前规格与版本（改报前先读，不要凭记忆重写整份 spec）。已发布的报表另带 publishedVersion / publishedAt。',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'propose_report',
        description: [
          '提议一张新的平台自绘报表。**只是提议**：建出来的一定是未发布状态（页门挂在管理档），',
          '要发布得由人在控制台改页门。**不能凭空发明指标**——metricId 必须是 list_metrics 里出现的 id；',
          '图型支持 line / bar / table / kpi / text / ai_text。ai_text = 观看时按当前期间服务端生成的',
          '分析文本（结论/异常/行动）：只声明 focus=overview，不写 content；必须与至少一个数据面板',
          '同报，且报表要带 period。**标题不能与已有报表重名**（重名会被拒，不会覆盖）。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '报表标题（不得与已有报表重名）' },
            spec: { type: 'object', description: '声明式规格：{ panels: [{ chart, title, metricId, dims, args, span }] }' },
          },
          required: ['title', 'spec'],
        } },
      { name: 'revise_report_spec',
        description: [
          '修改**尚未发布**的报表的规格（已发布的会被拒——那要人在控制台改）。带 expectedVersion（取自 list_reports）。',
          '可用图型与 propose_report 相同（含 ai_text：需与数据面板同报且报表带 period）。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '报表 id（取自 list_reports）' },
            spec: { type: 'object', description: '新的声明式规格' },
            expectedVersion: { type: 'number', description: '当前版本（取自 list_reports；陈旧会被拒）' },
          },
          required: ['id', 'spec', 'expectedVersion'],
        } },
    ]
  },

  async call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    if (!(NAMES as readonly string[]).includes(name)) return null      // 不是我的工具 ⇒ 交给下一片
    if (deps.requester === null) {
      return { text: JSON.stringify({ status: 'error', reason: 'unauthenticated' }), isError: true }
    }
    const org = deps.org

    if (name === 'list_reports') {
      const rows = await listReports(deps.pool, org)
      return ok({ reports: rows.map((r) => ({
        id: r.id, title: r.title, renderer: r.renderer, requiredScope: r.requiredScope,
        version: r.version, panels: r.spec?.panels.length ?? null,
        // 「已发布」看的是**发布指针**（`publishedVersion != null`），不是页门：发布时页门
        // 会被重算成快照口径（可能仍是 null），指针才是唯一状态来源。
        publishedVersion: r.publishedVersion,
        // 发布后草稿又登记过（`data.reports.version` 前进了）⇒ 线上不是最新的。
        // 未发布的行不算「有未发布改动」——它整张都还没上线。
        hasUnpublishedChanges: r.publishedVersion !== null && r.version > (r.publishedDraftVersion ?? 0),
      })) })
    }

    if (name === 'get_report_spec') {
      const parsed = GetSpecArgs.safeParse(args)
      if (!parsed.success) return refused('INVALID_BODY')
      const row = await getReport(deps.pool, org, parsed.data.id)
      if (row === null) return refused('NOT_FOUND')
      // 发布时间只在 `report_versions` 上（读路径 join 只带出版本号与草稿号），故按指针
      // 再取一次那一版；未发布不查库。指针悬空（无 FK 兜底）⇒ 时间缺席，但版本号仍如实返回。
      const published = row.publishedVersion === null
        ? null
        : await getVersion(deps.pool, org, row.id, row.publishedVersion)
      return ok({
        id: row.id, title: row.title, renderer: row.renderer,
        requiredScope: row.requiredScope, version: row.version, spec: row.spec,
        publishedVersion: row.publishedVersion,
        publishedAt: published?.publishedAt ?? null,
      })
    }

    if (name === 'propose_report') {
      const parsed = ProposeArgs.safeParse(args)
      if (!parsed.success) return refused('INVALID_BODY')
      const spec = parseReportSpec(parsed.data.spec)
      if (!spec.ok) return refused(spec.code)
      // 写入侧校验先于落库：词表里没有的指标 / 未接入源 / 不可加指标画线 ⇒ 拒，不建行。
      const invalid = await validateSpec(deps, spec.spec)
      if (invalid !== null) return invalid
      // ★ 原子 create-only：撞名 ⇒ 什么都不写、返回 null ⇒ 这里拒掉（§3.3④）
      const id = await upsertReport(deps.pool, org, {
        title: parsed.data.title, metabaseId: 0, embedParams: {},
        requiredScope: FORCED_GATE, renderer: 'platform', spec: spec.spec,
      }, 'create-only')
      if (id === null) return refused('TITLE_TAKEN')
      const row = await getReport(deps.pool, org, id)
      return ok({ id, version: row?.version ?? 1, requiredScope: FORCED_GATE })
    }

    // revise_report_spec（NAMES 判定后唯一剩下的工具）
    const parsed = ReviseArgs.safeParse(args)
    if (!parsed.success) return refused('INVALID_BODY')
    const spec = parseReportSpec(parsed.data.spec)
    if (!spec.ok) return refused(spec.code)
    const { id } = parsed.data
    // 与 HTTP 面**同 key** 的对象锁：本流程是「先读行分流 → 条件 UPDATE」，
    // 必须与 PUT /reports/:id、PUT /reports/:id/spec、DELETE 互斥（spec §3.4）。
    return await withObjectLock(`${org}/row:${id}`, async (): Promise<McpToolResult> => {
      const row = await getReport(deps.pool, org, id)
      if (row === null) return refused('NOT_FOUND')
      if (row.renderer !== 'platform') return refused('RENDERER_NOT_SELF_DRAWN')
      // ★ 结构落点②：已发布 ⇒ 拒。判据是**发布指针**非空（旧口径「页门清空」在定义版本
      // 上线后不再等价：发布的快照页门可能本就为 null，而未发布的草稿页门也可能被改成 null）。
      // 用指针而不是 join 出的 publishedVersion，指针悬空时也 fail-closed。
      if (row.publishedVersionId !== null) return refused('PUBLISHED_REPORT')
      // 与 propose 同一道写入侧闸。放在「已发布 ⇒ 拒」之后：不可改的行不该先收到
      // 「指标不存在」这种**改不了**的错——那会误导 agent 去修一个它无权修的东西。
      const invalid = await validateSpec(deps, spec.spec)
      if (invalid !== null) return invalid
      const updated = await updateSpec(deps.pool, org, id, spec.spec, parsed.data.expectedVersion)
      if (updated === null) {
        const cur = await getReportVersion(deps.pool, org, id)
        return cur === null ? refused('NOT_FOUND') : refused('STALE_WRITE', { currentVersion: cur })
      }
      return ok({ id, version: updated.version })
    })
  },
}
