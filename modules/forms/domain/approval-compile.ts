// domain/approval-compile.ts — 审批计划编译器（OA P1 Task 8 / issue #2363）。
//
// 输入 = 事项模板 payload + 发起人 + 审批模板 DSL；输出 = **计划快照**（引擎按它逐节点执行）。
// 编译是「把审批人从组织事实解析成人名」的唯一时刻：之后引擎不再查组织（B1 同款理由——引擎
// 拿不到平台组织表），所以在途单永远按提交时钉住的计划走，不受模板改版影响。
//
// 失败口径（全部 FormsError，routes 映射 HTTP）：
//   · APPROVERS_UNRESOLVED —— 部门类来源缺部门（发起人没有主部门且节点没显式指定）
//   · EMPTY_NODE —— 所有节点解析后都是空（P1 的 emptyNode=block_publish：没有人可批 = 不可发）
//   · QUORUM_EXCEEDS_APPROVERS —— quorum.n 大于实际解析出的人数（发布 dry-run 必须拦下）
//   · SELF_APPROVAL_FORBIDDEN —— selfApproval=forbid 且发起人出现在审批人里
//
// ⚠️ 计划**保留解析为空的节点**（approvers: []）：dry-run 的价值就是让人看见「这个节点没人」。
// 发布门（routes 的 publish）对任一空节点拒绝（block_publish）；静默丢掉一个审批节点
// 比发布失败危险得多。
import type { OrganizationPort } from '@platform/sdk'
import type { ApprovalBody, ApprovalCondition, ApprovalNode, ApproverSource, Quorum } from './approval'
import { FormsError } from './errors'

export interface PlanNode {
  key: string
  title: string
  approvers: string[]
  quorum: Quorum
  slaHours?: number
  onTimeout?: 'escalate' | 'notify'
  escalateTo: string[]
}

export interface ApprovalPlan {
  templateRef: { id: string; version: number }
  contractVersion: 1
  nodes: PlanNode[]
  appliedConditions: string[]
}

export interface CompileInput {
  org: string
  templateRef: { id: string; version: number }
  requester: string
  payload: Record<string, unknown>
  body: ApprovalBody
}

