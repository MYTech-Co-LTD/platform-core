// registry.ts —— 分析师面**唯一工具事实源**（spec 2026-10-21 §3）。
//
// ★ 本文件是**纯**的：不得 import pool / env / Hono / 任何 workspace 包——
//   CI 门（scripts/check-mcp-toolface.mjs）与跨租户 e2e 要经 tsx 直接 import 本文件，
//   import 链上若混进运行时依赖，门禁就被迫另起一套「静态清单」= 第二事实源（必漂）。
//   impl 模块（guide/discovery/health/query）也不在这里 import——注册在 toolbox/all.ts
//   显式完成（避免「import registry 拉进 pg」的循环/传染）。
//
// 不变量：
//   · 工具面预算：分析师面 ≤14 工具、静态序列化 ≤10KB（常量在此，门禁断言同一来源）。
//   · 命名：MCP 2025-11-25 `[A-Za-z0-9_.-]`；指标 id 的 `:` → `__`（双向映射在 legacyMetricTools）。
//   · 权限：工具级 requiredScope 是**声明面**（data_harness_catalog 的输出 + 门禁断言④）；
//     Wave 1 的执法点是 /mcp 端点门卫（data:query）——本文件**不做第二份 scope 判定**
//     （决策 D1：授权核心单实现）。
//   · 审计：callTool 是 tools/call 的唯一分发点，**所有结局**（ok/denied/error）都写
//     data.query_audit（spec §8「拒绝/出错也写」）。
import type { Pool } from 'pg'
import type { MetricParamDef, Requester, SourceTaggedMetric } from '../authz'
import { visibleMetrics } from '../authz'
import type { SqlExecutor } from '../query-service'
// 审计写侧：T1 先用本文件内的 writeCallAudit（列清单与 audit-store 对齐，含 tool 列；
// 本任务的两个 callTool 测试用假 pool，不会真打库，故列先于迁移存在没有运行时问题）。
// T5 给 writeAudit 加 tool 字段后，本文件**切换**到 writeAudit（单一写路径，见 Task 5 Step 3b）。

export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/
export const ANALYST_FACE_MAX_TOOLS = 14
export const ANALYST_FACE_MAX_LIST_BYTES = 10240
/** 抽样行上限（spec §5：sample_dimension_values 行数 ≤50；global constraints「抽样 ≤50 行」）。 */
export const SAMPLE_MAX_ROWS = 50
export const READ_SCOPE = 'data:read'
export const QUERY_SCOPE = 'data:query'

export interface ToolAnnotations { readOnlyHint: boolean }

export interface ToolMeta {
  name: string
  group: 'guide' | 'discovery' | 'query' | 'health'
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  /** 声明面（D1）：Wave 1 由端点门统一执法，此处不判定。 */
  requiredScope: string | null
  mutating: boolean
  annotations: ToolAnnotations
}

const readOnly = { readOnlyHint: true }
const obj = { type: 'object', properties: {}, required: [] }

