// vitest setupFiles（vite.config.ts test.setupFiles）：
// jest-dom matchers 全 web 包生效（@testing-library/jest-dom/vitest 自带 expect 增强类型）
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// ---- 残留真实 timer 收尸（issue #12）----
// @ant-design/pro-components 的 BaseMenu 在模块内部 setTimeout → dispatchSetState；
// 慢机上 timer 可能在 vitest 拆掉 DOM 环境之后才触发 ⇒ "window is not defined" 未捕获异常
// ⇒ 测试全绿但退出码 1（间歇性，伪装成改动把 CI 搞红）。vi.clearAllTimers 只清 fake timer，
// 够不着这种第三方真 timer——这里包一层 setTimeout 记账，afterEach 清光残留：
// timer 在环境还活着时被取消，dispatchSetState 根本不发生。
const originalSetTimeout = globalThis.setTimeout
const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
  const id = originalSetTimeout((...args: unknown[]) => {
    pendingTimers.delete(id)
    ;(handler as (...a: unknown[]) => void)(...args)
  }, timeout, ...(rest as [])) as ReturnType<typeof setTimeout>
  pendingTimers.add(id)
  return id
}) as unknown as typeof globalThis.setTimeout

afterEach(() => {
  for (const id of pendingTimers) clearTimeout(id)
  pendingTimers.clear()
})


// localStorage 替身：本仓 happy-dom@20（vitest 3.2.7）实测**不暴露** window.localStorage
// （探针：window/globalThis 上 typeof 均 'undefined'），而浏览器端它是 Web 标准。
// console 壳的暗色偏好持久化（issue #36）依赖它——测试环境在此补最小 Storage 实现。
class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length(): number {
    return this.m.size
  }
  clear(): void {
    this.m.clear()
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? this.m.get(key)! : null
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.m.delete(key)
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value))
  }
}

if (!window.localStorage) {
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
}
