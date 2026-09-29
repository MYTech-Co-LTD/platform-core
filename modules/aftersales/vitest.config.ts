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
          // 集成级 suite 的时长口径（issue #310，与 apps/server 的 loader.test.ts 同一处理）。
          // 本包**没有** modules/data / apps/server 那样的 fileParallelism:false ⇒ 29 个文件
          // 并行打同一台 PG，而每个文件的 beforeAll / 用例里的 applyMigrations() 都要抢
          // **全库唯一**的迁移 advisory lock（migrate.ts 刻意不按 module 分键）；
          // `pnpm -r --if-present test` 又叠加**跨包**并发。抢不到锁就按重试间隔**整量子**地睡。
          // 实测（#310 复现，2026-09-28 的 CI 失败 + 本机 `pnpm test` 全量跑）：
          //   `module.test.ts > applyMigrations 幂等：连跑两次…`（**连抢两次锁**）
          //   ⇒ `Error: Test timed out in 5000ms.`
          // 15s 是**余量**不是**替代**：#310 已从源头修掉「无迁移模块也抢锁」，本条只兜
          // 「真取锁 + 并发」的残余；真卡死（锁被占满 60s）照样会红。
          // ⚠️ 必须写在 project 的 `test` 里且键名是 `testTimeout`（modules/data 实测：
          //    project 级写 `timeout`、或根级写 `testTimeout`，都会被静默忽略）。
          testTimeout: 15_000,
          hookTimeout: 15_000,
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
