import { defineConfig } from 'vitest/config'

// backend（域/路由，node）与 console（组件，happy-dom）双 project。
// ⚠️ backend 的 include 写精确目录，不写 `**/*.test.ts` + exclude：显式 exclude 会覆盖默认
// 排除项（含 node_modules），把依赖包里的测试也扫进来（aftersales 实测 98 → 149）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: ['domain/**/*.test.ts', 'routes/**/*.test.ts', '*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'console',
          environment: 'happy-dom',
          include: ['console/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
