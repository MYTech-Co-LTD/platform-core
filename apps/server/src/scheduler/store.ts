// store.ts — 排班与台账的 SQL 面（无业务判断；判断在 loop / 健康面里）。
//
// 为什么 claimDue 是「事务内 SELECT … FOR UPDATE SKIP LOCKED + 逐行 JS 计算 + UPDATE + COMMIT」：
//   next_run_at 的下一次值必须由 cron 解析算出（SQL 算不了），所以不能像伪代码那样一条 UPDATE 搞定；
//   但**锁必须覆盖「读到期行 → 算出下一次 → 写回 → 建 running 行」整段**，否则两个副本会读到同一格
//   各算一遍。计算是纯 JS、微秒级，放在事务里安全。**spawn 一律在 COMMIT 之后**——本层只碰数据。
//
// 不变量：
//   ① 同一格（schedule × occurrence）只能被 claim 一次；
//      schedule 触发的 claim 靠 next_run_at 前推「消耗」这一格，
//      重试的 claim 靠清空 retry_at + retry_occurrence「消耗」这次重试。
//   ② 重试不改 next_run_at：重试与下一格是两件事，各自的时间线互不覆盖；
//      且**重试槽只属于排班侧**（occurrence 存在 retry_occurrence，不从 job_run 反查，
//      否则会被并发/手动行劫持）。
//   ③ 台账与 claim 同生共死：claim 事务内就插好 status='running' 的 run 行（返回 runId），
//      spawn 失败/进程崩溃后由 reapStale 兜底判 timeout；终态只能由 finishRun 从 running 回填。
//   ④ 同一 schedule 同时只有一条 running 行：claim（两种触发）都在 SQL 里排除已有 running 的排班，
//      该格不消费、下一拍再来。
//   ⑤ 删排班一律软删（deleted_at）：job_run 是审计，不能被级联带走；两条 claim 路径都排除软删行。
import type { Pool, PoolClient } from 'pg'

export interface ClaimedJob {
  scheduleId: number
  key: string
  occurrence: Date
  attempt: number
  params: Record<string, unknown>
  timeoutMs: number
  maxAttempts: number
  isRetry: boolean
  ownerOrg: string | null
  ownerNamespace: string | null
  /** 本次运行在 job_run 的行 id：claim 事务内已建好 running 行，终态用 finishRun 回填。 */
  runId: number
}

export interface RunOutcome {
  status: 'ok' | 'failed' | 'timeout' | 'skipped'
  exitCode?: number | null
  durationMs?: number
  outputTail?: string
  error?: string
}

type NextFn = (cron: string, timezone: string, from: Date) => Date

interface Row {
  id: string
  key: string
  cron: string
  timezone: string
  params: unknown
  timeout_ms: number
  max_attempts: number
  expected_interval_secs: number
  next_run_at: Date | null
  retry_at: Date | null
  retry_occurrence: Date | null
  retry_attempt: number
  owner_org: string | null
  owner_namespace: string | null
}

const SCHED_COLS = `s.id,s.key,s.cron,s.timezone,s.params,s.timeout_ms,s.max_attempts,
  s.expected_interval_secs,s.next_run_at,s.retry_at,s.retry_occurrence,s.retry_attempt,
  s.owner_org,s.owner_namespace`

function toClaimed(
  r: Row,
  p: { occurrence: Date; attempt: number; isRetry: boolean; runId: number },
): ClaimedJob {
  return {
    scheduleId: Number(r.id),
    key: r.key,
    occurrence: p.occurrence,
    attempt: p.attempt,
    params: (r.params ?? {}) as Record<string, unknown>,
    timeoutMs: r.timeout_ms,
    maxAttempts: r.max_attempts,
    isRetry: p.isRetry,
    ownerOrg: r.owner_org,
    ownerNamespace: r.owner_namespace,
    runId: p.runId,
  }
}

/** 建 running 行（claim 事务内调用 ⇒ 与「消耗这一格」同生共死）。 */
async function insertRunning(
  client: PoolClient,
  r: Row,
  occurrence: Date,
  attempt: number,
  runnerId: string,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `insert into platform.job_run
       (schedule_id,key,occurrence,owner_org,owner_namespace,params_snapshot,trigger,status,attempt,started_at,runner_id)
     values ($1,$2,$3,$4,$5,$6::jsonb,'schedule','running',$7, now(), $8) returning id`,
    [r.id, r.key, occurrence, r.owner_org, r.owner_namespace,
      JSON.stringify(r.params ?? {}), attempt, runnerId],
  )
  return Number(rows[0].id)
}

