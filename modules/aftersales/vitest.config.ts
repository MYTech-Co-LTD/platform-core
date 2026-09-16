import { defineConfig } from 'vitest/config'

// 售后模块是纯后端（无 console/mobile 页面）⇒ node 环境，不需要 happy-dom / jsx 配置。
export default defineConfig({
  test: { environment: 'node' },
})
