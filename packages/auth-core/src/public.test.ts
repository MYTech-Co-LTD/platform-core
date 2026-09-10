import { describe, expect, it } from 'vitest'
import { effectiveScopes, normalizeScopes } from './public'

describe('normalizeScopes', () => {
  it('合并 scopes 与 permissions.resources 并去重', () => {
    expect(normalizeScopes({ scopes: ['demo:view', 'ticket:dispatch'],
      permissions: [{ resources: ['ticket:dispatch', 'ticket:admin'] }, {}] }))
      .toEqual(['demo:view', 'ticket:admin', 'ticket:dispatch'])
  })
  it('空输入返回空数组', () => { expect(normalizeScopes({})).toEqual([]) })
  it('过滤空串', () => { expect(normalizeScopes({ scopes: ['', 'a:b'] })).toEqual(['a:b']) })
  it('permissions[].resources 空串同样被过滤', () => {
    expect(normalizeScopes({ permissions: [{ resources: ['', 'a:b'] }] })).toEqual(['a:b'])
  })
})

describe('effectiveScopes public 导出', () => {
  it('public.ts 转出 effectiveScopes 且语义一致', () => {
    expect(effectiveScopes('admin1', [], [{ users: ['acme/admin1'], resources: ['a:b'] }]))
      .toEqual(['a:b'])
  })
})
