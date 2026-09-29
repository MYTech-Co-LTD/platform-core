import { defineConfig } from 'vitest/config'

// backend（域/路由，node）与 console（组件，happy-dom）双 project。
// ⚠️ backend 的 include 写精确目录，不写 `**/*.test.ts` + exclude：显式 exclude 会覆盖默认
// 排除项（含 node_modules），把依赖包里的测试也扫进来（aftersales 实测 98 → 149）。
export default defineConfig({
  test: {
    // 真库测试串行（#169 根治，2026-09-24 拍板方案 A）：backend 的 13 个文件并行打同一个 PG，
    // 迁移 advisory lock（固定 2s 重试）在 CI 4 核争用下单测偶发超 vitest 5s 默认超时（实测命中
    // agent-loop/mcp/query 等，重跑即绿——竞态签名）。⚠️ fileParallelism 必须写**根级**：
    // project 级不生效（实测墙钟 4.45s < 测试累计 14.48s 仍并行）。代价是本包 CI 墙钟 ~25s →
    // ~60-90s（console 的 happy-dom 组件测试一并串行——不碰库，串行无害）。
    // apps/server 早已因 pg 系统目录竞态串行（见其 vitest.config.ts 头注），但会被本包的并行
    // 打库拖累（实测 loader.test.ts 超时与 mcp.test.ts 同期）——本条同样缓解。
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          // 集成级 suite 的时长口径（issue #310，与 apps/server 的 loader.test.ts 同一处理）。
          // 每个文件 beforeAll / 用例里的 applyMigrations() 都**真的**跑迁移，因而要抢
          // **全库唯一**的迁移 advisory lock；`pnpm -r --if-present test` 又让 4 个包并发打
          // 同一台 PG。抢不到锁的一方按 migrate.ts 的重试间隔**整量子**地睡 —— 上面那条
          // fileParallelism:false 只串行了**本包内部**（#169 的缓解），挡不住**跨包**那半。
          // 实测（#310 本机复现，同一 4 包并发拓扑 + 全新库）：本包单用例最坏
          // 10013ms（1 次失败）/ 6141ms / 4166ms —— 全是量子的整数倍，正是「5s 单测默认值
          // 套错了对象」。15s 是**余量**不是**替代**：#310 已从源头修掉「无迁移模块也抢锁」，
          // 本条只兜「真取锁 + CI 慢一档」的残余；真卡死（锁被占满 60s）照样会红。
          //
          // ⚠️ 位置与键名都踩过坑（实测，不是推断）：本项**必须写在 project 的 `test` 里**，
          //    且键名是 `testTimeout`。逐项设 1ms 验证过：
          //      · project 级写 `timeout`（错键名）⇒ 用例照样全绿（静默忽略）
          //      · 根级写 `testTimeout`（用 projects 时不下传）⇒ 用例照样全绿
          //      · project 级写 `testTimeout` ⇒ 才真的生效
          testTimeout: 15_000,
          hookTimeout: 15_000,
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
