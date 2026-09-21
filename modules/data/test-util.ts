// test-util.ts — 模块测试的公共脚手架（不是测试文件：tsconfig 会 typecheck 它）。
import { readdir, readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, ModuleContext, ModuleDefinition } from '@platform/sdk'
// 【刻意】不复制 apps/server/src/migrate.ts 的实现。重跑语义（记账表 platform.schema_migrations、
// 单文件单事务、按文件名排序）是行为契约：复制一份就是第二个事实源，症状是「本地过了 CI 没过」。
import { runMigrations } from '../../apps/server/src/migrate'
import type { DataTenant, ModuleVars } from './routes/context'

/** 造一个身份。默认给问数码。 */
export function makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity {
  const scopes = partial.scopes ?? ['data:query']
  return {
    userId: partial.userId ?? 'u-test',
    orgId: partial.orgId,
    displayName: partial.displayName ?? '测试用户',
    scopes,
    hasScope: (code: string) => scopes.includes(code),
  }
}

/**
 * 模块路由的测试壳：注入 identity 与 tenant 后把模块 router 挂在 '/'。
 * 与宿主 app.ts 的装配【不同源】——租户解析、会话、PAT/企微中间件、门卫、停用闸门都不在这里。
 * 端到端形态（含三通道鉴权）归 apps/server 的测试（T10）。
 *
 * `tenant` 是**第 4 个参数且有默认值**：绝大多数用例只关心 identity，只有断言「主体钉死」的
 * 用例才需要指定 `casdoor_org`（授权核心写进 SQL 的值就来自它）。
 */
export function buildTestApp(
  mod: ModuleDefinition,
  identity: Identity,
  ctx: ModuleContext,
  tenant: DataTenant = { id: 1, casdoor_org: 'test' },
): Hono {
  // 泛型必须写 `ModuleVars`（不是内联 Variables）：`c.set` 的键集会随 Env 走，
  // 裸 `new Hono()` 得到 `BlankEnv` ⇒ `c.set` 只接受 `never`。
  const app = new Hono<ModuleVars>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    c.set('tenant', tenant)
    await next()
  })
  app.route('/', mod.createRouter(ctx))
  // `as unknown as Hono`：Hono 的 Env 泛型不变，带 Variables 的实例【不如约】赋给裸 Hono。
  // 本仓既有绕法（apps/server/src/app.ts 的 mount 处同样这么写）。
  return app as unknown as Hono
}

/** 跑本模块的迁移（读 ./migrations/*.sql）。返回本次新应用的 version 列表。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'data', new URL('./migrations', import.meta.url).pathname)
}

/** 迁移目录里全部 *.sql 的正文，按文件名排序（与 runMigrations 同一排序口径）。 */
export async function rawMigrationSqls(): Promise<string[]> {
  const dir = new URL('./migrations', import.meta.url)
  const entries = await readdir(dir)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  // 基 URL 必须补尾斜杠：不补会把最后一段当【文件名】替换掉（实测 ENOENT）。
  return Promise.all(files.map((f) => readFile(new URL(f, dir.href + '/'), 'utf8')))
}
