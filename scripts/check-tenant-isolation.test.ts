// @ts-nocheck —— 同被测脚本：`pg` 经 createRequire 锚到 apps/server 解析（见脚本文件头）。
//
// check-tenant-isolation 的 fixtures 测试（issue #77）。
//
// 黑盒：spawn 脚本 CLI，断言退出码与输出行——门禁的对外契约就是这两样。
//
// **fixture 与别的门禁脚本不同**：那几个的 fixture 是临时目录（判据在文本里），
// 本门禁是**真库对账**（判据在 `information_schema` 里），所以 fixture = **临时 schema**，
// 由测试自建自清。这不只是形式选择：造 fixture 的过程本身就在验证「真库当真值」这条设计
// ——比如「建表无 org、后续迁移补上」这种增量形状，在临时 schema 里就是两条 DDL。
//
// ⚠️ 需要 DATABASE_URL（与被测脚本一致）。CI 的 unit job 恒有 postgres service + DATABASE_URL，
//    故该组在 CI 必跑；本地只跑 `pnpm test:guard` 而没导出该变量时整组跳过。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const script = join(repoRoot, 'scripts', 'check-tenant-isolation.mjs')
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))

const DATABASE_URL = process.env.DATABASE_URL
const SCHEMA = `guard_fixture_${Math.random().toString(36).slice(2, 10)}`

const tmpRoots: string[] = []
function fixtureModules(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tenant-gate-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

interface RunResult { status: number; stdout: string; stderr: string }

/** 跑脚本 CLI。schemas 固定为本组临时 schema，避免受真实仓当前状态影响。 */
function run(modulesDir: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, '--schemas', SCHEMA, '--modules-dir', modulesDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL } },
    )
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = /** @type {any} */ (e)
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe.skipIf(!DATABASE_URL)('check-tenant-isolation（真库对账）', () => {
  /** 建临时 schema 并执行给定 DDL。 */
  async function withSchema(ddl: string[]): Promise<void> {
    const { Pool } = requireFromServer('pg')
    const pool = new Pool({ connectionString: DATABASE_URL })
    try {
      await pool.query(`drop schema if exists ${SCHEMA} cascade`)
      await pool.query(`create schema ${SCHEMA}`)
      for (const stmt of ddl) await pool.query(stmt)
    } finally {
      await pool.end()
    }
  }

  afterAll(async () => {
    if (DATABASE_URL) {
      const { Pool } = requireFromServer('pg')
      const pool = new Pool({ connectionString: DATABASE_URL })
      try { await pool.query(`drop schema if exists ${SCHEMA} cascade`) } finally { await pool.end() }
    }
    for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
  })

  const noModules = () => fixtureModules({})

  it('合规：表带 org not null ⇒ exit 0', async () => {
    await withSchema([`create table ${SCHEMA}.ok (id serial primary key, org text not null)`])
    const r = run(noModules())
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-tenant-isolation: OK')
  })

  it('T1：表缺 org ⇒ exit 1（报出表名与规则）', async () => {
    await withSchema([`create table ${SCHEMA}.leaky (id serial primary key, body text)`])
    const r = run(noModules())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`${SCHEMA}.leaky`)
    expect(r.stderr).toContain('[T1]')
  })

  it('T2：org 可空 ⇒ exit 1（正典要的是 org text not null）', async () => {
    await withSchema([`create table ${SCHEMA}.soft (id serial primary key, org text)`])
    const r = run(noModules())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`${SCHEMA}.soft`)
    expect(r.stderr).toContain('[T2]')
  })

  it('★ 增量迁移形状：建表无 org、后续 alter 补上 ⇒ exit 0（这条是本门禁存在的理由）', async () => {
    // 照 modules/demo 的真实形状：001 建表没有 org，003 才补。
    // 若门禁按【单个迁移文件】判，「create table 必须含 org」会把本仓自己的参考模块判红。
    await withSchema([
      `create table ${SCHEMA}.grown (id serial primary key, body text)`,
      `alter table ${SCHEMA}.grown add column org text`,
      `update ${SCHEMA}.grown set org = '' where org is null`,
      `alter table ${SCHEMA}.grown alter column org set not null`,
    ])
    const r = run(noModules())
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-tenant-isolation: OK')
  })

  it('豁免：缺 org 但有 -- global-table: 标记 ⇒ exit 0', async () => {
    await withSchema([`create table ${SCHEMA}.dict (id serial primary key, code text)`])
    const dir = fixtureModules({
      'demo/migrations/001_dict.sql':
        `-- global-table: ${SCHEMA}.dict — 跨租户共享的字典表，无租户语义\n`
        + `create table if not exists ${SCHEMA}.dict(id serial primary key, code text);\n`,
    })
    const r = run(dir)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('1 处全局表豁免')
  })

  it('T3：豁免标记指向不存在的表 ⇒ exit 1（防标记腐烂）', async () => {
    await withSchema([`create table ${SCHEMA}.ok (id serial primary key, org text not null)`])
    const dir = fixtureModules({
      'demo/migrations/001_gone.sql': `-- global-table: ${SCHEMA}.renamed_away — 表早改名了\n`,
    })
    const r = run(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`${SCHEMA}.renamed_away`)
    expect(r.stderr).toContain('[T3]')
  })
})
