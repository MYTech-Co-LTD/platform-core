// migrate.ts — 按模块记账的 SQL 迁移执行器（platform schema 与各模块 migrations/ 共用）
//
// 约定（计划 Task 11/15）：
//   - 记账表 platform.schema_migrations(module, version) 主键去重 → **重跑幂等**；
//   - 全程持一把**跨进程**的 session 级 advisory lock → **并发安全**（#84）。
//     这是两件事，别把前者读成后者：主键去重只保证「同一个文件不会记两次账」（串行重跑没事），
//     挡不住两个调用者**同时**读到「未应用」再各跑一遍 —— 那时后提交的那个会撞主键。
//   - 取锁是**有界**的（`pg_try_advisory_lock` + 定间隔重试，见下方三个常数）：拿不到就**吵闹地等**，
//     到点仍拿不到即**抛错**，绝不静默继续。为什么要这样（评审 N1）：取锁路径在**进程启动期**
//     （app.ts 的 fail-fast 之前），若用会无限等待的 `pg_advisory_lock`，锁被长期占住时的症状是
//     「服务永远起不来、日志一行没有」，直到部署超时——比没有锁还难排障。
//   - dir 下 *.sql 按文件名排序（lexicographic，版本号习惯零填充），未记账者逐个执行；
//   - 每个文件一个事务：执行 SQL + 记账同生共死，失败回滚且不记账；
//   - 目录不存在静默跳过（装载器对无 migrations/ 的模块零负担）；ENOENT 之外照抛；
//   - version = 文件名去掉 .sql；
//   - 迁移 SQL 自带 `create schema if not exists <id>`（不引入 __MODULE__ 占位符，demo 模块示范）。
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'

/** 迁移锁的键（advisory lock 全局编号空间里的**固定常量**）。
 *
 * 为什么必须固定：advisory lock 只在 key 相同时才互斥 —— key 若随 module 或进程变化，
 * 两个调用者就各锁各的，等于没锁。所以这里刻意**不**按 module 分键：一个键串行化所有模块的
 * 迁移（只在启动期跑一次，代价可忽略），顺带把「两个模块并发在全新库上建表」的 pg 系统目录
 * 竞态（pg_namespace_nspname_index / pg_type_typname_nsp_index）一并挡掉。
 *
 * 为什么用 hashtext 而不是写死 bigint：hashtext 由**服务端**求值，同一个库的所有客户端
 * （另一个进程、另一种语言的驱动都算）算出的是同一个值，不存在「双方 key 不同 ⇒ 锁形同虚设」；
 * 写成字符串也比魔数自解释。键的语义只要求「同一个记账表 → 同一个键」，不要求跨库可移植。
 *
 * ⚠️ 本键走的是**单参 64 位** advisory lock 空间（评审 N2，实测）：`hashtext` 返回 int4，
 *    被隐式提升为 int8，命中的是 `pg_advisory_lock(bigint)` 这个重载。PostgreSQL 把
 *    **单参 (bigint)** 与 **双参 (int, int)** 当作两个**不重叠**的锁空间 —— 实测在同一把键上
 *    `pg_try_advisory_lock(hashtext($1))` 与 `pg_try_advisory_lock(hashtext($1)::int, 0)`
 *    **两把都能拿到**（都返回 true）。
 *    ⇒ 将来任何人（或别的服务）若改用**双参**形式加「同一语义」的锁，**不会**与本锁互斥，
 *      而且失败是**静默**的（不报错，只是两个迁移者各跑各的）。
 *      要加同语义的锁，必须也用**单参**形式、且键相同。 */
export const MIGRATION_LOCK_KEY = 'platform.schema_migrations'

/** 取锁重试的间隔（毫秒）。2s 够密——部署超时按分钟计，而日志不会被刷屏。 */
export const MIGRATION_LOCK_RETRY_INTERVAL_MS = 2_000

/** 取锁的**等待上限**（毫秒）：等满即抛错，绝不静默继续。
 *
 * 60s 的取法：既覆盖「另一个实例正跑着一批迁移」的正常重叠（迁移是秒级），又远小于任何
 * 部署/readiness 超时 ⇒ 失败以「取锁超时」的面目出现在日志里，而不是以「部署超时、
 * 日志一行没有」的面目出现在运维面前（评审 N1 要的正是这个置换）。 */
export const MIGRATION_LOCK_TIMEOUT_MS = 60_000

/** 取锁期间隔几次重试补一条告警（按默认间隔 = 每 10s 一条）：首次必打，之后按此节流。 */
const LOCK_WARN_EVERY_N_ATTEMPTS = 5

/** `runMigrations` 的可注入项——**只为测试**留口子：默认值就是生产口径。 */
export interface RunMigrationsOptions {
  /** 覆盖取锁重试间隔（默认 {@link MIGRATION_LOCK_RETRY_INTERVAL_MS}）。 */
  lockRetryIntervalMs?: number
  /** 覆盖取锁等待上限（默认 {@link MIGRATION_LOCK_TIMEOUT_MS}）。 */
  lockTimeoutMs?: number
  /** 取锁告警的出口（默认 `console.warn`；测试注入以捕获，避免污染输出）。 */
  warn?: (message: string) => void
}

