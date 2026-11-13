// registry.ts —— 分析师面**唯一工具事实源**（spec 2026-10-21 §3）。
//
// ★ 本文件是**纯**的：不得 import pool / env / Hono / 任何 workspace 包——
//   CI 门（scripts/check-mcp-toolface.mjs）与跨租户 e2e 要经 tsx 直接 import 本文件，
//   import 链上若混进运行时依赖，门禁就被迫另起一套「静态清单」= 第二事实源（必漂）。
//   impl 模块（guide/discovery/health/query）也不在这里 import——注册在 toolbox/all.ts
//   显式完成（避免「import registry 拉进 pg」的循环/传染）。
//   · 契约读取用 node:fs（contract.ts），不是 pg/env/Hono；CI 的 tsx import 链仍然只碰静态文件。
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
import type { DeptContext } from '../metric-visibility'
import type { SqlExecutor } from '../query-service'
import { writeAudit } from '../audit-store'
import { CONTRACT, faceOf } from '../../skill/contract'

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

/** 分析师面工具 = 契约里 analyst=true 且声明了 mcp 通道的条目。 */
export const ANALYST_TOOLS: readonly ToolMeta[] = CONTRACT.tools
  .filter((t) => t.analyst && t.channels.mcp !== undefined)
  .map((t) => {
    const face = faceOf(t, 'mcp')
    return {
      name: face.name,
      group: t.group,
      title: t.title,
      description: face.description,
      inputSchema: face.inputSchema,
      outputSchema: face.outputSchema ?? { type: 'object' },
      requiredScope: t.requiredScope,
      mutating: t.mutating,
      annotations: t.annotations,
    }
  })

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
  /** 参数化只读执行器（`explore_query` 专用；值走 $n，不拼 SQL 文本）。缺省 = 未配置仓库。 */
  exploreExec?: (sql: string, params: readonly unknown[]) => Promise<{ columns: string[]; rows: unknown[][] }>
  /** 写开关（缺省 false=关）。 */
  allowMutating?: boolean
  /** 血缘/质量 seam（缺省 = health.ts 的 defaultDbtManifest 读 env 路径；测试注入）。 */
  dbtManifest?: () => Promise<unknown>
  /** 时钟（测试注入）。 */
  now?: () => Date
}

/**
 * 回填审计行 id（Wave 1.3）：impl 组装回包时审计行还没写，`provenance.auditId` 只能由这个
 * 唯一写入点补上。只在**已有 provenance 对象**且**尚未带 id**时补——不新建 provenance
 * （没有来源面的工具不凭空多一个字段），也不覆盖 impl 自己写的 id（自带审计的通道）。
 */
function withAuditId(base: ToolImplResult, auditId: number): ToolImplResult {
  const p = base.payload.provenance
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return base
  if (Object.prototype.hasOwnProperty.call(p, 'auditId')) return base
  return { ...base, payload: { ...base.payload, provenance: { ...(p as Record<string, unknown>), auditId } } }
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
    // 单点审计（spec §8：拒绝/出错也写）。调用入参原样进 params（排障可重放这次调用）。
    const audit = await writeAudit(deps.pool, {
      org: deps.org,
      userId: deps.requester?.userId ?? '(anonymous)',
      channel: deps.requester?.channel ?? 'session',
      keyId: deps.requester?.keyId ?? null,
      sessionId: deps.requester?.sessionId ?? null,
      metricId: base.auditMetricId ?? '',
      params: args, rowCount: base.auditRowCount ?? null,
      verdict, reason: reason === '' ? null : reason,
      masking: null, tool: name,
    })
    return withAuditId(base, audit.id)
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
 * 裁剪只走 `visibleMetrics`（授权核心单实现，此处不自建判定）；部门上下文（P2 Task 4）
 * 由调用方（routes/mcp.ts 有 pool）先经 `deptContextIfOwned` 解析好再传入——本函数是纯的，
 * 不 import pool（文件头不变量）。
 * 撞名跳过（fail-closed）：与分析师面固定工具同名、或两指标 sanitize 后同名的，**后面的丢**——
 * 被跳过的指标仍可经 `query_metric` 查，但绝不冒名成另一个工具。
 */
export function legacyMetricTools<T extends SourceTaggedMetric>(
  catalog: readonly T[], requester: Requester, adoptedSources: ReadonlySet<string>,
  deptCtx?: DeptContext,
): { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[] {
  const fixedNames = new Set(ANALYST_TOOLS.map((t) => t.name))
  const taken = new Set<string>(fixedNames)
  const out: { tool: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations }; metricId: string }[] = []
  for (const m of visibleMetrics(catalog, requester, adoptedSources, deptCtx)) {
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
