// migrate.test.ts — runMigrations 语义钉死：空目录/目录缺失静默跳过、排序执行+记账、
// 事务回滚不记账、重跑幂等、真实 platform 迁移目录落表。
// 用真 PG（计划裁定）：本地 docker postgres:16，未提供 DATABASE_URL 时整体跳过（CI 同理）。
// 本地 PG 容器跨会话存活 → 用例 afterEach 自清记账行与建出的 schema，防污染下次运行。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from './migrate'

const dbUrl = process.env.DATABASE_URL
const serverMigrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))

describe.skipIf(!dbUrl)('runMigrations', () => {
  let pool: Pool
  const tmpDirs: string[] = []
  const usedModules: string[] = []
  const cleanupSqls: string[] = []

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl })
  })
  afterAll(async () => {
    await pool.end()
  })
  afterEach(async () => {
    for (const sql of cleanupSqls.splice(0)) await pool.query(sql)
    for (const m of usedModules.splice(0)) {
      await pool.query('delete from platform.schema_migrations where module = $1', [m])
    }
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  async function tmpModuleDir(files: Record<string, string> = {}): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'platform-mig-'))
    tmpDirs.push(dir)
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(dir, name), sql)
    }
    return dir
  }

  it('空目录：跑过且零 applied', async () => {
    usedModules.push('t_empty')
    const dir = await tmpModuleDir()
    expect(await runMigrations(pool, 't_empty', dir)).toEqual([])
  })

  it('目录不存在：静默跳过不抛（装载器对无迁移模块的约定）', async () => {
    usedModules.push('t_missing')
    const noDir = path.join(tmpdir(), 'no-such-dir-platform-test')
    expect(await runMigrations(pool, 't_missing', noDir)).toEqual([])
  })

  it('两个 *.sql 按文件名排序执行并记账两行；重跑幂等零 applied', async () => {
    const mod = 't_two'
    usedModules.push(mod)
    cleanupSqls.push('drop schema if exists t_two cascade')
    const dir = await tmpModuleDir({
      // 故意乱序写入：排序由执行器负责
      '002_second.sql': 'create schema if not exists t_two; create table t_two.b(id int);',
      '001_first.sql': 'create schema if not exists t_two; create table t_two.a(id int);',
    })
    expect(await runMigrations(pool, mod, dir)).toEqual(['001_first', '002_second'])
    const rows = await pool.query<{ version: string }>(
      'select version from platform.schema_migrations where module = $1 order by version',
      [mod],
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_first', '002_second'])
    // 重跑：记账命中 → 不再执行、零新 applied、行数不变
    expect(await runMigrations(pool, mod, dir)).toEqual([])
    const again = await pool.query<{ n: number }>(
      'select count(*)::int as n from platform.schema_migrations where module = $1',
      [mod],
    )
    expect(again.rows[0].n).toBe(2)
  })

  it('坏 SQL：事务回滚且不记账', async () => {
    const mod = 't_bad'
    usedModules.push(mod)
    cleanupSqls.push('drop schema if exists t_bad cascade')
    const dir = await tmpModuleDir({
      '001_bad.sql': 'create schema if not exists t_bad; create table t_bad.x(id int); this is not sql;',
    })
    await expect(runMigrations(pool, mod, dir)).rejects.toThrow()
    const rows = await pool.query<{ n: number }>(
      'select count(*)::int as n from platform.schema_migrations where module = $1',
      [mod],
    )
    expect(rows.rows[0].n).toBe(0)
  })

  it('真实 platform 迁移目录：001_platform.sql 应用后 platform.tenant 表存在', async () => {
    // 本地 PG 跨会话存活：前次已应用则幂等跳过，断言同样成立
    await runMigrations(pool, 'platform', serverMigrationsDir)
    const t = await pool.query<{ ok: boolean }>(
      "select to_regclass('platform.tenant') is not null as ok",
    )
    expect(t.rows[0].ok).toBe(true)
  })
})