/** 有界睡眠。不用 `.unref()`：启动期这条路径必须把事件循环撑住，否则进程会提前退出。 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 锁键的**可诊断**写法：带上服务端算出的 hashtext 数值，排障时可直接贴进 psql 查 `pg_locks`。 */
async function describeLockKey(client: PoolClient): Promise<string> {
  try {
    const { rows } = await client.query<{ k: number }>('select hashtext($1) as k', [MIGRATION_LOCK_KEY])
    if (rows[0]) return `${MIGRATION_LOCK_KEY}（hashtext=${rows[0].k}）`
  } catch {
    // 连接已坏（或正被中断）时别让诊断语句把真正要报的错盖掉——降级成只有字符串键。
  }
  return MIGRATION_LOCK_KEY
}

/** 有界取锁：**拿到返回 true，等满上限仍拿不到返回 false**（调用方负责抛出）。 */
async function acquireMigrationLockBounded(
  client: PoolClient,
  { lockRetryIntervalMs, lockTimeoutMs, warn }: Required<RunMigrationsOptions>,
): Promise<boolean> {
  const startedAt = Date.now()
  let attempts = 0
  for (;;) {
    // pg_try_advisory_lock 不阻塞：拿不到立刻回 false ⇒ 等待节奏完全由我们掌握（这才有「上限」可言）。
    const res = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as locked',
      [MIGRATION_LOCK_KEY],
    )
    if (res.rows[0]?.locked === true) return true

    attempts += 1
    const waitedMs = Date.now() - startedAt
    // 首次必打：排障的人要的是「卡在哪」，而不是「什么都没发生」（评审 N1 的症状就是后者）。
    if (attempts === 1) {
      warn(
        `[migrate] 等待 migration advisory lock（${MIGRATION_LOCK_KEY}）…`
        + `已被占 ${waitedMs}ms；每 ${lockRetryIntervalMs}ms 重试，上限 ${lockTimeoutMs}ms`,
      )
    } else if (attempts % LOCK_WARN_EVERY_N_ATTEMPTS === 0) {
      warn(
        `[migrate] 仍在等待 migration advisory lock（${MIGRATION_LOCK_KEY}）：`
        + `已等 ${waitedMs}ms / 上限 ${lockTimeoutMs}ms（第 ${attempts} 次重试）`,
      )
    }
    if (waitedMs >= lockTimeoutMs) return false
    await sleep(Math.min(lockRetryIntervalMs, lockTimeoutMs - waitedMs))
  }
}

/** @returns 本次新应用的 version 列表（已应用/无迁移 → 空数组） */
export async function runMigrations(
  pool: Pool,
  module: string,
  dir: string,
  options: RunMigrationsOptions = {},
): Promise<string[]> {
  const { lockRetryIntervalMs, lockTimeoutMs, warn } = {
    lockRetryIntervalMs: options.lockRetryIntervalMs ?? MIGRATION_LOCK_RETRY_INTERVAL_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS,
    warn: options.warn ?? ((message: string) => console.warn(message)),
  }

  // 锁持在**一条专用连接**上，且整段迁移都走它（不再 pool.query / 每文件另取连接）：
  //   ① advisory lock 是 **session 级**的 —— 走 pool.query 每次可能拿到不同连接，锁会加在
  //      一条连接上、解锁试在另一条上，当场失效（这是本修法最容易写错的一点）；
  //   ② 正文也走这条连接，是为了池上限为 1 时不出现「持锁连接 + 再要一条」的自锁死。
  const client = await pool.connect()
  let held = false
  try {
    // ③ 取锁**先于一切**（连下面这一步的建表 DDL 也是竞态面），并覆盖整个
    //    「读已应用集合 → 逐个执行 → 逐个记账」区间 —— 竞态窗口正是这段区间，
    //    只包住 insert 是挡不住的（读发生在更早）。并发调用者在这里排队，
    //    后到的等前一个提交完再往下走，读到的就是最新状态。
    //
    //    **有界**：等满上限仍拿不到就抛错，绝不静默往下走（静默继续 = 两个迁移者同时跑
    //    同一批 SQL = 退回 #84 的原始缺陷；而无限等待 = 启动期静默挂死，见文件头注释）。
    held = await acquireMigrationLockBounded(client, { lockRetryIntervalMs, lockTimeoutMs, warn })
    if (!held) {
      const key = await describeLockKey(client)
      throw new Error(
        `[migrate] 等待 migration advisory lock 超时：已等 ${lockTimeoutMs}ms`
        + `（每 ${lockRetryIntervalMs}ms 重试一次）仍拿不到锁键 ${key}。\n`
        + '  占用方可能是另一个正在迁移的实例，或一个手工 psql 会话'
        + '（客户端已退出、后端仍在跑长语句时，锁会比客户端活得久）。\n'
        + '  本进程**拒绝在未持锁的情况下继续迁移**：那样两个迁移者会同时执行同一批 SQL，#84 正是这个缺陷。\n'
        + "  诊断：select pid, state, query from pg_stat_activity;"
        + " 或 select * from pg_locks where locktype = 'advisory';",
      )
    }

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
    //    只在**确实持锁**时解：没持锁还去 unlock 会返回 false（不报错），但那是「本进程以为
    //    自己持着锁」的信号，留着只会掩盖上面 `held` 判断写错这类缺陷（评审 N4 的同款观察）。
    if (held) {
      await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]).catch(() => {})
    }
    client.release()
  }
}
