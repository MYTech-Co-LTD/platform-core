// domain/engine-client.ts — case-engine HTTP 契约 client（OA P1 Task 10 / issue #2363）。
//
// 契约正典：`docs/superpowers/specs/2026-11-16-ai-native-oa-design.md` §10（公开面），
// 引擎实现见私有仓 case-engine（T6/T13）。平台只做三件事：建 case（带计划快照）、
// 查状态、代理决策/撤回；**授权在平台**（按计划快照的当前节点），引擎只校验形状与节点。
//
// 配置来源（P1 实现口径，与计划书的差异已记录在 PR）：
//   模块读不到 `platform.oa_engine`（B1：模块只许自身 schema），宿主也尚未把该映射注入
//   `ModuleContext`。P1 用**同形环境变量**解析：
//     FORMS_OA_ENGINE_MAP = {"<org>": {"baseUrl": "...", "patSecretRef": "ACME_OA_PAT"}}
//     FORMS_OA_ENGINE_URL  + FORMS_OA_ENGINE_PAT   （单租户/默认回落）
//   `patSecretRef` 只存**键名**，PAT 值从环境取（敏感值不落库、不进代码——与 P0 的
//   `platform.oa_engine.pat_secret_ref` 同语义）。为此 `resolveEngineFor` 做成可注入的
//   函数：routes/测试传自己的解析器，不受环境形态约束。
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

interface EngineEntry {
  baseUrl: string
  /** secret 引用键名（PAT 值从 env 取；不写值） */
  patSecretRef?: string
  /** 直接值（只给本地开发/单测；生产用 patSecretRef） */
  pat?: string
}

/** 环境变量 → 引擎条目的解析（纯函数，好测）。 */
export function engineEntryOf(org: string, env: NodeJS.ProcessEnv): EngineEntry | null {
  const rawMap = env.FORMS_OA_ENGINE_MAP
  let map: Record<string, EngineEntry> = {}
  if (rawMap !== undefined && rawMap.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawMap) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('FORMS_OA_ENGINE_MAP 必须是 { "<org>": { baseUrl, patSecretRef } } 对象')
      }
      map = parsed as Record<string, EngineEntry>
    } catch (e) {
      // 配错了要炸出声：静默当「OA 未开通」会把配置事故伪装成「这个租户没用 OA」
      throw new FormsError('OA_ENGINE_MISCONFIGURED', (e as Error).message)
    }
  }
  const hit = map[org]
  if (hit) return hit
  if (env.FORMS_OA_ENGINE_URL !== undefined && env.FORMS_OA_ENGINE_URL.trim().length > 0) {
    return { baseUrl: env.FORMS_OA_ENGINE_URL.trim(), pat: env.FORMS_OA_ENGINE_PAT }
  }
  return null
}

/** 引擎解析器：无条目 ⇒ null（= 该租户 OA 未开通，routes 回 409 OA_NOT_ENABLED）；
 *  有条目但 PAT 取不到 ⇒ 503 OA_ENGINE_MISCONFIGURED（**不是** 409——那是配置事故）。 */
export type EngineResolver = (org: string) => Promise<EngineClient | null>

export function makeEnvEngineResolver(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: typeof fetch,
): EngineResolver {
  return async (org) => {
    const entry = engineEntryOf(org, env)
    if (entry === null) return null
    if (typeof entry.baseUrl !== 'string' || entry.baseUrl.trim().length === 0) {
      throw new FormsError('OA_ENGINE_MISCONFIGURED', `租户 ${org} 的引擎配置缺 baseUrl`)
    }
    const pat = entry.pat ?? (entry.patSecretRef === undefined ? undefined : env[entry.patSecretRef])
    if (typeof pat !== 'string' || pat.length === 0) {
      throw new FormsError(
        'OA_ENGINE_MISCONFIGURED',
        `租户 ${org} 的引擎 PAT 取不到（secret 引用：${entry.patSecretRef ?? '未声明'}）`,
      )
    }
    return createEngineClient({ baseUrl: entry.baseUrl, pat, ...(fetchFn === undefined ? {} : { fetchFn }) })
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
