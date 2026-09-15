import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema } from '@platform/sdk'
import mod from './index'
import { applyMigrations, rawMigrationSqls } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

describe('manifest（不需要数据库）', () => {
  it('manifest.yaml 过 schema，且 id / 权限码 / guest 码三者自洽', () => {
    const raw = parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8'))
    const m = ManifestSchema.parse(raw)
    expect(m.id).toBe('aftersales')
    expect(m.permissions.map((p) => p.code).sort()).toEqual(['aftersales:guest', 'aftersales:manage'])
    expect(m.guest?.scope).toBe('aftersales:guest')
    expect(m.migrations?.dir).toBe('./migrations')
  })

  it('api.internal 的声明集合与 createRouter 注册的路由集合逐条一致（装载期双向核对的本地版）', () => {
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path}`))
    const registered = new Set(
      mod
        .createRouter({ pool: null as never })
        .routes.filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    )
    expect([...registered].sort()).toEqual([...declared].sort())
  })
})

describePg('迁移（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    // 池在文件级 afterAll 之前就被 end 了 ⇒ 说明有别的钩子提前收摊，本文件后续断言会假红。
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('applyMigrations 幂等：连跑两次，第二次不新应用任何版本', async () => {
    await applyMigrations(pool)
    const second = await applyMigrations(pool)
    expect(second).toEqual([])
  })

  it('迁移 SQL 本身幂等：不记账、直接连跑两遍不报错（部署脚本会全量重跑）', async () => {
    // 这条测的是【模块自己的产物】，与上一条测的【runner 记账】是两回事：
    // runMigrations 第二次因记账而跳过 SQL，等于没验 DDL 的 if not exists。
    // 而 db-migration.md §1 要的正是「同一批迁移重复执行不报错」。
    const sqls = await rawMigrationSqls()
    expect(sqls.length).toBeGreaterThan(0)
    for (const sql of sqls) {
      await pool.query(sql)
      await pool.query(sql)
    }
  })

  it('7 张表全部落库，且每张都带 org 列（租户数据表纪律）', async () => {
    const tables = ['region', 'store', 'product', 'employee', 'ticket_rule', 'ticket', 'ticket_attachment']
    const res = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'aftersales' and table_name = any($1::text[])`,
      [tables],
    )
    const byTable = new Map<string, string[]>()
    for (const r of res.rows) {
      byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.column_name])
    }
    for (const t of tables) {
      expect(byTable.get(t), `表 aftersales.${t} 不存在`).toBeDefined()
      expect(byTable.get(t), `表 aftersales.${t} 缺 org 列`).toContain('org')
    }
  })
})
