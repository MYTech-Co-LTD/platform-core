// domain/registration.test.ts — 登记内核的纯函数测试（无 DB、无 HTTP）
import { describe, expect, it } from 'vitest'
import { RegistrationError, computeRegistration, pickPrimaryStoreId } from './registration'

const target = (over: Partial<{ name: string; phone: string; storeIds: number[] }> = {}) => ({
  name: '张三',
  phone: '13800000000',
  storeIds: [1, 2],
  ...over,
})

describe('computeRegistration', () => {
  it('无当前档案 ⇒ register，old 空、new 含全部目标字段', () => {
    const r = computeRegistration(null, target())
    expect(r.approveType).toBe('register')
    expect(r.oldInfo).toEqual({})
    expect(r.newInfo).toEqual({ name: '张三', phone: '13800000000', storeIds: [1, 2] })
  })

  it('★ 变更：old/new **只含实际变了的字段**（照源侧行为，spec §2.5）', () => {
    const cur = { name: '张三', phone: '13800000000', storeIds: [1, 2] }
    const r = computeRegistration(cur, target({ phone: '13900000000' }))
    expect(r.approveType).toBe('change')
    expect(r.oldInfo).toEqual({ phone: '13800000000' }) // name / storeIds 没变 ⇒ 不出现
    expect(r.newInfo).toEqual({ phone: '13900000000' })
  })

  it('门店集合按**无序**比较：同样两个门店换顺序不算变更 ⇒ 整体无差异 ⇒ 抛错', () => {
    const cur = { name: '张三', phone: '13800000000', storeIds: [1, 2] }
    // 顺序不同但集合相同 ⇒ 什么都不算变；此时整体无差异 ⇒ 抛「没有修改任何信息」
    expect(() => computeRegistration(cur, target({ storeIds: [2, 1] }))).toThrow(RegistrationError)
  })

  it('★ 无任何变更 ⇒ 抛 RegistrationError（源侧「您没有修改任何信息」的服务端落点）', () => {
    const cur = { name: '张三', phone: '13800000000', storeIds: [1, 2] }
    expect(() => computeRegistration(cur, target())).toThrow(/没有修改/)
  })

  it('storeIds 归一：去重 + 升序（避免 [1,1,2] 与 [1,2] 被判成不同）', () => {
    const r = computeRegistration(null, target({ storeIds: [2, 1, 2] }))
    expect(r.newInfo.storeIds).toEqual([1, 2])
  })

  it('空门店列表是合法目标（人可以不属于任何门店）', () => {
    const r = computeRegistration(null, target({ storeIds: [] }))
    expect(r.newInfo.storeIds).toEqual([])
  })

  it('多个字段同时变 ⇒ old/new 各带多个键', () => {
    const cur = { name: '张三', phone: '138', storeIds: [1] }
    const r = computeRegistration(cur, target({ name: '李四', phone: '138', storeIds: [2, 3] }))
    expect(r.oldInfo).toEqual({ name: '张三', storeIds: [1] })
    expect(r.newInfo).toEqual({ name: '李四', storeIds: [2, 3] })
  })
})

describe('pickPrimaryStoreId', () => {
  it('取归一后的第一个门店作主门店（只影响 employee.store_id 这个遗留列）', () => {
    expect(pickPrimaryStoreId(target({ storeIds: [5, 3] }))).toBe(3)
  })

  it('无门店 ⇒ null', () => {
    expect(pickPrimaryStoreId(target({ storeIds: [] }))).toBeNull()
  })
})