/** 分析师面 11 个固定工具的静态清单（预算：11 ≤14；impl 分册，注册在 toolbox/all.ts）。 */
export const ANALYST_TOOLS: readonly ToolMeta[] = [
  {
    name: 'data_agent_guide', group: 'guide', title: '数据工作流指南',
    description: '返回数据问数工作流（七步）与硬约束（主体钉死/新鲜度脚注/截断语义），以及今天的日期。开始任何数据任务前先调它。',
    inputSchema: obj, outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'data_harness_catalog', group: 'guide', title: '工具清单',
    description: '列出本面全部工具（分组/scope/是否写）。与注册表逐条一致。',
    inputSchema: obj, outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'search_catalog', group: 'discovery', title: '搜索目录',
    description: '按关键词搜索可见指标（或数据集）。返回 id/标题/档位/归属/一句话说明，≤20 条。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（id/标题/说明的子串，大小写不敏感）' },
        kind: { type: 'string', enum: ['metric', 'dataset'], description: '缺省 = metric' },
        tier: { type: 'string', enum: ['certified', 'custom'], description: 'certified=平台口径(l1)，custom=本租户口径(l2)' },
      },
      required: [],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'describe_metric', group: 'discovery', title: '指标详情',
    description: '按 id 取指标详情：口径定义/粒度维度/参数/归属/档位/版本/新鲜度/上游。查数前必调（拿参数键名与维度）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '指标 id（取自 search_catalog 或 list）' } },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'describe_dataset', group: 'discovery', title: '数据集详情',
    description: '按 `schema.table` 取数据集的列/类型/归属/新鲜度。只见平台暴露的关系。',
    inputSchema: {
      type: 'object',
      properties: { dataset: { type: 'string', description: '关系名（如 marts.fct_retail_sale）' } },
      required: ['dataset'],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'sample_dimension_values', group: 'discovery', title: '维度值抽样',
    description: '取某指标某维度的取值与频次（≤50 行），用于确认过滤值的确切写法（如门店名）。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string' },
        dimension: { type: 'string', description: '维度名（须是该指标粒度维度之一）' },
        q: { type: 'string', description: '子串过滤（LIKE 包裹，转义通配）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '缺省 50' },
      },
      required: ['metricId', 'dimension'],
    },
    outputSchema: { type: 'object' },
    requiredScope: QUERY_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'preview_query', group: 'query', title: '预览查询计划',
    description: '按指标+切片参数生成将执行的 SQL 与行数上限——只编译不执行（0 次仓库查询）。核对口径/过滤用。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string' },
        args: { type: 'object', description: '指标声明参数（键名以 describe_metric 为准）' },
        slicing: { type: 'object', description: '{dimensions?,filters?,orderBy?,limit?,total?}' },
      },
      required: ['metricId'],
    },
    outputSchema: { type: 'object' },
    requiredScope: QUERY_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'query_metric', group: 'query', title: '受治理查询',
    description: '按指标 id 查数，回完整信任信封（口径版本/主体/数据截止/行集/审计 id）。主体由平台钉死；切片维度超出粒度即拒；行上限 1000。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string' },
        args: { type: 'object' },
        dimensions: { type: 'array', items: { type: 'string' }, description: '聚合维度（⊆ 指标粒度；缺省 = 粒度明细）' },
        filters: { type: 'object', description: '已声明参数或维度的等值/IN 过滤' },
        orderBy: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['column'] } },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        total: { type: 'boolean', description: '切片时显式 true 才回 total（部分合计≠全局合计）' },
      },
      required: ['metricId'],
    },
    outputSchema: { type: 'object' },
    requiredScope: QUERY_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_freshness', group: 'health', title: '新鲜度',
    description: '数据截止日/物化时刻/滞后秒。scope=指标 id 时回该指标链路水位与状态；缺省回全局水位。判据与发布面对齐表同源。',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: '指标 id（缺省 = 全局）' } },
      required: [],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_quality', group: 'health', title: '质量结论',
    description: 'dbt tests/对账的最近结论。无结论源时**显式返回 unknown**——未知 ≠ 通过。',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string', description: 'dbt 模型名（缺省 = 全部已声明）' } },
      required: [],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_lineage', group: 'health', title: '血缘',
    description: '有界上下游（depth≤3）。血缘源不可用时显式 unknown。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'dbt 模型名或数据集名' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: '缺省 1' },
      },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
    requiredScope: READ_SCOPE, mutating: false, annotations: readOnly,
  },
]

export function listAnalystTools(): readonly ToolMeta[] {
  return ANALYST_TOOLS
}

export function analystToolNames(): string[] {
  return ANALYST_TOOLS.map((t) => t.name)
}

/** 工具名清洗（spec §8：冒号 → __，其余非法字符 → _）。空串抛（没有「无名工具」）。 */
export function sanitizeToolName(id: string): string {
  const out = id.replaceAll(':', '__').replace(/[^\w.-]/g, '_')
  if (out === '' || !TOOL_NAME_RE.test(out)) throw new Error(`sanitizeToolName: '${id}' → '${out}' 不是合法工具名`)
  return out
}

/** 写开关（spec §8 `allow-mutating` 默认 false；与 DataY 默认相反）。恰为字面量 "true" 才开。 */
export function mutatingAllowed(env: Record<string, string | undefined>): boolean {
  return env.DATA_MCP_ALLOW_MUTATING === 'true'
}

// ── impl 注册表（all.ts 显式注册；本文件不 import impl 模块）────────────────────────────
const impls = new Map<string, ToolImpl>()

export interface ToolImplResult {
  /** MCP structuredContent 原体（信封或可解释错误体）。 */
  payload: Record<string, unknown>
  isError: boolean
  /** 审计的 metric_id（缺省 ''：非指标工具）。 */
  auditMetricId?: string
  /** 审计 row_count（缺省 null：没行数可记；0 与 null 语义不同，别 `?? 0`）。 */
  auditRowCount?: number | null
}
export type ToolImpl = (deps: ToolboxDeps, args: Record<string, unknown>) => Promise<ToolImplResult>

/** impl 注册：未知名（不在 ANALYST_TOOLS）或重复注册即抛（装载期暴露，不静默）。 */
export function registerImpl(name: string, impl: ToolImpl): void {
  if (!ANALYST_TOOLS.some((t) => t.name === name)) throw new Error(`registerImpl: 未知工具 '${name}'（须先在 ANALYST_TOOLS 声明）`)
  if (impls.has(name)) throw new Error(`registerImpl: '${name}' 重复注册`)
  impls.set(name, impl)
}

export interface ToolboxDeps {
  /** 平台库（词表/审计）。 */
  pool: Pool
  /** 隔离键（text）= 租户 Casdoor org——与 /query 同口径。 */
  org: string
  requester: Requester | null
  /** 宿主投影「本租户已接入源」。缺省语义由消费方 `?? []` 显式 fail-closed。 */
  adoptedSources: ReadonlySet<string>
  /** 仓库执行器（分析师面 = 只读池；测试注入假执行器）。 */
  wh: SqlExecutor
  /** 写开关（缺省 false=关）。 */
  allowMutating?: boolean
  /** 血缘/质量 seam（缺省 = health.ts 的 defaultDbtManifest 读 env 路径；测试注入）。 */
  dbtManifest?: () => Promise<unknown>
  /** 时钟（测试注入）。 */
  now?: () => Date
}

