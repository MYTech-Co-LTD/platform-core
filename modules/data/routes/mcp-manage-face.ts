// mcp-manage-face.ts —— /mcp-manage **合并工具面**的静态事实源（P1 Task 6，销缓办⑤）。
//
// 合并面 = 三片 list() 的并集（GROUPS = 口径片 mcp-metric-tools + 报表片 mcp-report-tools
// + 管线提案/需求片 mcp-pipeline-tools，见 mcp-manage.ts）＝ 20 件。P0 实证：门禁原来只测
// MANAGE_TOOLS（pipeline+demand=11）这份**代理**，合并面 10308 字节超预算它根本看不见——
// 所以把三片的静态工具元数据抽到这里，门禁 import 本文件**直接量合并面**（≤10KB）。
//
// ★ 本文件是**纯**的：只 import 类型（toolbox/registry）与 domain/manage-face
//   （其 import 链已证明纯——scripts/check-mcp-toolface.mjs 今天就在 import 它）。
//   不得 import pg / Hono / zod / 三个工具片（mcp-*-tools 拉的是 domain 运行时）。
//   依赖方向恒为「片 → face」：三片 list() 从这里取 wire（tools/list 的唯一定义出处），
//   门禁也从这里取同一份 wire 量预算——两处各写一份必漂（registry.ts 头注同款契约）。
//
// 形状：每件 = 治理元数据（slice/name/mutating/requiredScope/annotations，门禁判据④用）
//   + `wire`（tools/list 上该工具的完整对象，与各片 list() 输出**逐字节一致**）。
//   元数据里的 annotations 不进 wire（除非该片本来就在 wire 里带注解，如管线片）：
//   口径/报表片的 wire 形状保持不动（没有 annotations 字段——加注解是行为变更，且会
//   直接吃掉 ~300 字节预算，属独立决策）；门禁④看的是这里的元数据，不看 wire。
import type { ToolAnnotations } from '../domain/toolbox/registry'
import { MANAGE_TOOLS } from '../domain/manage-face'
import type { ManageToolMeta } from '../domain/manage-face'

/** 合并面工具数上限 = 现状 20（口径 5 + 报表 4 + 提案 9 + 需求 2）。加第 21 件 = 门禁红，同 PR 里显式抬。 */
export const MANAGE_FACE_COMBINED_MAX_TOOLS = 20

/** 合并面 tools/list 静态序列化预算（spec §8 ② 的 10KB，与分析师面同源不同常数——两面各自演进）。 */
export const MANAGE_FACE_MAX_LIST_BYTES = 10240

/** 管理面端点整体挂在 manifest 的 `scope: data:manage`（声明即授权）——逐工具复述同一值。 */
const MANAGE_SCOPE = 'data:manage'

const readOnly: ToolAnnotations = { readOnlyHint: true }
const writeable: ToolAnnotations = { readOnlyHint: false }

/** 哪一片（新增片 = slice 联合类型扩一项 + MANAGE_FACE_TOOLS 加一组 + parity 测试 slices 数组同改）。 */
export type ManageFaceSlice = 'metric' | 'report' | 'pipeline'

export interface ManageFaceTool {
  slice: ManageFaceSlice
  name: string
  /** 门禁④判据：写工具必须有注解与 requiredScope（write 总闸 DATA_MCP_ALLOW_MUTATING 在 call() 里执法）。 */
  mutating: boolean
  requiredScope: string | null
  annotations: ToolAnnotations
  /** tools/list 的 wire 形状（含 name；与该片 list() 输出逐字节一致——parity 测试钉死）。 */
  wire: Record<string, unknown>
}

/** 口径/报表片的 wire 形状 = {name, description, inputSchema}（键序即序列化序，别打乱）。 */
type MetricReportDef = { description: string; inputSchema: Record<string, unknown> }
const faceOf = (slice: ManageFaceSlice, name: string, mutating: boolean, def: MetricReportDef): ManageFaceTool =>
  ({ slice, name, mutating, requiredScope: MANAGE_SCOPE, annotations: mutating ? writeable : readOnly,
     wire: { name, description: def.description, inputSchema: def.inputSchema } })

// ─────────────────────────── 口径片（5 件，自 mcp-metric-tools.ts 原样搬入） ───────────────────────────

