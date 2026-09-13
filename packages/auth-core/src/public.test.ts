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

// 事故回归护栏（2026-09-13 生产 502）：桶文件的值导出列表误含 interface → Node ESM 运行时
// SyntaxError、容器崩溃循环。typecheck 拦不住（值/型歧义），单测直连 src 文件也拦不住
// （不走桶）——只有「以值身份真加载整个桶」能拦。import 本身就是断言：加载失败即测试红。
describe('桶文件运行时可加载（事故护栏）', () => {
  it('import * as barrel 不炸且值导出在位', async () => {
    const barrel = await import('./public')
    expect(typeof barrel.CasdoorClient).toBe('function')
    expect(typeof barrel.normalizeScopes).toBe('function')
  })
})
