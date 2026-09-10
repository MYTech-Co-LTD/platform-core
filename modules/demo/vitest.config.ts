import { defineConfig } from 'vitest/config'

// 组件测试用 happy-dom（与 apps/web 同栈）；jest-dom matchers 由测试文件头部直接引入。
// 不引 @vitejs/plugin-react（重依赖）：esbuild jsx=automatic 即够 .tsx 测试转译。
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
  },
})
