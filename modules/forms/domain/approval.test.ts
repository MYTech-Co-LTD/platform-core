// domain/approval.test.ts — 审批 DSL 校验器（OA P1 Task 7 / issue #2363）。
import { describe, expect, it } from 'vitest'
import { validateApprovalBody } from './approval'

const base = (extra: Record<string, unknown> = {}) => ({
  provider: 'inapp',
  nodes: [{ key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }] }],
  ...extra,
})

describe('validateApprovalBody', () => {
  it('合法 DSL 通过，默认值补齐', () => {
    const r = validateApprovalBody(base())
    expect(r.ok).toBe(true)
    if (r.ok && r.body.provider === 'inapp') {
      expect(r.body.rejectionPolicy).toBe('first_reject_ends')
      expect(r.body.selfApproval).toBe('skip')
      expect(r.body.dedupe).toBe('first_occurrence')
      expect(r.body.emptyNode).toBe('block_publish')
      expect(r.body.conditions).toEqual([])
      // quorum 缺省补 all（编译期不再处理 undefined）
      expect(r.body.nodes[0].quorum).toBe('all')
    }
  })

  it('非对象 / 未知 provider → 明确拒绝（不静默改写）', () => {
    expect(validateApprovalBody(null)).toMatchObject({ ok: false, code: 'BODY_NOT_OBJECT' })
    expect(validateApprovalBody([])).toMatchObject({ ok: false, code: 'BODY_NOT_OBJECT' })
    expect(validateApprovalBody({ provider: 'other', nodes: [] }))
      .toMatchObject({ ok: false, code: 'PROVIDER_INVALID' })
  })

  it('P2：provider=wecom_native 走绑定校验，**不跑 inapp 节点校验**', () => {
    // 绑定形状（没有 nodes）——若误走节点校验会被 NODES_EMPTY 拒掉
    const r = validateApprovalBody({
      provider: 'wecom_native',
      processCode: 'PC1',
      deepLink: 'https://open.work.weixin.qq.com/x',
      name: '差旅报销',
      verifiedChain: ['2026-11-16 真机验证'],
      verifiedAt: '2026-11-16T10:00:00Z',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body.provider).toBe('wecom_native')
      // 绑定 body 不补齐 inapp 默认值（nodes/conditions/etc 不存在）
      expect('nodes' in r.body).toBe(false)
    }
    // 绑定不完整：报绑定码，而不是节点错误
    expect(validateApprovalBody({ provider: 'wecom_native' }))
      .toMatchObject({ ok: false, code: 'BINDING_INCOMPLETE' })
  })

  it('空 nodes 拒绝', () => {
    expect(validateApprovalBody({ provider: 'inapp', nodes: [] }))
      .toMatchObject({ ok: false, code: 'NODES_EMPTY' })
  })

  it('node key 形状与重复', () => {
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'Leader', title: 'A', approvers: [{ source: 'user', users: ['u'] }] }],
    })).toMatchObject({ ok: false, code: 'NODE_KEY_INVALID' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [
        { key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }] },
        { key: 'a', title: 'B', approvers: [{ source: 'user', users: ['v'] }] },
      ],
    })).toMatchObject({ ok: false, code: 'NODE_KEY_DUP' })
  })

  it('quorum n 超过来源上限无法在编译期判，但 n<1 拒绝', () => {
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }], quorum: { n: 0 } }],
    })).toMatchObject({ ok: false, code: 'QUORUM_INVALID' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }], quorum: { n: 1.5 } }],
    })).toMatchObject({ ok: false, code: 'QUORUM_INVALID' })
  })

  it('未知 approver source 拒绝；来源必填字段缺失也拒绝', () => {
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'boss' }] }],
    })).toMatchObject({ ok: false, code: 'APPROVER_SOURCE_UNKNOWN' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: [] }] }],
    })).toMatchObject({ ok: false, code: 'APPROVER_USERS_EMPTY' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'role' }] }],
    })).toMatchObject({ ok: false, code: 'APPROVER_ROLE_REQUIRED' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'field' }] }],
    })).toMatchObject({ ok: false, code: 'APPROVER_FIELD_REQUIRED' })
  })

  it('escalateTo 的来源也校验（否则编译期会在 resolveSource 里炸成 500）', () => {
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{
        key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }],
        escalateTo: [{ source: 'boss' }],
      }],
    })).toMatchObject({ ok: false, code: 'APPROVER_SOURCE_UNKNOWN' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }], escalateTo: 'nope' }],
    })).toMatchObject({ ok: false, code: 'ESCALATE_TO_INVALID' })
  })

  it('rejectionPolicy：P1 只支持 first_reject_ends；all_must_decide 明确拒绝（引擎契约对齐）', () => {
    expect(validateApprovalBody(base({ rejectionPolicy: 'all_must_decide' })))
      .toMatchObject({ ok: false, code: 'REJECTION_POLICY_UNSUPPORTED' })
    expect(validateApprovalBody(base({ rejectionPolicy: 'first_reject_ends' })).ok).toBe(true)
    expect(validateApprovalBody(base({ rejectionPolicy: 'nope' })))
      .toMatchObject({ ok: false, code: 'REJECTION_POLICY_INVALID' })
  })

  it('P1 明确拒绝 block_runtime 与 auto_approve（不静默降级）', () => {
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }], onTimeout: 'auto_approve' }],
    })).toMatchObject({ ok: false, code: 'AUTO_APPROVE_UNSUPPORTED' })
    expect(validateApprovalBody({
      provider: 'inapp',
      nodes: [{ key: 'a', title: 'A', approvers: [{ source: 'user', users: ['u'] }] }],
      emptyNode: 'block_runtime',
    })).toMatchObject({ ok: false, code: 'EMPTY_NODE_MODE_UNSUPPORTED' })
  })

  it('条件节点与基础节点一起校验并查重', () => {
    const ok = validateApprovalBody(base({
      conditions: [{ when: { field: 'amount', op: 'gt', value: 5000 }, addNode: { key: 'cfo', title: 'CFO', approvers: [{ source: 'role', role: 'cfo' }] } }],
    }))
    expect(ok.ok).toBe(true)
    if (ok.ok && ok.body.provider === 'inapp') expect(ok.body.conditions?.[0].addNode.key).toBe('cfo')

    expect(validateApprovalBody(base({
      conditions: [{ when: { field: 'amount', op: 'gt', value: 5000 }, addNode: { key: 'leader', title: '重复', approvers: [{ source: 'user', users: ['u'] }] } }],
    }))).toMatchObject({ ok: false, code: 'NODE_KEY_DUP' })

    expect(validateApprovalBody(base({
      conditions: [{ when: { field: 'amount', op: 'between', value: 1 }, addNode: { key: 'x', title: 'X', approvers: [{ source: 'user', users: ['u'] }] } }],
    }))).toMatchObject({ ok: false, code: 'CONDITION_OP_INVALID' })
  })
})
