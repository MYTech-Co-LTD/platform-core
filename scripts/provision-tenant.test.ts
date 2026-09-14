import { describe, expect, it } from 'vitest'
import { parseLoginMethods, planAllTenantGrants, provisionPerms, tenantProvisionSteps } from './provision-tenant.mjs'

describe('tenantProvisionSteps（纯核）', () => {
  it('默认 org 命名 + 无模块四步；带 --module 逐模块追加 plan/subscribe', () => {
    expect(tenantProvisionSteps('acme')).toEqual(['org:acme-org', 'tenant-row:acme', 'anchor', 'permissions'])
    expect(tenantProvisionSteps('acme', { org: 'o1', modules: ['demo', 'case-engine'] })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'permissions', 'plan:demo', 'subscribe:demo', 'plan:case-engine', 'subscribe:case-engine',
    ])
  })
  it('带 domain 时 steps 在 anchor 后插入 domain 步（spec-3 §2.3）', () => {
    expect(tenantProvisionSteps('acme', { org: 'o1', domain: 'acme.example.com' })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'domain:acme.example.com', 'permissions',
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

describe('parseLoginMethods（spec-3 §2.2：白名单入口拦）', () => {
  it('缺省 password；合法值解析去空格；顺序保留', () => {
    expect(parseLoginMethods()).toEqual(['password'])
    expect(parseLoginMethods('wecom-qr')).toEqual(['wecom-qr'])
    expect(parseLoginMethods('password, wecom-qr')).toEqual(['password', 'wecom-qr'])
  })
  it('坏值 throw 且报出合法集合——坏值进库=前端静默丢 tab', () => {
    expect(() => parseLoginMethods('password,oauth')).toThrow(/oauth.*password.*wecom-qr/)
  })
})

describe('provisionPerms（spec-3 §2.1：内置码在前并入扇出）', () => {
  it('builtin 在前 + 模块码随后（与装载器「内置码在前」同序）', () => {
    expect(provisionPerms([{ code: 'demo:view', name: 'x' }], [{ code: 'tenant:admin', name: '租户管理员' }]))
      .toEqual([{ code: 'tenant:admin', name: '租户管理员' }, { code: 'demo:view', name: 'x' }])
    expect(provisionPerms([{ code: 'demo:view', name: 'x' }])).toEqual([{ code: 'demo:view', name: 'x' }])
  })
})
