// test-util.ts — 模块测试公共脚手架（照 modules/aftersales/test-util.ts 先例）。
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

/** 跑本模块迁移（读 ./migrations/*.sql）。路径必须 fileURLToPath（#203：url.pathname 非 ASCII 静默空转）。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'forms', fileURLToPath(new URL('./migrations', import.meta.url)))
}

/** 迁移目录全部 *.sql 正文（按文件名排序）——幂等重放测试用。 */
export async function rawMigrationSqls(): Promise<string[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const dir = new URL('./migrations', import.meta.url)
  const entries = await readdir(dir)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  // 基 URL 补尾斜杠（把最后一段当目录而非文件名——aftersales 同款实测坑）
  return Promise.all(files.map((f) => readFile(new URL(f, dir.href + '/'), 'utf8')))
}
