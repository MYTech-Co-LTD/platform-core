// migrate.ts — 按模块记账的 SQL 迁移执行器（platform schema 与各模块 migrations/ 共用）
//
// 约定（计划 Task 11/15）：
//   - 记账表 platform.schema_migrations(module, version) 主键去重 → 重跑幂等；
//   - dir 下 *.sql 按文件名排序（lexicographic，版本号习惯零填充），未记账者逐个执行；
//   - 每个文件一个事务：执行 SQL + 记账同生共死，失败回滚且不记账；
//   - 目录不存在静默跳过（装载器对无 migrations/ 的模块零负担）；ENOENT 之外照抛；
//   - version = 文件名去掉 .sql；
//   - 迁移 SQL 自带 `create schema if not exists <id>`（不引入 __MODULE__ 占位符，demo 模块示范）。
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'

/** @returns 本次新应用的 version 列表（已应用/无迁移 → 空数组） */
export async function runMigrations(pool: Pool, module: string, dir: string): Promise<string[]> {
  // ① 记账表先于一切存在（幂等 DDL，每次调用零成本命中 if not exists）
  await pool.query(`
    create schema if not exists platform;
    create table if not exists platform.schema_migrations(
      module text not null,
      version text not null,
      applied_at timestamptz not null default now(),
      primary key(module, version)
    );
  `)

  // ② 列目录：不存在 → 静默跳过；其余错误（权限/非目录）照抛
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const files = entries.filter((f) => f.endsWith('.sql')).sort()

  const appliedRows = await pool.query<{ version: string }>(
    'select version from platform.schema_migrations where module = $1',
    [module],
  )
  const done = new Set(appliedRows.rows.map((r) => r.version))

  // ③ 未记账者逐个：单事务内 执行 + 记账
  const ran: string[] = []
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length)
    if (done.has(version)) continue
    const sql = await readFile(path.join(dir, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(sql) // 多语句走简单查询协议（无参数绑定）
      await client.query(
        'insert into platform.schema_migrations(module, version) values ($1, $2)',
        [module, version],
      )
      await client.query('commit')
      ran.push(version)
    } catch (err) {
      await client.query('rollback').catch(() => {}) // 连接级故障时 rollback 可能再抛，吞掉保留原错误
      throw err
    } finally {
      client.release()
    }
  }
  return ran
}
