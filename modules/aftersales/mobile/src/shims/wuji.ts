// src/shims/wuji.ts —— `@wujibase/wuji` 的收窄替身（spec §3.2 三 shim 表）。
//
// 源侧消费面只有两个符号：`Message`、`Confirm`。
// **`getCurrentUser` 不提供**：它在裁剪后的调用图里已无任何调用点（唯一消费它的
// `useAfterSalesData.loadUserStores()` 是死码且已删），而实现它还得新开「访客 whoami」端点
// ——为死码开端点不划算（spec §3.2「只提供保留页真正调到的」）。
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'

type MessageLevel = 'success' | 'warning' | 'error' | 'info'

interface MessageOptions {
  content: string
  duration?: number
  /** 源侧用它做提交后的跳转/刷新：提交页 `router.back()`、登记页重载档案 */
  onClose?: () => void
}

const DEFAULT_DURATION = 3000

/**
 * 源侧两种调用形状都在用：`Message.error('文案')` 与 `Message.success({content, duration, onClose})`。
 *
 * ⚠️ `onClose` 是**行为契约不是装饰**（有单测钉住）：提交页靠它在提示消失后 `router.back()`。
 * 不赌 TDesign 的 `MessagePlugin` 会不会回调 —— **自己起定时器保证它恰好被调用一次**，
 * 这样「提交成功后回到上一页」这件事不依赖第三方组件的实现细节。
 */
function message(level: MessageLevel) {
  return (msg: string | MessageOptions): void => {
    const opts: MessageOptions = typeof msg === 'string' ? { content: msg } : msg
    const duration = opts.duration ?? DEFAULT_DURATION
    MessagePlugin[level]({ content: opts.content, duration })
    if (opts.onClose) setTimeout(opts.onClose, duration)
  }
}

export const Message = {
  success: message('success'),
  warning: message('warning'),
  error: message('error'),
  info: message('info'),
}

interface ConfirmOptions {
  header?: string
  body?: string
  confirmBtn?: string
  cancelBtn?: string
  theme?: 'info' | 'warning' | 'danger' | 'success' | 'default'
  onConfirm?: () => void
  onClose?: () => void
}

/**
 * 源侧形状：`const d = Confirm({...}); d.hide()`（页面在 onConfirm / onClose 里各自 hide）。
 * TDesign 的 `DialogPlugin.confirm` 正好返回带 `hide()` 的实例 ⇒ 直接透传，
 * 不自己包一层状态机（那只会造出第二份"弹窗开没开"的事实）。
 */
export function Confirm(opts: ConfirmOptions = {}): { hide: () => void } {
  const dialog = DialogPlugin.confirm({
    header: opts.header ?? '确认',
    body: opts.body ?? '',
    confirmBtn: opts.confirmBtn ?? '确定',
    cancelBtn: opts.cancelBtn ?? '取消',
    theme: opts.theme ?? 'info',
    onConfirm: () => opts.onConfirm?.(),
    onCancel: () => opts.onClose?.(),
    onClose: () => opts.onClose?.(),
  })
  return { hide: () => dialog.hide() }
}
