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

  // ⚠️（评审 M2）本用例是**顺序**执行（先 await 前者、再发后者），且实现里的链尾 `tail` 被
  // noop 包裹 ⇒ `chains.get(key)` 恒为 **fulfilled** ⇒ `withObjectLock` 内 `prev.then(fn, fn)`
  // 的 **onRejected 分支当前不可达**。那是**防御性**参数（若将来有人把链尾改成原样透传 `run`
  // 而不清尾，链尾就可能处于 rejected 态，它才用得上）。**不为此硬造测试**——要触发它得先让
  // 链尾处于 rejected 态，而当前实现结构上不产生这种尾。本用例真正钉的是：抛错的那次请求
  // 自身 rejected 传出去、且**不卡死**同键的后续调用。
  it('前一个抛错不卡死后续', async () => {
    await expect(withObjectLock('e', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await withObjectLock('e', async () => 'ok')).toBe('ok')
  })
})
