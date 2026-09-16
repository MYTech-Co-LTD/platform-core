import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Confirm, Message } from './wuji'

const success = vi.fn()
const confirmFn = vi.fn()
const hide = vi.fn()
vi.mock('tdesign-vue-next', () => ({
  MessagePlugin: { success: (...a: unknown[]) => success(...a), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  DialogPlugin: { confirm: (...a: unknown[]) => { confirmFn(...a); return { hide } } },
}))

describe('shims/wuji', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    success.mockClear(); confirmFn.mockClear(); hide.mockClear()
  })

  it('Message.success(字符串)：文案原样交给 TDesign', () => {
    Message.success('提交成功')
    expect(success).toHaveBeenCalledWith({ content: '提交成功', duration: 3000 })
  })

  it('onClose 必须被调用（提交页靠它 router.back()）——超时后触发', () => {
    const onClose = vi.fn()
    Message.success({ content: '工单提交成功！', duration: 2000, onClose })
    expect(onClose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Confirm 返回 {hide}，透传到 TDesign 的 dialog 实例', () => {
    const d = Confirm({ header: '确认提交', body: '确定吗', confirmBtn: '提交', cancelBtn: '取消', theme: 'info' })
    d.hide()
    expect(confirmFn).toHaveBeenCalledWith(
      expect.objectContaining({ header: '确认提交', body: '确定吗', confirmBtn: '提交', cancelBtn: '取消', theme: 'info' }),
    )
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('Confirm 的 onConfirm 被透传（源页在回调里 hide）', () => {
    const onConfirm = vi.fn()
    Confirm({ onConfirm })
    expect(confirmFn.mock.calls[0]![0].onConfirm).toBeTypeOf('function')
    ;(confirmFn.mock.calls[0]![0].onConfirm as () => void)()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
