import { describe, expect, it } from 'vitest'
import { withObjectLock } from './object-lock'

describe('withObjectLock', () => {
  it('同键串行：后一个必须等前一个结束', async () => {
    const order: string[] = []
    const slow = withObjectLock('k', async () => {
      order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end')
    })
    const fast = withObjectLock('k', async () => { order.push('b') })
    await Promise.all([slow, fast])
    expect(order).toEqual(['a-start', 'a-end', 'b'])
  })

  it('异键并行：互不等待', async () => {
    const order: string[] = []
    await Promise.all([
      withObjectLock('x', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('x') }),
      withObjectLock('y', async () => { order.push('y') }),
    ])
    expect(order).toEqual(['y', 'x'])
  })

  it('前一个抛错不卡死后续', async () => {
    await expect(withObjectLock('e', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await withObjectLock('e', async () => 'ok')).toBe('ok')
  })
})
