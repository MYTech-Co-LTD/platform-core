// vitest setupFiles（vite.config.ts test.setupFiles）：
// jest-dom matchers 全 web 包生效（@testing-library/jest-dom/vitest 自带 expect 增强类型）
import '@testing-library/jest-dom/vitest'

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
