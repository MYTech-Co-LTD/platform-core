// 判据纯函数的 fixture 单测（真库判定在 CI 的 gates 真仓跑，这里钉住比对逻辑本身——
// 与 check-tenant-isolation.test.ts 同分工：单测拿 fixture 验守卫逻辑，gates 拿真仓验守卫结论）。
import { describe, expect, it } from 'vitest'
import { diffColumns, diffDeclaredVsLock, normalizeColumns } from './check-data-dependencies.mjs'

describe('diffColumns（库实际列集 vs lock 登记）', () => {
  it('完全一致（含顺序无关）⇒ 空', () => {
    const a = [
      { name: 'org', type: 'text' },
      { name: 'code', type: 'text' },
      { name: 'money', type: 'numeric' },
    ]
    const b = [
      { name: 'money', type: 'numeric' },
      { name: 'code', type: 'text' },
      { name: 'org', type: 'text' },
    ]
    expect(diffColumns(a, b)).toEqual([])
  })

  it('多列（库里加了 lock 没登记的列）⇒ 报 +', () => {
    const actual = [
      { name: 'org', type: 'text' },
      { name: 'phone', type: 'text' },
    ]
    const registered = [{ name: 'org', type: 'text' }]
    expect(diffColumns(actual, registered)).toEqual(['多列：+phone text'])
  })

  it('缺列（lock 登记了库里删掉的列）⇒ 报 -', () => {
    const actual = [{ name: 'org', type: 'text' }]
    const registered = [
      { name: 'org', type: 'text' },
      { name: 'region', type: 'text' },
    ]
    expect(diffColumns(actual, registered)).toEqual(['缺列：-region text'])
  })

  it('改型 ⇒ 报 ~ 与前后类型', () => {
    const actual = [{ name: 'money', type: 'bigint' }]
    const registered = [{ name: 'money', type: 'numeric' }]
    expect(diffColumns(actual, registered)).toEqual(['改型：~money numeric → bigint'])
  })

  it('同列名同类型才一致——text ≠ varchar', () => {
    const actual = [{ name: 'code', type: 'character varying' }]
    const registered = [{ name: 'code', type: 'text' }]
    expect(diffColumns(actual, registered)).toEqual(['改型：~code text → character varying'])
  })
})

describe('diffDeclaredVsLock（声明集 vs lock 键集）', () => {
  it('两边一致 ⇒ 双空', () => {
    expect(diffDeclaredVsLock(['a.x', 'b.y'], ['b.y', 'a.x'])).toEqual({ missing: [], stale: [] })
  })

  it('声明了但 lock 没登记 ⇒ missing', () => {
    expect(diffDeclaredVsLock(['a.x', 'a.z'], ['a.x'])).toEqual({ missing: ['a.z'], stale: [] })
  })

  it('lock 有但已无人声明 ⇒ stale（陈条目）', () => {
    expect(diffDeclaredVsLock(['a.x'], ['a.x', 'b.old'])).toEqual({ missing: [], stale: ['b.old'] })
  })
})

describe('normalizeColumns（lock 落盘形状）', () => {
  it('按列名排序 + 收窄成字符串字段', () => {
    expect(
      normalizeColumns([
        { name: 'zz', type: 1 },
        { name: 'aa', type: 'text' },
      ]),
    ).toEqual([
      { name: 'aa', type: 'text' },
      { name: 'zz', type: '1' },
    ])
  })
})
