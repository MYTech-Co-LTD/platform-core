import { describe, expect, it } from 'vitest'
import { planAllTenantGrants, tenantProvisionSteps } from './provision-tenant.mjs'

describe('tenantProvisionSteps（纯核）', () => {
  it('默认 org 命名 + 无模块四步；带 --module 逐模块追加 plan/subscribe', () => {
    expect(tenantProvisionSteps('acme')).toEqual(['org:acme-org', 'tenant-row:acme', 'anchor', 'permissions'])
    expect(tenantProvisionSteps('acme', { org: 'o1', modules: ['demo', 'case-engine'] })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'permissions', 'plan:demo', 'subscribe:demo', 'plan:case-engine', 'subscribe:case-engine',
    ])
  })
})

describe('planAllTenantGrants（纯核，spec-1 §4 批量发放）', () => {
  it('每 org × 每 module 生成 plan/subscribe 两步，顺序稳定（幂等重跑的计划面）', () => {
    expect(planAllTenantGrants(['acme', 'beta'], ['demo'])).toEqual([
      'plan:acme:demo', 'subscribe:acme:demo', 'plan:beta:demo', 'subscribe:beta:demo',
    ])
    expect(planAllTenantGrants(['o1', 'o2'], ['demo', 'case-engine'])).toEqual([
      'plan:o1:demo', 'subscribe:o1:demo', 'plan:o1:case-engine', 'subscribe:o1:case-engine',
      'plan:o2:demo', 'subscribe:o2:demo', 'plan:o2:case-engine', 'subscribe:o2:case-engine',
    ])
  })
  it('空 org 或空 module → 空计划', () => {
    expect(planAllTenantGrants([], ['demo'])).toEqual([])
    expect(planAllTenantGrants(['acme'], [])).toEqual([])
    expect(planAllTenantGrants([], [])).toEqual([])
  })
})
