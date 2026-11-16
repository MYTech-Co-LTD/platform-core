// domain/approval.ts — 审批模板 DSL 校验器（纯函数，OA P1 Task 7 / issue #2363）。
//
// 职责边界：**只校验形状与取值域**，不解析人（那是编译期的事，见 approval-compile.ts）。
// 因此这里没有 org / orgPort 依赖，可以在任何一层跑（发布门、dry-run、编译前）。
//
// 纪律（P1）：
//   · `provider` 只接受 `inapp`：`wecom_native` 的 body 是绑定快照、不是节点链 DSL，
//     走另一条校验路径（P2），**不在这里静默接受**。
//   · 明确拒绝 `onTimeout: auto_approve` 与 `emptyNode: block_runtime`：P1 没有实现它们，
//     静默降级成「超时自动通过」「运行时阻塞」是治理事故，宁可发布失败。
//   · 失败返回机检 code + detail（routes 直接映射 HTTP），不抛错——纯函数好测也好复用。

export type ApproverSource =
  | { source: 'user'; users: string[] }
  | { source: 'role'; role: string }
  | { source: 'dept_members'; deptExtId?: string }
  | { source: 'dept_leader'; deptExtId?: string }
  | { source: 'dept_admin'; deptExtId?: string }
  | { source: 'field'; field: string }

export type Quorum = 'all' | 'any' | { n: number }

export interface ApprovalNode {
  key: string
  title: string
  approvers: ApproverSource[]
  quorum: Quorum
  slaHours?: number
  onTimeout?: 'escalate' | 'notify' | 'auto_approve'
  escalateTo?: ApproverSource[]
}

export interface ApprovalCondition {
  when: { field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; value: unknown }
  addNode: ApprovalNode
}

export interface ApprovalBody {
  provider: 'inapp'
  nodes: ApprovalNode[]
  conditions?: ApprovalCondition[]
  rejectionPolicy: 'first_reject_ends' | 'all_must_decide'
  selfApproval: 'skip' | 'allow' | 'forbid'
  dedupe: 'first_occurrence' | 'allow_repeat'
  emptyNode: 'block_publish' | 'block_runtime'
}

export type ValidateResult =
  | { ok: true; body: ApprovalBody }
  | { ok: false; code: string; detail: string }

const SOURCES = new Set(['user', 'role', 'dept_members', 'dept_leader', 'dept_admin', 'field'])
const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'])
export const NODE_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/

function fail(code: string, detail: string): { ok: false; code: string; detail: string } {
  return { ok: false, code, detail }
}

/** 单条来源的取值域校验（approvers 与 escalateTo 共用）。
 *  只校验「形状与必填字段」；**不解析人**（编译期才有组织事实）。 */
function checkSource(s: unknown): { code: string; detail: string } | null {
  const src = (s as Record<string, unknown> | null)?.source
  if (typeof src !== 'string' || !SOURCES.has(src)) {
    return { code: 'APPROVER_SOURCE_UNKNOWN', detail: `未知来源：${String(src)}` }
  }
  const a = s as Record<string, unknown>
  if (src === 'user' && (!Array.isArray(a.users) || a.users.length === 0)) {
    return { code: 'APPROVER_USERS_EMPTY', detail: 'user 来源必须有 users' }
  }
  if (src === 'role' && typeof a.role !== 'string') {
    return { code: 'APPROVER_ROLE_REQUIRED', detail: 'role 来源必须有 role' }
  }
  if (src === 'field' && typeof a.field !== 'string') {
    return { code: 'APPROVER_FIELD_REQUIRED', detail: 'field 来源必须有 field' }
  }
  return null
}

/** 单个节点校验（基础节点与条件节点共用；keys 跨两类一起查重）。 */
function validateNode(
  raw: unknown, keys: Set<string>,
): { ok: true; node: ApprovalNode } | { ok: false; code: string; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('NODE_INVALID', '节点必须是对象')
  const node = raw as Record<string, unknown>
  if (typeof node.key !== 'string' || !NODE_KEY_RE.test(node.key)) {
    return fail('NODE_KEY_INVALID', 'node.key 必须匹配 ^[a-z][a-z0-9_-]{0,63}$')
  }
  if (keys.has(node.key)) return fail('NODE_KEY_DUP', `节点 key 重复：${node.key}`)
  keys.add(node.key)
  if (typeof node.title !== 'string' || !node.title.trim()) return fail('NODE_TITLE_REQUIRED', '节点标题必填')
  if (!Array.isArray(node.approvers) || node.approvers.length === 0) {
    return fail('APPROVERS_EMPTY', 'approvers 不能为空')
  }
  for (const s of node.approvers) {
    const err = checkSource(s)
    if (err !== null) return fail(err.code, err.detail)
  }
  if (node.escalateTo !== undefined) {
    if (!Array.isArray(node.escalateTo)) return fail('ESCALATE_TO_INVALID', 'escalateTo 必须是来源数组')
    for (const s of node.escalateTo) {
      const err = checkSource(s)
      if (err !== null) return fail(err.code, `escalateTo: ${err.detail}`)
    }
  }
  const q = node.quorum
  if (q !== undefined && q !== 'all' && q !== 'any') {
    const n = (q as { n?: unknown } | null)?.n
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      return fail('QUORUM_INVALID', 'quorum.n 必须是 >=1 的整数')
    }
  }
  if (node.slaHours !== undefined && (typeof node.slaHours !== 'number' || node.slaHours <= 0)) {
    return fail('SLA_INVALID', 'slaHours 必须 >0')
  }
  if (node.onTimeout !== undefined && !['escalate', 'notify', 'auto_approve'].includes(node.onTimeout as string)) {
    return fail('ONTIMEOUT_INVALID', 'onTimeout 只能是 escalate / notify（P1）')
  }
  if (node.onTimeout === 'auto_approve') {
    return fail('AUTO_APPROVE_UNSUPPORTED', 'P1 不支持自动通过；请用 escalate/notify')
  }
  return {
    ok: true,
    node: {
      ...(node as unknown as ApprovalNode),
      // 缺省 = 全员通过（DSL 里最常见的语义；缺省不写是合法的，但不留 undefined 给编译期）
      quorum: (q ?? 'all') as Quorum,
    },
  }
}

