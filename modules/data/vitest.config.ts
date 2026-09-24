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
