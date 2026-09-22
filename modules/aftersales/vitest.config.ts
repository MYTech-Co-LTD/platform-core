import { defineConfig } from 'vitest/config'

// M3a 起本模块**混合**两类测试：
//   · backend —— 域/路由/存储，node 环境（原来的唯一形态）
//   · console  —— 组件测试，happy-dom + jsx（M3a 新增）
//
// 为什么用 `test.projects` 而**不是** `environmentMatchGlobs`：后者在 vitest 3.2.7 上实测会打
//   DEPRECATED  "environmentMatchGlobs" is deprecated. Use `test.projects` …
// 而本仓有「不给后来者留弃用告警」的约定（见 modules/demo/console/index.tsx 里 antd List 那行注释）。
//
// ⚠️ backend 的 `include` 写**精确目录**，不要写 `**/*.test.ts` 再配 `exclude`：实测
//    显式 `exclude` 会**覆盖默认排除项**（含 `**/node_modules/**`），把
//    `node_modules/@platform/sdk/**` 的测试也扫进来（该模块测试数 98 → 149）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: ['domain/**/*.test.ts', 'routes/**/*.test.ts', 'migration/**/*.test.ts', '*.test.ts'],
        },
      },
      {
        // 不引 @vitejs/plugin-react（重依赖）：esbuild jsx=automatic 即够 .tsx 测试转译。
        // jest-dom matchers 由各测试文件头部直接引入（与 modules/demo 同做法）。
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
