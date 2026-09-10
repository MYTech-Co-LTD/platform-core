// vitest.config.ts — DB 测试文件串行化。
// migrate.test.ts 与 tenant.test.ts 都跑真 PG 且入口处各有幂等 DDL（create table if not
// exists）——vitest 默认文件级并行，全新库上并发建同名表会触发 pg 系统目录竞态
// （duplicate key on pg_type_typname_nsp_index），关掉文件级并行消除该偶发。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
