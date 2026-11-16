// domain/engine-client.ts — case-engine HTTP 契约 client（OA P1 Task 10 / issue #2363）。
//
// 契约正典：`docs/superpowers/specs/2026-11-16-ai-native-oa-design.md` §10（公开面），
// 引擎实现见私有仓 case-engine（T6/T13）。平台只做三件事：建 case（带计划快照）、
// 查状态、代理决策/撤回；**授权在平台**（按计划快照的当前节点），引擎只校验形状与节点。
//
// 配置来源（OA P1）：**`ctx.oaEngine`（宿主注入的 OaEnginePort）是唯一生产通路**——
// `platform.oa_engine` 是唯一登记点（spec §12.1 P11），模块读不到 platform schema（B1）。
// env 只保留**单租户**兜底（`FORMS_OA_ENGINE_URL` + `FORMS_OA_ENGINE_PAT`），用于本地测试/
// 脚本、或旧宿主未注入 port 的形态；**不提供 per-org map**（多租户映射只能来自登记表）。
//
// 优先级与 fail-closed（`makeOaEngineResolver`）：
//   · 注入了 port：只看它——port 返回 null（无行/停用/secret 缺失）就**不回落 env**
//     （否则「被停用的租户」会被环境变量偷偷放行）；
//   · 未注入 port（旧宿主/单测/脚本）：走 env 兜底。
import type { OaEnginePort } from '@platform/sdk'
import { FormsError } from './errors'

export interface EngineClient {
  createCase(body: Record<string, unknown>): Promise<{ caseId: string; runId?: string }>
  getCase(id: string): Promise<Record<string, unknown>>
  listCases(q: Record<string, string>): Promise<unknown>
  /** 决策代理（spec §10.3）：nodeKey 必须是引擎的当前节点；平台已做数据授权。 */
  decide(id: string, body: Record<string, unknown>): Promise<unknown>
  withdraw(id: string, body: Record<string, unknown>): Promise<unknown>
}

/** 引擎返回非 2xx：保留 status 供 routes 原样映射（409 = 已终结/已决策，不是平台故障）。 */
export class EngineHttpError extends FormsError {
  constructor(
    public readonly status: number,
    body: unknown,
  ) {
    super('ENGINE_HTTP_ERROR', `${status} ${JSON.stringify(body ?? null)}`)
  }
}

export function createEngineClient(cfg: {
  baseUrl: string
  pat: string
  fetchFn?: typeof fetch
}): EngineClient {
  const f = cfg.fetchFn ?? fetch
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response
    try {
      res = await f(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${cfg.pat}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      })
    } catch (e) {
      // 网络/DNS/超时：上游不可用（502 面），与「引擎明确拒绝」区分开
      throw new FormsError('ENGINE_UNAVAILABLE', (e as Error).message)
    }
    const body = (await res.json().catch(() => null)) as T
    if (!res.ok) throw new EngineHttpError(res.status, body)
    return body
  }
  return {
    createCase: (body) => call('/cases', { method: 'POST', body: JSON.stringify(body) }),
    getCase: (id) => call(`/cases/${encodeURIComponent(id)}`),
    listCases: (q) => call(`/cases?${new URLSearchParams(q)}`),
    decide: (id, body) => call(`/cases/${encodeURIComponent(id)}/decision`, {
      method: 'POST', body: JSON.stringify(body),
    }),
    withdraw: (id, body) => call(`/cases/${encodeURIComponent(id)}/withdraw`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  }
}

export interface EngineEntry {
  baseUrl: string
  pat: string
}

/** **单租户** env 兜底（本地测试/脚本）：URL 与 PAT 两键齐全才算配好，缺一 ⇒ null。 */
export function envEngineEntry(env: NodeJS.ProcessEnv): EngineEntry | null {
  const baseUrl = (env.FORMS_OA_ENGINE_URL ?? '').trim()
  const pat = env.FORMS_OA_ENGINE_PAT ?? ''
  if (baseUrl.length === 0 || pat.length === 0) return null
  return { baseUrl, pat }
}

