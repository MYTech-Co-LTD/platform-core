// migrate.ts — 按模块记账的 SQL 迁移执行器（platform schema 与各模块 migrations/ 共用）
//
// 约定（计划 Task 11/15）：
//   - 记账表 platform.schema_migrations(module, version) 主键去重 → **重跑幂等**；
//   - 全程持一把**跨进程**的 session 级 advisory lock → **并发安全**（#84）。
//     这是两件事，别把前者读成后者：主键去重只保证「同一个文件不会记两次账」（串行重跑没事），
//     挡不住两个调用者**同时**读到「未应用」再各跑一遍 —— 那时后提交的那个会撞主键。
//   - dir 下 *.sql 按文件名排序（lexicographic，版本号习惯零填充），未记账者逐个执行；
//   - 每个文件一个事务：执行 SQL + 记账同生共死，失败回滚且不记账；
//   - 目录不存在静默跳过（装载器对无 migrations/ 的模块零负担）；ENOENT 之外照抛；
//   - version = 文件名去掉 .sql；
//   - 迁移 SQL 自带 `create schema if not exists <id>`（不引入 __MODULE__ 占位符，demo 模块示范）。
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'

/** 迁移锁的键（advisory lock 全局编号空间里的**固定常量**）。
 *
 * 为什么必须固定：advisory lock 只在 key 相同时才互斥 —— key 若随 module 或进程变化，
 * 两个调用者就各锁各的，等于没锁。所以这里刻意**不**按 module 分键：一个键串行化所有模块的
 * 迁移（只在启动期跑一次，代价可忽略），顺带把「两个模块并发在全新库上建表」的 pg 系统目录
 * 竞态（pg_namespace_nspname_index / pg_type_typname_nsp_index）一并挡掉。
 *
 * 为什么用 hashtext 而不是写死 bigint：hashtext 由**服务端**求值，同一个库的所有客户端
 * （另一个进程、另一种语言的驱动都算）算出的是同一个值，不存在「双方 key 不同 ⇒ 锁形同虚设」；
 * 写成字符串也比魔数自解释。键的语义只要求「同一个记账表 → 同一个键」，不要求跨库可移植。 */
const MIGRATION_LOCK_KEY = 'platform.schema_migrations'

/** @returns 本次新应用的 version 列表（已应用/无迁移 → 空数组） */
export async function runMigrations(pool: Pool, module: string, dir: string): Promise<string[]> {
  // 锁持在**一条专用连接**上，且整段迁移都走它（不再 pool.query / 每文件另取连接）：
  //   ① pg_advisory_lock 是 **session 级**的 —— 走 pool.query 每次可能拿到不同连接，锁会加在
  //      一条连接上、解锁试在另一条上，当场失效（这是本修法最容易写错的一点）；
  //   ② 正文也走这条连接，是为了池上限为 1 时不出现「持锁连接 + 再要一条」的自锁死。
  const client = await pool.connect()
  try {
    // ③ 取锁**先于一切**（连下面这一步的建表 DDL 也是竞态面），并覆盖整个
    //    「读已应用集合 → 逐个执行 → 逐个记账」区间 —— 竞态窗口正是这段区间，
    //    只包住 insert 是挡不住的（读发生在更早）。并发调用者在这里排队，
    //    后到的等前一个提交完再往下走，读到的就是最新状态。
    await client.query('select pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY])

    // ④ 记账表先于一切存在（幂等 DDL，每次调用零成本命中 if not exists）
    await client.query(`
      create schema if not exists platform;
      create table if not exists platform.schema_migrations(
        module text not null,
        version text not null,
        applied_at timestamptz not null default now(),
        primary key(module, version)
      );
    `)

    // ⑤ 列目录：不存在 → 静默跳过；其余错误（权限/非目录）照抛
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const files = entries.filter((f) => f.endsWith('.sql')).sort()

    const appliedRows = await client.query<{ version: string }>(
      'select version from platform.schema_migrations where module = $1',
      [module],
    )
    const done = new Set(appliedRows.rows.map((r) => r.version))

    // ⑥ 未记账者逐个：单事务内 执行 + 记账
    const ran: string[] = []
    for (const file of files) {
      const version = file.slice(0, -'.sql'.length)
      if (done.has(version)) continue
      const sql = await readFile(path.join(dir, file), 'utf8')
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
      }
    }
    return ran
  } finally {
    // ⑦ 异常路径也必须放锁：session 级 advisory lock **不随事务回滚释放**，漏放一次就把后续
    //    所有迁移（含别进程的启动期迁移）永久堵死。解锁失败（连接已断）吞掉即可 —— 那种情况下
    //    服务端会随 session 结束自行释放，而原始错误更值得往上抛。
    await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]).catch(() => {})
    client.release()
  }
}