const METRIC_FACE: readonly ManageFaceTool[] = [
  faceOf('metric', 'list_metrics', false, {
    description: '列出可用作基底的平台口径（含可用维度），以及本租户已定义的口径。定义前先调它。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  }),
  faceOf('metric', 'customize_metric', true, {
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
  }),
  faceOf('metric', 'delete_custom_metric', true, {
    description: '删除本租户自定义的口径。**平台口径不可删**（会被拒）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '口径 id' } },
      required: ['id'],
    },
  }),
  faceOf('metric', 'submit_metric_change', true, {
    // 描述从紧：合并面 tools/list 有 10KB 静态预算，check-mcp-toolface 现在直接量这份 wire
    //（P1 Task 6 扩面，销缓办⑤）——加字超预算门禁直接红，不用再手跑合并面自测脚本。
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
  }),
  faceOf('metric', 'list_metric_changes', false, {
    description: '列出本租户指标变更单：默认 pending；status=rejected 读驳回原因。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'rejected'] } },
    },
  }),
]

// ─────────────────────────── 报表片（4 件，自 mcp-report-tools.ts 原样搬入） ───────────────────────────

const REPORT_FACE: readonly ManageFaceTool[] = [
  faceOf('report', 'list_reports', false, {
    description: '列出本租户已有报表（标题 / 渲染器 / 页门 / 版本 / 面板数 / 已发布版本 / 是否有未发布改动）。**提议新报表前先调它查重**。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  }),
  faceOf('report', 'get_report_spec', false, {
    description: '读一张报表的当前规格与版本（改报前先读，不要凭记忆重写整份 spec）。已发布的报表另带 publishedVersion / publishedAt。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }),
  faceOf('report', 'propose_report', false, {
    description: [
      '提议一张新的平台自绘报表。**只是提议**：建出来的一定是未发布状态（页门挂在管理档），',
      '要发布得由人在控制台改页门。**不能凭空发明指标**——metricId 必须是 list_metrics 里出现的 id；',
      '图型支持 line / bar / table / kpi / text / ai_text。ai_text = 观看时按当前期间服务端生成的',
      '分析文本：focus=overview（结论/异常/行动）、focus=root_cause（在事实包之外跑确定性',
      '下钻/配方探针，输出「根因」段）；不写 content；必须与至少一个数据面板同报，且报表要带',
      'period。**标题不能与已有报表重名**（重名会被拒，不会覆盖）。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '报表标题（不得与已有报表重名）' },
        spec: { type: 'object', description: '声明式规格：{ panels: [{ chart, title, metricId, dims, args, span }] }' },
      },
      required: ['title', 'spec'],
    },
  }),
  faceOf('report', 'revise_report_spec', false, {
    description: [
      '修改**尚未发布**的报表的规格（已发布的会被拒——那要人在控制台改）。带 expectedVersion（取自 list_reports）。',
      '可用图型与 propose_report 相同（含 ai_text：focus=overview/root_cause/daily_review，需与数据面板同报且报表带 period）。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '报表 id（取自 list_reports）' },
        spec: { type: 'object', description: '新的声明式规格' },
        expectedVersion: { type: 'number', description: '当前版本（取自 list_reports；陈旧会被拒）' },
      },
      required: ['id', 'spec', 'expectedVersion'],
    },
  }),
]

// ─────────────── 管线提案/需求片（11 件，投影自 domain/manage-face.ts 的 MANAGE_TOOLS） ───────────────

/** 管线片的 wire 形状（自 mcp-pipeline-tools.ts 的 entryOf 原样搬入）：比口径/报表片多 title/outputSchema/annotations。 */
const wireOfManage = (t: ManageToolMeta): Record<string, unknown> => ({
  name: t.name, title: t.title, description: t.description,
  inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations,
})

const PIPELINE_FACE: readonly ManageFaceTool[] = MANAGE_TOOLS.map((t) => ({
  slice: 'pipeline' as const,
  name: t.name, mutating: t.mutating, requiredScope: t.requiredScope, annotations: t.annotations,
  wire: wireOfManage(t),
}))

/** 合并面全集（顺序 = GROUPS：口径 → 报表 → 管线提案/需求）。唯一事实源：三片 list() 与门禁都从这里取。 */
export const MANAGE_FACE_TOOLS: readonly ManageFaceTool[] = [...METRIC_FACE, ...REPORT_FACE, ...PIPELINE_FACE]

/** 取一片的工具元数据（三片 list() 与 call() 的认领清单都从这里派生，别再手写第二份名单）。 */
export function manageFaceOfSlice(slice: ManageFaceSlice): readonly ManageFaceTool[] {
  return MANAGE_FACE_TOOLS.filter((t) => t.slice === slice)
}
