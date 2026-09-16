import { beforeEach, describe, expect, it } from 'vitest'
import { currentClientRequestId, rotateClientRequestId } from './client-request-id'

describe('clientRequestId 三条语义（spec §3.2）', () => {
  beforeEach(() => sessionStorage.clear())

  it('语义①重试同键：同一会话内反复取到的是同一个键', () => {
    const a = currentClientRequestId()
    expect(currentClientRequestId()).toBe(a)
    expect(currentClientRequestId()).toBe(a)
  })

  it('语义②跨刷新同键：键存在 sessionStorage 里（新「模块实例」也读得到同一个）', () => {
    const a = currentClientRequestId()
    // 模拟「整页刷新」：内存全没了，只有 sessionStorage 还在
    expect(sessionStorage.getItem('aftersales.clientRequestId')).toBe(a)
  })

  it('语义③提交成功后轮换：rotate 之后必须换一个新键', () => {
    const a = currentClientRequestId()
    rotateClientRequestId()
    const b = currentClientRequestId()
    expect(b).not.toBe(a)
  })

  it('键是 UUID 形状（不是自增/时间戳这类会撞的值）', () => {
    expect(currentClientRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('sessionStorage 里是空串 ⇒ 当作没有（不当成一个合法的空键）', () => {
    sessionStorage.setItem('aftersales.clientRequestId', '')
    expect(currentClientRequestId()).not.toBe('')
  })
})
