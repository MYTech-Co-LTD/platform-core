import { describe, expect, it } from 'vitest'
import { platformOnlyCodes, tenantGrantable } from './admin-permissions'

describe('admin 权限宇宙', () => {
  const all = [
    { code: 'tenant:admin', name: '租户管理员' },
    { code: 'forms:global-manage', name: '平台全局字典管理', platformOnly: true },
    { code: 'demo:view', name: '演示查看' },
  ] as const

  it('tenantGrantable：过滤 platformOnly，只回 code/name', () => {
    expect(tenantGrantable(all)).toEqual([
      { code: 'tenant:admin', name: '租户管理员' },
      { code: 'demo:view', name: '演示查看' },
    ])
  })

  it('platformOnlyCodes：只收集 platformOnly 的码', () => {
    expect([...platformOnlyCodes(all)]).toEqual(['forms:global-manage'])
  })
})