export function validateApprovalBody(input: unknown): ValidateResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('BODY_NOT_OBJECT', '审批模板 body 必须是对象')
  }
  const b = input as Record<string, unknown>
  if (b.provider !== 'inapp') {
    return fail('PROVIDER_INVALID', 'provider 必须是 inapp（wecom_native 走绑定）')
  }
  const nodes = b.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return fail('NODES_EMPTY', '至少一个节点')
  if (b.emptyNode === 'block_runtime') {
    return fail('EMPTY_NODE_MODE_UNSUPPORTED', 'P1 只支持 block_publish；运行时阻塞在 P2 开')
  }
  if (b.rejectionPolicy === 'all_must_decide') {
    // 契约对齐（case-engine P1）：引擎的当前节点推导是「驳回即当前节点」语义，与
    // all_must_decide 冲突 ⇒ 引擎侧明确拒绝。平台在**发布门**就拦下，不把不支持的策略
    // 写进可发布的模板（静默接受 = 运行期卡死或语义漂移）。
    return fail('REJECTION_POLICY_UNSUPPORTED', 'P1 只支持 first_reject_ends；all_must_decide 由 P2 开')
  }
  if (b.rejectionPolicy !== undefined && b.rejectionPolicy !== 'first_reject_ends') {
    return fail('REJECTION_POLICY_INVALID', 'rejectionPolicy 只能是 first_reject_ends（P1）')
  }
  if (b.selfApproval !== undefined && !['skip', 'allow', 'forbid'].includes(b.selfApproval as string)) {
    return fail('SELF_APPROVAL_INVALID', 'selfApproval 只能是 skip / allow / forbid')
  }
  if (b.dedupe !== undefined && !['first_occurrence', 'allow_repeat'].includes(b.dedupe as string)) {
    return fail('DEDUPE_INVALID', 'dedupe 只能是 first_occurrence / allow_repeat')
  }

  const keys = new Set<string>()
  const parsedNodes: ApprovalNode[] = []
  for (const n of nodes) {
    const r = validateNode(n, keys)
    if (!r.ok) return r
    parsedNodes.push(r.node)
  }

  const rawConditions = b.conditions ?? []
  if (!Array.isArray(rawConditions)) return fail('CONDITIONS_INVALID', 'conditions 必须是数组')
  const conditions: ApprovalCondition[] = []
  for (const c of rawConditions) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return fail('CONDITION_INVALID', '条件必须是对象')
    }
    const cond = c as Record<string, unknown>
    const when = cond.when as Record<string, unknown> | undefined
    if (!when || typeof when !== 'object' || typeof when.field !== 'string' || !when.field.trim()) {
      return fail('CONDITION_INVALID', '条件的 when.field 必填')
    }
    if (typeof when.op !== 'string' || !OPS.has(when.op)) {
      return fail('CONDITION_OP_INVALID', `条件运算符未知：${String(when.op)}`)
    }
    if (!('value' in when)) return fail('CONDITION_INVALID', '条件的 when.value 必填')
    const nr = validateNode(cond.addNode, keys)
    if (!nr.ok) return nr
    conditions.push({ when: when as unknown as ApprovalCondition['when'], addNode: nr.node })
  }

  return {
    ok: true,
    body: {
      provider: 'inapp',
      nodes: parsedNodes,
      conditions,
      rejectionPolicy: (b.rejectionPolicy as ApprovalBody['rejectionPolicy']) ?? 'first_reject_ends',
      selfApproval: (b.selfApproval as ApprovalBody['selfApproval']) ?? 'skip',
      dedupe: (b.dedupe as ApprovalBody['dedupe']) ?? 'first_occurrence',
      emptyNode: 'block_publish',
    },
  }
}
