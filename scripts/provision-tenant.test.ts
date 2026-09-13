import { describe, expect, it } from 'vitest'
import { tenantProvisionSteps } from './provision-tenant.mjs'

describe('tenantProvisionSteps（纯核）', () => {
  it('默认 org 命名 + 无模块四步；带 --module 逐模块追加 plan/subscribe', () => {
    expect(tenantProvisionSteps('acme')).toEqual(['org:acme-org', 'tenant-row:acme', 'anchor', 'permissions'])
    expect(tenantProvisionSteps('acme', { org: 'o1', modules: ['demo', 'case-engine'] })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'permissions', 'plan:demo', 'subscribe:demo', 'plan:case-engine', 'subscribe:case-engine',
    ])
  })
})
