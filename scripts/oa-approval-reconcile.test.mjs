// oa-approval-reconcile.test.mjs — 对账脚本的纯函数（OA P1 Task 11；跑在 `pnpm test:guard`）。
import { describe, expect, it } from 'vitest'
import { deriveFinalAction, engineForOrg, parseEngineMap } from './oa-approval-reconcile.mjs'

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
    FORMS_OA_ENGINE_MAP: JSON.stringify({ 'org-map': { baseUrl: 'http://map', patSecretRef: 'MAP_PAT' } }),
    MAP_PAT: 'map-secret',
    TABLE_PAT: 'table-secret',
  }
  const rowsByOrg = new Map([
    ['org-table', { org: 'org-table', base_url: 'http://table', pat_secret_ref: 'TABLE_PAT' }],
  ])

  it('表行优先（PAT 从 env 的 secret 引用取，不落值）', () => {
    expect(engineForOrg('org-table', rowsByOrg, env)).toEqual({
      baseUrl: 'http://table', pat: 'table-secret', source: 'platform.oa_engine',
    })
  })

  it('无表行回落 env map；两者都没有 ⇒ null（该 org 跳过，不猜引擎）', () => {
    expect(engineForOrg('org-map', rowsByOrg, env)).toEqual({
      baseUrl: 'http://map', pat: 'map-secret', source: 'FORMS_OA_ENGINE_MAP',
    })
    expect(engineForOrg('org-unknown', rowsByOrg, env)).toBeNull()
  })

  it('坏 JSON 不炸，按「无 map」处理', () => {
    expect(parseEngineMap('{oops')).toBeNull()
    expect(parseEngineMap('')).toBeNull()
    expect(engineForOrg('org-map', new Map(), { FORMS_OA_ENGINE_MAP: '{oops' })).toBeNull()
  })
})