/** 引擎解析器：null = 该租户 OA 未开通/不可用（routes 回 409 OA_NOT_ENABLED）。 */
export type EngineResolver = (org: string) => Promise<EngineClient | null>

export function makeEnvEngineResolver(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: typeof fetch,
): EngineResolver {
  return async () => {
    const entry = envEngineEntry(env)
    if (entry === null) return null
    return createEngineClient({ baseUrl: entry.baseUrl, pat: entry.pat, ...(fetchFn === undefined ? {} : { fetchFn }) })
  }
}

/**
 * 生产解析器：**注入的 port 优先**；未注入才用 env 兜底。
 *
 * port 返回 null 时**不回落 env**：登记表说「这个租户没开通/凭据不全」，环境变量无权推翻
 * （否则停用一个租户等于没停）。这是 spec「不做静默降级」在配置层的落点。
 */
export function makeOaEngineResolver(deps: {
  oaEngine?: OaEnginePort | null
  env?: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
}): EngineResolver {
  const envResolver = makeEnvEngineResolver(deps.env ?? process.env, deps.fetchFn)
  return async (org) => {
    if (deps.oaEngine === undefined || deps.oaEngine === null) return envResolver(org)
    const cfg = await deps.oaEngine.get(org)
    if (cfg === null) return null
    return createEngineClient({
      baseUrl: cfg.baseUrl,
      pat: cfg.pat,
      ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    })
  }
}

// ── 计划快照 → 当前节点（审批代理授权用） ──

export interface PlanSnapshot {
  nodes?: Array<{ key?: unknown; approvers?: unknown }>
}

/** 计划快照里某节点的审批人（数组；形状不对 ⇒ 空数组，不猜）。 */
export function approversOfNode(plan: unknown, nodeKey: string): string[] {
  const nodes = (plan as PlanSnapshot | null)?.nodes
  if (!Array.isArray(nodes)) return []
  const hit = nodes.find((n) => n?.key === nodeKey)
  if (!hit || !Array.isArray(hit.approvers)) return []
  return hit.approvers.filter((x): x is string => typeof x === 'string')
}

/** 引擎 case 详情的当前节点 key（T6/T13 契约：`currentNode`；兼容 {key} 形状）。 */
export function currentNodeOf(caseDetail: unknown): string | null {
  const raw = (caseDetail as { currentNode?: unknown; current_node?: unknown } | null)
  const v = raw?.currentNode ?? raw?.current_node
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const k = (v as { key?: unknown }).key
    if (typeof k === 'string') return k
  }
  return null
}

/** 只读：某提交是否在计划快照里出现过该审批人（mine 列表/详情授权的粗筛）。 */
export function planHasApprover(plan: unknown, user: string): boolean {
  const nodes = (plan as PlanSnapshot | null)?.nodes
  if (!Array.isArray(nodes)) return false
  return nodes.some((n) => Array.isArray(n?.approvers) && n.approvers.includes(user))
}

/** 计划快照里第一个包含该审批人的节点标题（"待我审批"列表的「当前节点」列）。
 *  引擎的真实当前节点由详情接口回答；列表页不做 N 次引擎调用。 */
export function firstNodeTitleFor(plan: unknown, user: string): string | null {
  const nodes = (plan as { nodes?: Array<{ approvers?: unknown; title?: unknown }> } | null)?.nodes
  if (!Array.isArray(nodes)) return null
  const hit = nodes.find((n) => Array.isArray(n?.approvers) && n.approvers.includes(user))
  return typeof hit?.title === 'string' ? hit.title : null
}

/** 仅供脚本/测试复用：直接拿解析好的配置建 client（模块代码走 makeEnvEngineResolver）。 */
export function clientForConfigured(
  cfg: { baseUrl: string; pat: string },
  fetchFn?: typeof fetch,
): EngineClient {
  return createEngineClient({ ...cfg, ...(fetchFn === undefined ? {} : { fetchFn }) })
}