/**
 * tools/call 的**唯一**分发点。顺序（fail-closed 链）：
 *   未知工具 → 空身份 → mutating 闸 → 执行 → （impl 抛 = error）。
 * 每个结局都写审计（verdict=ok|denied|error，tool 恒写，metric_id 取 impl 或 ''）。
 */
export async function callTool(deps: ToolboxDeps, name: string, args: Record<string, unknown>): Promise<ToolImplResult> {
  const meta = ANALYST_TOOLS.find((t) => t.name === name)
  const finish = async (
    base: ToolImplResult, verdict: 'ok' | 'denied' | 'error', reason: string,
  ): Promise<ToolImplResult> => {
    await writeCallAudit(deps, args, {
      tool: name, metricId: base.auditMetricId ?? '', rowCount: base.auditRowCount ?? null,
      verdict, reason: reason === '' ? null : reason,
    })
    return base
  }
  if (!meta) {
    return finish({ payload: { status: 'denied', reason: 'unknown_tool', name }, isError: true }, 'denied', 'unknown_tool')
  }
  if (deps.requester === null) {
    return finish({ payload: { status: 'denied', reason: 'unauthenticated' }, isError: true }, 'denied', 'unauthenticated')
  }
  if (meta.mutating && deps.allowMutating !== true) {
    return finish(
      { payload: { status: 'denied', reason: 'mutating_disabled', name }, isError: true },
      'denied', 'mutating_disabled',
    )
  }
  const impl = impls.get(name)
  if (!impl) {
    return finish({ payload: { status: 'error', reason: 'impl_missing', name }, isError: true }, 'error', 'impl_missing')
  }
  try {
    const out = await impl(deps, args)
    return await finish(out, out.isError ? 'denied' : 'ok', out.isError ? String(out.payload.reason ?? 'tool_error') : '')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return await finish(
      { payload: { status: 'error', reason: 'tool_exception', detail }, isError: true },
      'error', detail.slice(0, 200),
    )
  }
}

/** 审计写侧（过渡形态：T5 给 writeAudit 加 tool 后切换过去——见 Task 5 Step 3b，参数语义不变）。 */
async function writeCallAudit(
  deps: ToolboxDeps,
  callArgs: Record<string, unknown>,
  e: { tool: string; metricId: string; rowCount: number | null; verdict: 'ok' | 'denied' | 'error'; reason: string | null },
): Promise<void> {
  await deps.pool.query(
    `insert into data.query_audit
       (org, user_id, channel, key_id, metric_id, params, row_count, verdict, reason, masking, tool)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10)`,
    [
      deps.org, deps.requester?.userId ?? '(anonymous)', deps.requester?.channel ?? 'session',
      deps.requester?.keyId ?? null, e.metricId, JSON.stringify(callArgs), e.rowCount,
      e.verdict, e.reason, e.tool,
    ],
  )
}

// ── legacy 读面（每指标一工具）的命名与投影 ────────────────────────────────────────────
/** 指标参数 → JSON-Schema 属性（type 不透传：date/date_range 不是合法 JSON-Schema type）。 */
function paramSchema(p: MetricParamDef): Record<string, unknown> {
  if (p.type === 'date') return { type: 'string', description: '' }
  if (p.type === 'date_range') {
    return {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      description: '闭区间 YYYY-MM-DD',
    }
  }
  return { type: p.type, description: '' }
}

/**
 * 可见指标 → legacy 工具（sanitized 名 + readOnly 注解）。
 * 裁剪只走 `visibleMetrics`（授权核心单实现，此处不自建判定）。
 * 撞名跳过（fail-closed）：与分析师面固定工具同名、或两指标 sanitize 后同名的，**后面的丢**——
 * 被跳过的指标仍可经 `query_metric` 查，但绝不冒名成另一个工具。
 */
export function legacyMetricTools<T extends SourceTaggedMetric>(
  catalog: readonly T[], requester: Requester, adoptedSources: ReadonlySet<string>,
): { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[] {
  const fixedNames = new Set(ANALYST_TOOLS.map((t) => t.name))
  const taken = new Set<string>(fixedNames)
  const out: { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[] = []
  for (const m of visibleMetrics(catalog, requester, adoptedSources)) {
    const name = sanitizeToolName(m.id)
    if (taken.has(name)) continue
    taken.add(name)
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [pname, p] of Object.entries(m.params)) {
      properties[pname] = paramSchema(p)
      if (p.required) required.push(pname)
    }
    out.push({
      tool: {
        name,
        description: m.description || m.title,
        inputSchema: { type: 'object', properties, required },
        annotations: readOnly,
      },
      metricId: m.id,
    })
  }
  return out
}
