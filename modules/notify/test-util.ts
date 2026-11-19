// test-util.ts — 模块测试公共脚手架（照 modules/forms/test-util.ts 先例）。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, ModuleContext, ModuleDefinition } from '@platform/sdk'
// 【刻意】不复制宿主 migrate 实现——重跑语义（记账表、单文件单事务、排序）是行为契约，
// 复制即第二事实源。跨包相对引用是合理代价（成因详见 forms/aftersales 同款注释）。
import { runMigrations } from '../../apps/server/src/migrate'

/** 造一个身份。缺省给 notify:view——按用例需要显式传 scopes。 */
export function makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity {
  const scopes = partial.scopes ?? ['notify:view']
  return {
    userId: partial.userId ?? 'u-test',
    orgId: partial.orgId,
    displayName: partial.displayName ?? '测试用户',
    scopes,
    // 逐字段显式接（不 spread）：漏一个已存在字段就是静默丢参（aftersales Task 10 实测）。
    boundExternalIds: partial.boundExternalIds,
    hasScope: (code: string) => scopes.includes(code),
  }
}

/** 模块路由测试壳：注入 identity 后挂模块 router（与宿主装配不同源，宿主层归 apps/server 测试）。 */
export function buildTestApp(mod: ModuleDefinition, identity: Identity, ctx: ModuleContext): Hono {
  const app = new Hono<{ Variables: { identity: Identity } }>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    await next()
  })
  app.route('/', mod.createRouter(ctx))
  // Hono Env 泛型不变的绕法，与宿主装配处同款（apps/server/src/app.ts mount）
  return app as unknown as Hono
}

/** 跑本模块迁移（读 ./migrations/*.sql）。路径用 node:path 取——本包 vitest 开 happy-dom
 *  后全局 URL 被换掉，new URL(rel, import.meta.url) 分辨不出 file: 方案（#718 实测）。
 *
 *  `lockRetryIntervalMs: 200`：`pnpm -r test` 让最多 4 个 workspace 包**并发**打同一台 PG，
 *  而迁移锁键是全库唯一的（`apps/server/src/migrate.ts` 文件头 / #310）⇒ 本包每次
 *  beforeAll 都在和别的包的真迁移抢锁。生产口径的 2s 重试间隔会**整量子放大**等待
 *  （实测 2053/2139/4106ms），把 vitest 的 5s 默认超时撞穿，表现为「间歇超时、重跑即过」
 *  ——2026-11-19 在 CI 上实测到一次（migrations.test.ts 幂等用例 5006ms 超时）。
 *  这里用**测试专用旋钮**（`RunMigrationsOptions` 本就是为测试留的口子）把粒度调细，
 *  **生产口径不变**；等待本身仍是真实的锁等待，不掩盖它。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'notify', join(dirname(fileURLToPath(import.meta.url)), 'migrations'), {
    onMissingDir: 'error',
    lockRetryIntervalMs: 200,
  })
}
