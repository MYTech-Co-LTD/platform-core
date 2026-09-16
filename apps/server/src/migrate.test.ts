// migrate.test.ts — runMigrations 语义钉死：空目录/目录缺失静默跳过、排序执行+记账、
// 事务回滚不记账、重跑幂等、并发安全（#84）、真实 platform 迁移目录落表。
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

  // ── 并发安全（#84）────────────────────────────────────────────────────────────
  // 缺陷形态：runMigrations 是「读已应用集合 → 逐个插入记账」的 read-then-insert，全程无锁。
  // 两个调用者并发时**都读到「未应用」**，于是同一文件各跑一遍，后提交的那个撞记账表主键。
  // 这里用 Promise.allSettled 直接造出并发，而不是靠时序碰运气。

  /** 把并发用例的失败原因摊平成可读字符串（断言相等时会把 PG 错误码与正文打出来） */
  const failuresOf = (settled: PromiseSettledResult<unknown>[]): string[] =>
    settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => `${(s.reason as { code?: string })?.code}: ${(s.reason as Error)?.message}`)

  it('并发：两个调用者同迁一模块 —— 都成功、每文件只执行一次、记账不重复', async () => {
    const mod = 't_conc'
    usedModules.push(mod)
    cleanupSqls.push('drop schema if exists t_conc cascade')
    // 本用例只钉**记账表主键**那条竞态（issue #84 的报错面）。为避免被另一条竞态抢先——
    // 并发建表会撞 pg 系统目录（pg_type_typname_nsp_index），红得比主键更早、把证据带偏——
    // 这里把记账表与用例要碰的 relation **全部预热**：正文里的 if not exists 全成纯查表 no-op，
    // 于是唯一的冲突点只剩 insert into platform.schema_migrations(...)。DDL 竞态由下一个用例覆盖。
    await runMigrations(pool, 't_conc_boot', await tmpModuleDir())
    await pool.query(
      'create schema if not exists t_conc;'
      + ' create sequence t_conc.runs;'
      + ' create table if not exists t_conc.a(id int);'
      + ' create table if not exists t_conc.b(id int);',
    )

    const dir = await tmpModuleDir({
      // pg_sleep 把事务撑开 1s：「双方都读完 done 集合」的窗口从微秒级拉成秒级，
      // 复现不再靠调度运气（没有它，先跑的调用者可能在另一方读取前就提交，窗口自然消失）。
      // nextval 计数同理不受回滚影响，是「正文被执行过几次」的可靠证据。
      '001_slow.sql': [
        'create schema if not exists t_conc;',
        'create table if not exists t_conc.a(id int);',
        "select nextval('t_conc.runs');",
        'select pg_sleep(1);',
      ].join('\n'),
      '002_fast.sql': [
        'create table if not exists t_conc.b(id int);',
        "select nextval('t_conc.runs');",
      ].join('\n'),
    })

    const settled = await Promise.allSettled([
      runMigrations(pool, mod, dir),
      runMigrations(pool, mod, dir),
    ])

    // 实测 2026-09-16（修前）：一方 rejected，reason.code === '23505'
    //   duplicate key value violates unique constraint "schema_migrations_pkey"
    expect(failuresOf(settled)).toEqual([])

    const [ranA, ranB] = settled.map((s) => (s as PromiseFulfilledResult<string[]>).value)
    // 每个文件恰好被一个调用者应用：并集 = 全部版本、交集 = 空
    expect([...ranA!, ...ranB!].sort()).toEqual(['001_slow', '002_fast'])
    expect(ranA!.filter((v) => ranB!.includes(v))).toEqual([])
    // 记账无重复
    const rows = await pool.query<{ version: string }>(
      'select version from platform.schema_migrations where module = $1 order by version',
      [mod],
    )
    expect(rows.rows.map((r) => r.version)).toEqual(['001_slow', '002_fast'])
    // 文件正文恰好各执行一次（sequence 计数；回滚抹不掉它）
    const seq = await pool.query<{ n: string }>('select last_value as n from t_conc.runs')
    expect(Number(seq.rows[0]!.n)).toBe(2)
  })

  it('并发：非幂等 DDL 不重复执行（重跑会 42P07 建表冲突）', async () => {
    const mod = 't_conc_ddl'
    usedModules.push(mod)
    cleanupSqls.push('drop schema if exists t_conc_ddl cascade')
    await runMigrations(pool, 't_conc_boot', await tmpModuleDir())
    const dir = await tmpModuleDir({
      // 故意**不带** if not exists：正文被执行第二次就是 42P07
      // ⇒ 「两个调用者都 fulfilled」本身即「DDL 各自只跑了一次」的证据。
      '001_ddl.sql': [
        'create schema if not exists t_conc_ddl;',
        'create table t_conc_ddl.a(id int);',
        'select pg_sleep(1);',
      ].join('\n'),
      '002_ddl.sql': 'create table t_conc_ddl.b(id int);',
    })

    const settled = await Promise.allSettled([
      runMigrations(pool, mod, dir),
      runMigrations(pool, mod, dir),
    ])

    // 实测 2026-09-16（修前）：一方 rejected —— 并发建 schema/表撞 pg 系统目录，错误码 23505
    //   duplicate key value violates unique constraint "pg_namespace_nspname_index"
    // （实测到过 pg_namespace_* 与 pg_type_typname_nsp_index 两支；时序不同还可能表现为
    //   42P07 relation already exists —— 三者都是「同一 DDL 被两个调用者各跑了一遍」）
    expect(failuresOf(settled)).toEqual([])
    const ok = await pool.query<{ a: string | null; b: string | null }>(
      "select to_regclass('t_conc_ddl.a')::text as a, to_regclass('t_conc_ddl.b')::text as b",
    )
    expect(ok.rows[0]).toEqual({ a: 't_conc_ddl.a', b: 't_conc_ddl.b' })
  })

  it('真实 platform 迁移目录：001_platform.sql 应用后 platform.tenant 表存在', async () => {
    // 本地 PG 跨会话存活：前次已应用则幂等跳过，断言同样成立
    await runMigrations(pool, 'platform', serverMigrationsDir)
    const t = await pool.query<{ ok: boolean }>(
      "select to_regclass('platform.tenant') is not null as ok",
    )
    expect(t.rows[0].ok).toBe(true)
  })

  it('002：audit 保留 —— prune_audit(days) 只删超期行并返回删除条数', async () => {
    // 该用例自带清理，不污染其他用例：只插自己造的、且 actor 带专用前缀的行
    await pool.query(
      "insert into platform.audit(tenant_id, actor, action, detail, at) values"
      + " (null, 'prune-test-old', 'login.fail', '{}', now() - interval '100 days'),"
      + " (null, 'prune-test-new', 'login.fail', '{}', now())",
    )
    const { rows } = await pool.query<{ n: string }>(
      'select platform.prune_audit(90) as n',
    )
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1) // 至少删掉自己那条超期行
    const left = await pool.query<{ c: string }>(
      "select count(*) as c from platform.audit where actor like 'prune-test-%'",
    )
    expect(Number(left.rows[0]!.c)).toBe(1) // 未超期那条还在
    await pool.query("delete from platform.audit where actor like 'prune-test-%'")
  })
})
