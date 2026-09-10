import { describe, expect, it } from 'vitest'
import { normalizeScopes } from './public'

describe('normalizeScopes', () => {
  it('合并 scopes 与 permissions.resources 并去重', () => {
    expect(normalizeScopes({ scopes: ['demo:view', 'ticket:dispatch'],
      permissions: [{ resources: ['ticket:dispatch', 'ticket:admin'] }, {}] }))
      .toEqual(['demo:view', 'ticket:admin', 'ticket:dispatch'])
  })
  it('空输入返回空数组', () => { expect(normalizeScopes({})).toEqual([]) })
  it('过滤空串', () => { expect(normalizeScopes({ scopes: ['', 'a:b'] })).toEqual(['a:b']) })
})
