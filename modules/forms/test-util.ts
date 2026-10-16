// test-util.ts — 模块测试公共脚手架（照 modules/aftersales/test-util.ts 先例）。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, ModuleContext, ModuleDefinition } from '@platform/sdk'
// 【刻意】不复制宿主 migrate 实现——重跑语义（记账表、单文件单事务、排序）是行为契约，
// 复制即第二事实源。跨包相对引用是合理代价（成因详见 aftersales 同款注释）。
import { runMigrations } from '../../apps/server/src/migrate'

/** 造一个身份。缺省给 forms:view——按用例需要显式传 scopes。 */
export function makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity {
  const scopes = partial.scopes ?? ['forms:view']
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
 *  后全局 URL 被换掉，new URL(rel, import.meta.url) 分辨不出 file: 方案（#718 实测）。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'forms', join(dirname(fileURLToPath(import.meta.url)), 'migrations'))
}