/** 点号路径取字段（`a.b`）；不做数组下标语法（DSL 的 field 是扁平业务字段名）。 */
function readField(payload: Record<string, unknown>, field: string): unknown {
  let cur: unknown = payload
  for (const seg of field.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

const OPS: Record<ApprovalCondition['when']['op'], (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => typeof a === 'number' && typeof b === 'number' && a > b,
  gte: (a, b) => typeof a === 'number' && typeof b === 'number' && a >= b,
  lt: (a, b) => typeof a === 'number' && typeof b === 'number' && a < b,
  lte: (a, b) => typeof a === 'number' && typeof b === 'number' && a <= b,
  // `in`: 声明侧 value 是候选集合，实际值在 payload
  in: (a, b) => Array.isArray(b) && b.includes(a),
}

export function evalCondition(when: ApprovalCondition['when'], payload: Record<string, unknown>): boolean {
  const fn = OPS[when.op]
  if (fn === undefined) return false
  return fn(readField(payload, when.field), when.value)
}

interface ResolveCtx {
  org: string
  requester: string
  payload: Record<string, unknown>
  primaryDept: string | null
  selfApproval: ApprovalBody['selfApproval']
}

/** 单个来源 → 人名列表。空列表是合法结果（「这个部门确实没有负责人」），**不是**错误；
 *  拿不到部门才是错误（APPROVERS_UNRESOLVED）——「查不了」与「没人」必须分开。 */
async function resolveSource(
  src: ApproverSource,
  nodeKey: string,
  ctx: ResolveCtx,
  orgPort: OrganizationPort,
): Promise<string[]> {
  const deptIds = (explicit?: string): string[] => {
    if (explicit !== undefined && explicit.length > 0) return [explicit]
    if (ctx.primaryDept !== null) return [ctx.primaryDept]
    throw new FormsError(
      'APPROVERS_UNRESOLVED',
      `${nodeKey}: 来源 ${src.source} 需要部门，但发起人没有主部门且节点未指定 deptExtId`,
    )
  }
  switch (src.source) {
    case 'user':
      return src.users.map((u) => u.trim()).filter((u) => u.length > 0)
    case 'role':
      return orgPort.listRoleMembers(ctx.org, src.role)
    case 'dept_members':
      return orgPort.listSubtreeMembers(ctx.org, deptIds(src.deptExtId))
    case 'dept_leader':
      return orgPort.listDeptLeaders(ctx.org, deptIds(src.deptExtId))
    case 'dept_admin':
      return orgPort.listDeptAdmins(ctx.org, deptIds(src.deptExtId))
    case 'field': {
      const v = readField(ctx.payload, src.field)
      if (typeof v === 'string') return v.trim().length > 0 ? [v.trim()] : []
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      return []
    }
  }
}

async function resolveNode(
  node: ApprovalNode,
  ctx: ResolveCtx,
  orgPort: OrganizationPort,
  seen: Set<string>,
): Promise<PlanNode> {
  const names: string[] = []
  for (const src of node.approvers) {
    const list = await resolveSource(src, node.key, ctx, orgPort)
    for (const name of list) {
      // 节点内永远去重（同一人从两个来源命中只算一次审批人）
      if (!names.includes(name)) names.push(name)
    }
  }
  let approvers = names
  if (ctx.selfApproval === 'forbid' && approvers.includes(ctx.requester)) {
    throw new FormsError('SELF_APPROVAL_FORBIDDEN', `${node.key}: 发起人不能是该节点审批人（selfApproval=forbid）`)
  }
  if (ctx.selfApproval === 'skip') {
    approvers = approvers.filter((n) => n !== ctx.requester)
  }
  let escalateTo: string[] = []
  for (const src of node.escalateTo ?? []) {
    escalateTo = escalateTo.concat(await resolveSource(src, node.key, ctx, orgPort))
  }
  const planNode: PlanNode = {
    key: node.key,
    title: node.title,
    approvers,
    quorum: node.quorum,
    escalateTo: [...new Set(escalateTo)],
  }
  if (node.slaHours !== undefined) planNode.slaHours = node.slaHours
  if (node.onTimeout === 'escalate' || node.onTimeout === 'notify') planNode.onTimeout = node.onTimeout
  return planNode
}

/**
 * 编译计划。
 *
 * 顺序语义（spec §8.2）：基础节点按声明序 → 条件命中的 addNode 按声明序**追加在末尾**
 * （`anchor` 字段 P1 未使用；spec 的「追加在 anchor 之后」在 P1.5 随锚点一起开）。
 * `dedupe = first_occurrence` 跨节点去重：同一个人只出现在**第一个**命中的节点。
 */
export async function compilePlan(input: CompileInput, orgPort: OrganizationPort): Promise<ApprovalPlan> {
  const primaryDept = await orgPort.primaryDeptOf(input.org, input.requester)
  const ctx: ResolveCtx = {
    org: input.org,
    requester: input.requester,
    payload: input.payload,
    primaryDept,
    selfApproval: input.body.selfApproval,
  }
  const seen = new Set<string>()
  const nodes: PlanNode[] = []
  for (const n of input.body.nodes) {
    const resolved = await resolveNode(n, ctx, orgPort, seen)
    if (input.body.dedupe === 'first_occurrence') {
      resolved.approvers = resolved.approvers.filter((p) => {
        if (seen.has(p)) return false
        seen.add(p)
        return true
      })
    }
    nodes.push(resolved)
  }
  const appliedConditions: string[] = []
  for (const c of input.body.conditions ?? []) {
    if (!evalCondition(c.when, input.payload)) continue
    const resolved = await resolveNode(c.addNode, ctx, orgPort, seen)
    if (input.body.dedupe === 'first_occurrence') {
      resolved.approvers = resolved.approvers.filter((p) => {
        if (seen.has(p)) return false
        seen.add(p)
        return true
      })
    }
    nodes.push(resolved)
    appliedConditions.push(c.addNode.key)
  }

  if (nodes.every((n) => n.approvers.length === 0)) {
    throw new FormsError('EMPTY_NODE', `所有节点解析后都没有审批人：${nodes.map((n) => n.key).join(', ')}`)
  }
  for (const n of nodes) {
    if (typeof n.quorum === 'object' && n.quorum.n > n.approvers.length) {
      throw new FormsError(
        'QUORUM_EXCEEDS_APPROVERS',
        `${n.key}: quorum.n=${n.quorum.n} 大于实际审批人数 ${n.approvers.length}`,
      )
    }
  }
  return {
    templateRef: input.templateRef,
    contractVersion: 1,
    nodes,
    appliedConditions,
  }
}
