// test-util.ts — 模块测试的公共脚手架（不是测试文件：tsconfig 会 typecheck 它）。
import { readdir, readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { TENANT_STORAGE } from '@platform/sdk'
import type { Identity, ModuleContext, ModuleDefinition, TenantStorageConfig } from '@platform/sdk'
// 【刻意】不复制 apps/server/src/migrate.ts 的实现。重跑语义（记账表 platform.schema_migrations、
// 单文件单事务、按文件名排序）是行为契约：复制一份就是第二个事实源，改一边另一边不生效，
// 而症状是「本地过了 CI 没过」这种最贵的错。跨包相对引用在这里是合理代价。
import { runMigrations } from '../../apps/server/src/migrate'

/** 造一个身份。默认给管理端码——访客面测试显式传 scopes: ['aftersales:guest']。 */
export function makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity {
  const scopes = partial.scopes ?? ['aftersales:manage']
  return {
    userId: partial.userId ?? 'u-test',
    orgId: partial.orgId,
    displayName: partial.displayName ?? '测试用户',
    scopes,
    hasScope: (code: string) => scopes.includes(code),
  }
}

/**
 * 模块路由的测试壳：注入 identity 后把模块 router 挂在 '/'。
 *
 * 它与宿主 app.ts 的装配【不同源】——宿主那层（租户解析、会话、门卫、停用闸门）不在这里。
 * 端到端形态的断言（含门卫与闸门）归 apps/server 的测试，本壳只覆盖模块自身的业务行为。
 * 这样分工是为了让模块测试不依赖宿主的装配细节（宿主改了装配不该红在模块测试上）。
 *
 * ⚠️ `storage` 是**第 4 参**（M3c 步 4）：与宿主投影同形状的本请求存储配置。
 * **不传 = 未配存储**（与「模块未声明 `storage`」同一状态）⇒ 附件端点回 503。
 * 模块的 `createRouter` 已不再从 env 取配置 ⇒ 不注入就等于没配置 —— 这是本步最容易漏的一处：
 * 漏了不会编译错，只会让一整组附件用例**静默变成 503**。
 */
export function buildTestApp(
  mod: ModuleDefinition,
  identity: Identity,
  ctx: ModuleContext,
  storage?: TenantStorageConfig,
): Hono {
  const app = new Hono<{ Variables: { identity: Identity; [TENANT_STORAGE]?: TenantStorageConfig } }>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    // 不传就不 set：与宿主「不声明就不注入」同一语义，别在这条路径上补默认值
    if (storage) c.set(TENANT_STORAGE, storage)
    await next()
  })
  app.route('/', mod.createRouter(ctx))
  // `as unknown as Hono`：Hono 的 Env 泛型是不变的，带 Variables 的实例【不如约】赋给裸 `Hono`
  // （`packages/platform-sdk/src/module.ts` 的 ModuleDefinition 注释逐条记录了这处摩擦）。
  // 这是本仓既有的绕法——宿主装配处同样写着 `mount(app as unknown as Hono)`
  // （apps/server/src/app.ts:276）。返回类型保持计划承诺的 `Hono`，T6–T9 照常消费。
  return app as unknown as Hono
}

/** 跑本模块的迁移（读 ./migrations/*.sql）。返回本次新应用的 version 列表。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'aftersales', new URL('./migrations', import.meta.url).pathname)
}

/** 迁移目录里全部 *.sql 的正文，按文件名排序（与 runMigrations 同一排序口径）。 */
export async function rawMigrationSqls(): Promise<string[]> {
  const dir = new URL('./migrations', import.meta.url)
  const entries = await readdir(dir)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  // 基 URL 必须补尾斜杠：`new URL('001_init.sql', '…/aftersales/migrations')` 会把最后一段当
  // 【文件名】替换掉，解析成 '…/aftersales/001_init.sql'（实测 ENOENT）。上面的 readdir 直接吃
  // 路径不做相对解析，故只有这一处需要补。
  return Promise.all(files.map((f) => readFile(new URL(f, dir.href + '/'), 'utf8')))
}
