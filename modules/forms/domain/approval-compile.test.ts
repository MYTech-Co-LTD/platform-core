// domain/approval-compile.test.ts — 计划编译器（OA P1 Task 8 / issue #2363）。
import { describe, expect, it } from 'vitest'
import type { OrganizationPort } from '@platform/sdk'
import type { ApprovalBody } from './approval'
import { compilePlan, evalCondition } from './approval-compile'
import { FormsError } from './errors'

/** 组织事实夹具：dept-10 的负责人 u-lead、管理员 u-admin；u1 的主部门 = dept-10。 */
function makePort(over: Partial<OrganizationPort> = {}): OrganizationPort {
  return {
    async listSubtreeMembers() { return ['u1', 'u2'] },
    async listDeptLeaders() { return ['u-lead'] },
    async listDeptAdmins() { return ['u-admin'] },
    async listRoleMembers(_org, role) { return role === 'cfo' ? ['u-cfo'] : [] },
    async primaryDeptOf(_org, user) { return user === 'u1' ? 'dept-10' : null },
    ...over,
  }
}

const body = (over: Partial<ApprovalBody> = {}): ApprovalBody => ({
  provider: 'inapp',
  rejectionPolicy: 'first_reject_ends',
  selfApproval: 'skip',
  dedupe: 'first_occurrence',
  emptyNode: 'block_publish',
  nodes: [{ key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }], quorum: 'all' }],
  ...over,
})

const input = (over: Partial<Parameters<typeof compilePlan>[0]> = {}) => ({
  org: 'acme',
  templateRef: { id: 'leave', version: 1 },
  requester: 'u1',
  payload: {},
  body: body(),
  ...over,
})

