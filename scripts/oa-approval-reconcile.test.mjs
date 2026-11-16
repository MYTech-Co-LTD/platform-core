// oa-approval-reconcile.test.mjs — 对账脚本的纯函数（OA P1 Task 11；跑在 `pnpm test:guard`）。
import { describe, expect, it } from 'vitest'
import { deriveFinalAction, engineForOrg } from './oa-approval-reconcile.mjs'

describe('deriveFinalAction', () => {
  it('非终态 → null（继续等，不写）', () => {
    expect(deriveFinalAction({ status: 'gate', nodeDecisions: [] })).toBeNull()
    expect(deriveFinalAction(null)).toBeNull()
  })

  it('任一 reject/veto ⇒ rejected（即使 case 已 closed——引擎的 reject 落 close 状态）', () => {
    expect(deriveFinalAction({ status: 'closed', nodeDecisions: [{ action: 'reject' }] })).toBe('rejected')
    expect(deriveFinalAction({ status: 'closed', nodeDecisions: [{ action: 'veto' }] })).toBe('rejected')
  })

  it('已终结且无驳回 ⇒ approved；撤回优先', () => {
    expect(deriveFinalAction({ status: 'approved', nodeDecisions: [{ action: 'approve' }] })).toBe('approved')
    expect(deriveFinalAction({ status: 'closed', nodeDecisions: [{ action: 'approve' }] })).toBe('approved')
    expect(deriveFinalAction({ status: 'withdrawn' })).toBe('withdrawn')
    expect(deriveFinalAction({ status: 'closed', events: [{ type: 'withdrawn' }] })).toBe('withdrawn')
  })
})

describe('engineForOrg', () => {
  const env = {
    FORMS_OA_ENGINE_URL: 'http://env',
    FORMS_OA_ENGINE_PAT: 'env-secret',
    TABLE_PAT: 'table-secret',
  }
  const rowsByOrg = new Map([
    ['org-table', { org: 'org-table', base_url: 'http://table', pat_secret_ref: 'TABLE_PAT' }],
  ])

  it('表行优先（唯一登记点；PAT 从 env 的 secret 引用取，不落值）', () => {
    expect(engineForOrg('org-table', rowsByOrg, env)).toEqual({
      baseUrl: 'http://table', pat: 'table-secret', source: 'platform.oa_engine',
    })
  })

  it('无表行 ⇒ 单租户 env 兜底；缺 PAT/URL 或都没有 ⇒ null（不猜引擎）', () => {
    expect(engineForOrg('org-other', rowsByOrg, env)).toEqual({
      baseUrl: 'http://env', pat: 'env-secret', source: 'env',
    })
    expect(engineForOrg('org-other', new Map(), { FORMS_OA_ENGINE_URL: 'http://env' })).toBeNull()
    expect(engineForOrg('org-other', new Map(), { FORMS_OA_ENGINE_PAT: 'p' })).toBeNull()
    expect(engineForOrg('org-other', new Map(), {})).toBeNull()
  })

  it('表行存在但 secret 缺失 ⇒ 返回 pat=undefined（调用方按「跳过该 org」处理，不回落 env）', () => {
    const out = engineForOrg('org-table', rowsByOrg, { FORMS_OA_ENGINE_URL: 'http://env', FORMS_OA_ENGINE_PAT: 'x' })
    expect(out).toEqual({ baseUrl: 'http://table', pat: undefined, source: 'platform.oa_engine' })
  })
})