/** 抢到期排班（含到期的重试）。返回即代表这些格已被本进程独占，且 running 行已落库。 */
export async function claimDue(
  pool: Pool,
  limit: number,
  now: Date,
  next: NextFn,
  opts: { runnerId?: string; keys?: readonly string[] } = {},
): Promise<ClaimedJob[]> {
  const runnerId = opts.runnerId ?? 'scheduler'
  const keys = opts.keys ?? null
  const client = await pool.connect()
  try {
    await client.query('begin')
    // 配置错（到期的重试却没有原格 occurrence）先清槽、提交后再抛：若在事务内直接抛，
    // 清槽会随回滚消失 ⇒ 每个 tick 都撞同一行。清槽 = 丢掉这次重试（它已无法还原到原格）。
    const bad = await client.query<{ key: string }>(
      `update platform.job_schedule
          set retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=now()
        where enabled and deleted_at is null
          and retry_at is not null and retry_at <= $1
          and retry_occurrence is null
          and ($2::text[] is null or key = any($2::text[]))
        returning key`,
      [now, keys],
    )
    if (bad.rows.length > 0) {
      const keys = bad.rows.map((r) => r.key).join(', ')
      await client.query('commit')
      throw new Error(`claimDue: 重试槽缺 retry_occurrence，已清空（${keys}）`)
    }

    const { rows } = await client.query<Row>(
      `select ${SCHED_COLS} from platform.job_schedule s
        where s.enabled
          and s.deleted_at is null
          and ($3::text[] is null or s.key = any($3::text[]))
          and not exists (select 1 from platform.job_run r
                           where r.schedule_id = s.id and r.status = 'running')
          and (
            (s.retry_at is not null and s.retry_at <= $2 and s.retry_occurrence is not null)
            or (s.retry_at is null and s.next_run_at is not null and s.next_run_at <= $2))
        order by coalesce(s.retry_at, s.next_run_at)
        limit $1
        for update of s skip locked`,
      [limit, now, keys],
    )
    const out: ClaimedJob[] = []
    for (const r of rows) {
      if (r.retry_at) {
        // 重试：occurrence 取自 retry_occurrence（排班侧自己的槽），**不动 next_run_at**。
        const occurrence = new Date(r.retry_occurrence as Date)
        const attempt = r.retry_attempt + 1
        await client.query(
          `update platform.job_schedule
              set retry_at=null, retry_occurrence=null, retry_attempt=$2, updated_at=now()
            where id=$1`,
          [r.id, attempt],
        )
        const runId = await insertRunning(client, r, occurrence, attempt, runnerId)
        out.push(toClaimed(r, { occurrence, attempt, isRetry: true, runId }))
      } else {
        const occurrence = new Date(r.next_run_at as Date)
        const from = occurrence.getTime() > now.getTime() ? occurrence : now
        const nextAt = next(r.cron, r.timezone, from)
        await client.query(
          `update platform.job_schedule
              set next_run_at=$2, retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=now()
            where id=$1`,
          [r.id, nextAt],
        )
        const runId = await insertRunning(client, r, occurrence, 1, runnerId)
        out.push(toClaimed(r, { occurrence, attempt: 1, isRetry: false, runId }))
      }
    }
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 手动触发只入队（trigger='manual'）；执行仍在 worker 进程。
 *
 *  **按 schedule 去重**：先锁排班行（`for update of s skip locked`，与 claimDue 的排班锁串行），
 *  一个排班最多返回一条 ⇒ 同 schedule 的多条 queued 每拍只跑一条，其余保持 queued 留给下一拍。
 *  （`DISTINCT ON` 与 `FOR UPDATE` 在 PostgreSQL 不能共存，所以用「锁排班行」天然去重。） */
export async function claimQueuedManual(
  pool: Pool,
  limit: number,
  now: Date,
  opts: { runnerId?: string; keys?: readonly string[] } = {},
): Promise<ClaimedJob[]> {
  const runnerId = opts.runnerId ?? 'scheduler'
  const keys = opts.keys ?? null
  const client = await pool.connect()
  const out: ClaimedJob[] = []
  try {
    await client.query('begin')
    // ① 锁排班行：`not exists running` ⇒ 同 schedule 已有在跑的（无论谁触发）本拍跳过。
    //    **不看 `s.enabled`**：手动排队行是运维显式动作，启停只约束自动排班（claimDue）；
    //    切流程序正是「登记（disabled）→ 手动跑一次比对 → 关 openship → 再启用」。
    //    若这里筛 enabled，disabled 排班的手动 queued 行会永远不被领取（最终被 reapQueued 判 timeout），
    //    端点返回的 200「已排队」就成了谎话。
    //    **但 deleted_at 必须筛**：软删是「这个排班不存在了」，不是「停用」——已删排班的手动
    //    queued 行不能替它跑（删后残留的排队行留给 reapQueued 收口）。
    const sched = await client.query<Row>(
      `select ${SCHED_COLS}
         from platform.job_schedule s
        where s.deleted_at is null
          and ($2::text[] is null or s.key = any($2::text[]))
          and exists (select 1 from platform.job_run r
                       where r.schedule_id = s.id and r.status = 'queued'
                         and r.trigger = 'manual')
          and not exists (select 1 from platform.job_run x
                           where x.schedule_id = s.id and x.status = 'running')
        order by s.id
        limit $1
        for update of s skip locked`,
      [limit, keys],
    )
    if (sched.rows.length === 0) {
      await client.query('commit')
      return out
    }
    // ② 拿到锁后按新快照复查 running：若期间有运行启动，本拍跳过该排班（queued 原样保留）。
    const ids = sched.rows.map((r) => r.id)
    const stillFree = await client.query<{ id: string }>(
      `select s.id from platform.job_schedule s
        where s.id = any($1::bigint[])
          and s.deleted_at is null
          and not exists (select 1 from platform.job_run x
                           where x.schedule_id = s.id and x.status = 'running')`,
      [ids],
    )
    const free = new Set(stillFree.rows.map((r) => String(r.id)))
    for (const s of sched.rows) {
      if (!free.has(String(s.id))) continue
      // ③ 每个排班只取最老的一条 **trigger='manual'** 的 queued 行；剩余保持 queued，下一拍再来。
      //    显式限定 trigger：queued 是「未来其它 writer」也可能写的状态，本函数只认手动行。
      const { rows } = await client.query<{ id: string; occurrence: Date; params_snapshot: unknown }>(
        `select id, occurrence, coalesce(params_snapshot, $2::jsonb) as params_snapshot
           from platform.job_run
          where schedule_id = $1 and status = 'queued' and trigger = 'manual'
          order by id
          limit 1
          for update skip locked`,
        [s.id, JSON.stringify(s.params ?? {})],
      )
      const run = rows[0]
      if (!run) continue
      await client.query(
        `update platform.job_run
            set status='running', started_at=$2, attempt=1, params_snapshot=$3::jsonb, runner_id=$4
          where id=$1`,
        [run.id, now, JSON.stringify(run.params_snapshot ?? {}), runnerId],
      )
      const job = toClaimed(s, {
        occurrence: new Date(run.occurrence), attempt: 1, isRetry: false, runId: Number(run.id),
      })
      job.params = (run.params_snapshot ?? {}) as Record<string, unknown>
      out.push(job)
    }
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 回填运行终态。行由 claim（两种触发）预先建好且为 running，**不新建行**。
 *  `where status='running'` 守卫：已被 reapStale 判 timeout 的行不许被迟到的回调覆盖。 */
export async function finishRun(pool: Pool, runId: number, o: RunOutcome): Promise<void> {
  await pool.query(
    `update platform.job_run set status=$2, finished_at=now(), exit_code=$3, duration_ms=$4,
       output_tail=$5, error=$6 where id=$1 and status='running'`,
    [runId, o.status, o.exitCode ?? null, o.durationMs ?? null, o.outputTail ?? null, o.error ?? null],
  )
}

/** 安排一次重试（只动重试槽，绝不碰 next_run_at）。occurrence 原样存进 retry_occurrence。 */
export async function scheduleRetry(
  pool: Pool,
  scheduleId: number,
  occurrence: Date,
  attempt: number,
  at: Date,
): Promise<void> {
  await pool.query(
    `update platform.job_schedule
        set retry_at=$2, retry_occurrence=$3, retry_attempt=$4, updated_at=now()
      where id=$1`,
    [scheduleId, at, occurrence, attempt],
  )
}

export async function clearRetry(pool: Pool, scheduleId: number): Promise<void> {
  await pool.query(
    `update platform.job_schedule
        set retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=now()
      where id=$1`,
    [scheduleId],
  )
}

/** 软删排班：`job_run` 是审计历史（排班删了，跑过的记录仍要可查），不能被级联带走 ⇒ 一律软删。
 *
 *  同时清掉**全部触发槽**（next_run_at + 重试三件套）并置 `enabled=false`：删掉之后它再也
 *  不该被任何 claim 路径看见。`where deleted_at is null` 让**重复调用幂等**——零行更新、
 *  不报错，且 `deleted_at` 不会被后来的 now 覆盖（审计要的是首次删除时刻）。 */
export async function softDeleteSchedule(pool: Pool, id: number, now: Date): Promise<void> {
  await pool.query(
    `update platform.job_schedule
        set deleted_at=$2, enabled=false, next_run_at=null,
            retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=$2
      where id=$1 and deleted_at is null`,
    [id, now],
  )
}

/**
 * 本实例负责的 key 里，当前有多少条 `running`（#2574 派发模式下的并发闸门）。
 *
 * 为什么不能再用进程内 Set：派发模式下「起作业」发生在执行器容器里，派发器把请求发出去就返回，
 * 进程内计数会立刻归零 ⇒ 并发上限形同虚设。```running``` 行是两边共用的唯一事实源。
 */
export async function countRunning(pool: Pool, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from platform.job_run where status='running' and key = any($1::text[])",
    [keys],
  )
  return rows[0]?.n ?? 0
}

/**
 * 高优先车道（10m）是否**即将到期**（B2）：用于给实时车道留槽。
 *
 * 判据只认 `next_run_at`（自动排班）：claim 会立刻把它前推，所以「到期未领」= 真的马上要跑；
 * 已经在跑的不会让这里恒真。重试槽（`retry_at`）不参与——tick 的 maxAttempts=1，没有重试面。
 */
export async function hasDueSoon(pool: Pool, keys: string[], now: Date, windowMs: number): Promise<boolean> {
  if (keys.length === 0) return false
  const { rows } = await pool.query(
    `select 1 from platform.job_schedule
      where source='system' and enabled and deleted_at is null
        and key = any($1::text[])
        and next_run_at is not null
        and next_run_at <= $2::timestamptz + make_interval(secs => $3::double precision)
      limit 1`,
    [keys, now, windowMs / 1000],
  )
  return rows.length > 0
}

export async function hasRunning(pool: Pool, scheduleId: number): Promise<boolean> {
  const { rows } = await pool.query(
    "select 1 from platform.job_run where schedule_id=$1 and status='running' limit 1",
    [scheduleId],
  )
  return rows.length > 0
}

/**
 * 部署排空信号（#2567）：`platform.scheduler_control(key='drain')` 存在且 `value.until_ms` 未过期 ⇒ true。
 *
 * 为什么不是「优雅停机」就够了：`docker stop` 的宽限期由部署方定，openship 只等默认 10s 就 SIGKILL
 * （2026-11-20 实测 `HostConfig.StopTimeout=None`）。所以「别起新作业」必须发生在**部署之前**。
 *
 * 语义细节（都朝「不静默停摆」方向）：
 *   · 行在、`until` 缺失或解析不了 ⇒ **算排空**（信号是 CI 与人写的，宁可少跑一轮也别在部署窗口起作业）；
 *   · 行在、`until` 已过 ⇒ 不算（部署没落地也不会永久停摆）；
 *   · 表不存在（迁移未跑，42P01）⇒ false（此时根本没有信号；抛错会被上层吞成「本拍不 claim」，更糟）。
 */
export async function isDraining(pool: Pool, now: Date): Promise<boolean> {
  let rows: Array<{ until_ms: string | null }>
  try {
    ;({ rows } = await pool.query<{ until_ms: string | null }>(
      "select value->>'until_ms' as until_ms from platform.scheduler_control where key='drain'",
    ))
  } catch (e) {
    // 42P01 = undefined_table：迁移还没跑到（应用单元先起、数据单元后起的那一小段）。
    // 这时**没有**排空信号可言 ⇒ false。绝不能抛：tick 抛错会被上层 catch 成「本拍不 claim」，
    // 效果与排空一样糟，而且台账里看不出原因。
    if ((e as { code?: string }).code === '42P01') return false
    throw e
  }
  if (rows.length === 0) return false
  const raw = rows[0].until_ms
  // 到期时间用 **epoch 毫秒**（`until_ms`）而不是 ISO 串：CI 里写的是 SQL，跨 shell/JSON 层层转义
  // 之后 ISO 串的引号最容易出错；数字串没有引号问题，解析也不依赖实现细节。
  const until = Number(raw)
  if (raw === null || raw === undefined || !Number.isFinite(until)) return true
  return until > now.getTime()
}

/** 回收「running 超时」的僵尸行：阈值取 2× timeout_ms（给正常执行留一倍余量）。 */
export async function reapStale(pool: Pool, now: Date): Promise<number> {
  const { rowCount } = await pool.query(
    `update platform.job_run r set status='timeout', finished_at=$1, error='stale running reaped'
       from platform.job_schedule s
      where r.schedule_id = s.id
        and r.status = 'running'
        and r.started_at < $1::timestamptz - make_interval(secs => 2 * s.timeout_ms / 1000.0)`,
    [now],
  )
  // #2835：**runner 心跳过期** ⇒ 不等 2×timeout 直接回收。部署杀掉 executor 后，它的
  // `running` 行会在 2×timeout（30 分钟档 ⇒ 60 分钟）里一直占槽；启动对账在「executor 没重启」
  // 时又兜不住。心跳每 10s/30s 一拍，5 分钟没拍 = runner 已死。
  // 判据取「**有据可依的过期**」（存在该 runner 的心跳行且已过期），而不是「没有心跳就判死」：
  // 从未写过心跳的 runner（迁移前的 `scheduler-legacy` 行等）继续走上面的 2×timeout 兜底，
  // 不因缺一行心跳被提前误杀。
  // `started_at < now - 1min` 守卫防误杀「刚派发、runner 还没写第一拍」的作业。
  const stale = await pool.query(
    `update platform.job_run r set status='timeout', finished_at=$1, error='runner heartbeat stale'
      where r.status = 'running'
        and r.runner_id is not null
        and r.started_at < $1::timestamptz - interval '1 minute'
        and exists (select 1 from platform.job_heartbeat h
                     where h.id = r.runner_id
                       and h.beat_at < $1::timestamptz - interval '5 minutes')`,
    [now],
  )
  return (rowCount ?? 0) + (stale.rowCount ?? 0)
}

/** 启动对账（#2442）：上一进程起的 runner 已随容器/进程消失，但行还停在 running。
 *  reapStale 要等 2×timeout（长任务 90 分钟 ⇒ 3 小时），期间 hasRunning 恒真、健康判据③把
 *  非终态计数、手动触发 409。启动即收成 timeout 才是事实。
 *  前提：本进程是该库唯一的 scheduler runner（单 worker/实例；两实例各有自己的库）。 */
export async function reapLostRunners(pool: Pool, now: Date, runnerId = 'scheduler'): Promise<number> {
  // ⚠️ **只收自己的**（#2511）：两个单元各跑一个调度者时，全表扫会把**对方正在跑的作业**
  // 判 timeout（2026-11-19 实测风险：数据单元启动那一刻会把应用单元的 running 行收掉，
  // 作业本体还在跑，台账却说超时）。按 runner_id 收口后，启动对账的语义才是它字面说的
  // 「我这个实例上一次化身留下的行」。
  // 迁移前的历史行由 023 迁移统一回填为 'scheduler-legacy'，不会被任何实例收走，
  // 交给 reapStale 按超时收口。
  const { rowCount } = await pool.query(
    `update platform.job_run set status='timeout', finished_at=$1, error='runner lost on worker restart'
      where status='running' and runner_id=$2`,
    [now, runnerId],
  )
  return rowCount ?? 0
}

/** 回收卡住的 `queued` 行。两条**同时**满足才判死（否则会误杀合法排队）：
 *   ① 年龄 > 2 × 该排班的 timeout_ms；
 *   ② 该 schedule 当前**没有** running 行（有在跑 ⇒ 调度器活着，排队是正常的）。
 *  不回收的话它会永久占住路由的 busy 判定（queued 也算「未完成」）。 */
export async function reapQueued(pool: Pool, now: Date): Promise<number> {
  const { rowCount } = await pool.query(
    `update platform.job_run r
        set status='timeout', finished_at=$1, error='stale queued reaped'
       from platform.job_schedule s
      where r.schedule_id = s.id
        and r.status = 'queued'
        and r.started_at < $1::timestamptz - make_interval(secs => 2 * s.timeout_ms / 1000.0)
        and not exists (select 1 from platform.job_run x
                         where x.schedule_id = r.schedule_id and x.status = 'running')`,
    [now],
  )
  return rowCount ?? 0
}

export async function beat(pool: Pool, now: Date, id = 'scheduler'): Promise<void> {
  await pool.query(
    `insert into platform.job_heartbeat(id, beat_at) values ($1,$2)
     on conflict (id) do update set beat_at = excluded.beat_at`,
    [id, now],
  )
}