describe('compilePlan', () => {
  it('dept_leader 解析成具体人；self 跳过；空节点保留在计划里（dry-run 要看得见）', async () => {
    const plan = await compilePlan(input({
      body: body({
        nodes: [
          { key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }], quorum: 'all' },
          { key: 'hr', title: 'HR', approvers: [{ source: 'user', users: ['u1'] }], quorum: 'all' },
        ],
      }),
    }), makePort())
    expect(plan.nodes[0].approvers).toEqual(['u-lead'])
    expect(plan.nodes[1].approvers).toEqual([]) // self 剔除后为空
    expect(plan.appliedConditions).toEqual([])
    expect(plan.contractVersion).toBe(1)
    expect(plan.templateRef).toEqual({ id: 'leave', version: 1 })
  })

  it('条件按金额加节点（命中 addNode 追加在末尾并记 appliedConditions）', async () => {
    const withAmountCondition = body({
      conditions: [{
        when: { field: 'amount', op: 'gt', value: 5000 },
        addNode: { key: 'cfo', title: '财务负责人', approvers: [{ source: 'role', role: 'cfo' }], quorum: 'all' },
      }],
    })
    const plan = await compilePlan(input({ payload: { amount: 6000 }, body: withAmountCondition }), makePort())
    expect(plan.nodes.map((n) => n.key)).toEqual(['leader', 'cfo'])
    expect(plan.nodes[1].approvers).toEqual(['u-cfo'])
    expect(plan.appliedConditions).toEqual(['cfo'])

    // 阈值未命中 ⇒ 不加节点
    const below = await compilePlan(input({ payload: { amount: 100 }, body: withAmountCondition }), makePort())
    expect(below.nodes.map((n) => n.key)).toEqual(['leader'])
    expect(below.appliedConditions).toEqual([])
  })

  it('dedupe=first_occurrence：同一人只保留在第一个命中的节点', async () => {
    const plan = await compilePlan(input({
      body: body({
        nodes: [
          { key: 'a', title: 'A', approvers: [{ source: 'role', role: 'cfo' }], quorum: 'all' },
          { key: 'b', title: 'B', approvers: [{ source: 'role', role: 'cfo' }, { source: 'dept_leader' }], quorum: 'all' },
        ],
      }),
    }), makePort())
    expect(plan.nodes[0].approvers).toEqual(['u-cfo'])
    expect(plan.nodes[1].approvers).toEqual(['u-lead'])
  })

  it('dedupe=allow_repeat：同一人可出现在多个节点', async () => {
    const plan = await compilePlan(input({
      body: body({
        dedupe: 'allow_repeat',
        nodes: [
          { key: 'a', title: 'A', approvers: [{ source: 'role', role: 'cfo' }], quorum: 'all' },
          { key: 'b', title: 'B', approvers: [{ source: 'role', role: 'cfo' }], quorum: 'all' },
        ],
      }),
    }), makePort())
    expect(plan.nodes.map((n) => n.approvers)).toEqual([['u-cfo'], ['u-cfo']])
  })

  it('field 来源读 payload（字符串或字符串数组）', async () => {
    const plan = await compilePlan(input({
      payload: { reviewer: 'u-x', backups: ['u-y', 'u-z'] },
      body: body({
        nodes: [
          { key: 'a', title: 'A', approvers: [{ source: 'field', field: 'reviewer' }], quorum: 'all' },
          { key: 'b', title: 'B', approvers: [{ source: 'field', field: 'backups' }], quorum: 'all' },
        ],
      }),
    }), makePort())
    expect(plan.nodes[0].approvers).toEqual(['u-x'])
    expect(plan.nodes[1].approvers).toEqual(['u-y', 'u-z'])
  })

  it('发起人没有主部门且节点未指定 deptExtId → APPROVERS_UNRESOLVED（查不了 ≠ 没人）', async () => {
    await expect(compilePlan(input({ requester: 'u-nodept' }), makePort()))
      .rejects.toMatchObject({ code: 'APPROVERS_UNRESOLVED' })
  })

  it('显式 deptExtId 不依赖发起人主部门', async () => {
    const calls: string[][] = []
    const port = makePort({
      async listDeptLeaders(_org, ids) { calls.push([...ids]); return ['u-lead'] },
    })
    const plan = await compilePlan(input({
      requester: 'u-nodept',
      body: body({ nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'dept_leader', deptExtId: 'dept-99' }], quorum: 'all' }] }),
    }), port)
    expect(calls).toEqual([['dept-99']])
    expect(plan.nodes[0].approvers).toEqual(['u-lead'])
  })

  it('quorum.n 大于实际人数 → QUORUM_EXCEEDS_APPROVERS', async () => {
    await expect(compilePlan(input({
      body: body({ nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u-a'] }], quorum: { n: 2 } }] }),
    }), makePort())).rejects.toMatchObject({ code: 'QUORUM_EXCEEDS_APPROVERS' })
  })

  it('所有节点都解析为空 → EMPTY_NODE', async () => {
    await expect(compilePlan(input({
      requester: 'u-a',
      body: body({ nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u-a'] }], quorum: 'all' }] }),
    }), makePort())).rejects.toMatchObject({ code: 'EMPTY_NODE' })
  })

  it('selfApproval=forbid 且发起人在审批人里 → SELF_APPROVAL_FORBIDDEN；allow 保留', async () => {
    const node = { key: 'a', title: 'A', approvers: [{ source: 'user' as const, users: ['u1'] }], quorum: 'all' as const }
    await expect(compilePlan(input({ body: body({ selfApproval: 'forbid', nodes: [node] }) }), makePort()))
      .rejects.toBeInstanceOf(FormsError)
    const allowed = await compilePlan(input({ body: body({ selfApproval: 'allow', nodes: [node] }) }), makePort())
    expect(allowed.nodes[0].approvers).toEqual(['u1'])
  })

  it('escalateTo 解析进计划（空则空数组）', async () => {
    const plan = await compilePlan(input({
      body: body({
        nodes: [{
          key: 'a', title: 'A', approvers: [{ source: 'dept_leader' }], quorum: 'all',
          slaHours: 24, onTimeout: 'escalate', escalateTo: [{ source: 'dept_admin' }],
        }],
      }),
    }), makePort())
    expect(plan.nodes[0]).toMatchObject({ slaHours: 24, onTimeout: 'escalate', escalateTo: ['u-admin'] })
  })
})

describe('evalCondition', () => {
  it('六种数值/集合比较', () => {
    const payload = { amount: 6000, level: 'p1', tags: ['a', 'b'] }
    expect(evalCondition({ field: 'amount', op: 'gt', value: 5000 }, payload)).toBe(true)
    expect(evalCondition({ field: 'amount', op: 'lte', value: 5000 }, payload)).toBe(false)
    expect(evalCondition({ field: 'level', op: 'eq', value: 'p1' }, payload)).toBe(true)
    expect(evalCondition({ field: 'level', op: 'neq', value: 'p1' }, payload)).toBe(false)
    expect(evalCondition({ field: 'level', op: 'in', value: ['p1', 'p2'] }, payload)).toBe(true)
    expect(evalCondition({ field: 'missing', op: 'eq', value: 1 }, payload)).toBe(false)
  })

  it('点号路径取嵌套字段', () => {
    expect(evalCondition({ field: 'a.b', op: 'eq', value: 1 }, { a: { b: 1 } })).toBe(true)
  })
})
