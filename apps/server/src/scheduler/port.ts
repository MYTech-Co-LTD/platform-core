// port.ts — agent 排班的唯一入口（SchedulerPort）。W6-P2 交付端口本体，W6-P3 才经 MCP/HTTP 暴露。
//
// 三条结构性约束（评审红线）：
//  ① **归属只来自 actor**：`owner_org` / `owner_namespace` / `created_by` 一律取自构造时的 actor，
//     请求参数（`params`）里同名键是**保留字**——直接剥掉，不落库，更不可能改变归属。
//  ② **key 白名单**：agent 只能给 `notify.emit` 建排班；registry 里其它系统 job（含将来新增的）
//     不会因为「注册了」就自动对 agent 开放。
//  ③ **跨归属一律 NOT_FOUND**（不是 403）：403 会告诉调用方「这个 id 存在，只是不是你的」，
//     等于给枚举留了口子；NOT_FOUND 让「不存在」与「不属于你」不可区分。
//
// 本层只碰数据：`runNow` 只插一行 `queued`（与手动触发端点同语义），**绝不 spawn**——
// 执行发生在 worker 进程的 `claimQueuedManual`。软删一律走 store.softDeleteSchedule（job_run 是审计）。
import type { Pool } from 'pg'
import { type CronSpec, isValidCron, nextRunAt, parseCron } from './cron'
import { JOB_REGISTRY } from './registry'
import { softDeleteSchedule } from './store'

export interface SchedulerActor {
  userId: string
  org: string
  namespace: string
}

export interface SchedulerPort {
  createSchedule(input: {
    key: string
    cron: string
    timezone: string
    params: Record<string, unknown>
    /**
     * 期望间隔（秒）。**可省略**：省略时端口从 cron 推导「典型间隔」
     * （固定参考点起相邻两次触发之差，向上取整、最小 60 秒）。
     * 显式传入仍优先并校验 >0（保留覆盖能力）。
     */
    expectedIntervalSecs?: number
    timeoutMs?: number
    maxAttempts?: number
  }): Promise<{ id: string; nextRunAt: string }>
  /** 只读：当前 actor 的 namespace 配额使用情况（与 createSchedule 的判据同源）。 */
  quotaOf(): Promise<SchedulerQuota>
  /** `filter.ownerOrg` 被忽略（恒用 actor.org）；`ownerNamespace` 只能收窄到 actor.namespace。 */
  listSchedules(filter: { ownerOrg: string; ownerNamespace?: string }): Promise<Array<{
    id: string
    key: string
    cron: string
    enabled: boolean
    nextRunAt: string | null
    deletedAt: string | null
  }>>
  setScheduleEnabled(id: string, enabled: boolean): Promise<void>
  /** 软删（job_run 审计保留）。 */
  deleteSchedule(id: string): Promise<void>
  listRuns(scheduleId: string, limit: number): Promise<Array<{
    id: string
    status: string
    startedAt: string
    finishedAt: string | null
    exitCode: number | null
    outputTail: string | null
  }>>
  /** 只入队（`trigger='manual'`、`status='queued'`），不 spawn。 */
  runNow(id: string): Promise<{ runId: string }>
}

export interface SchedulerPortError extends Error {
  code: string
  detail?: string
  /** 仅 `QUOTA_EXCEEDED`：触发的是哪一条配额。 */
  kind?: QuotaKind
  /** 仅 `QUOTA_EXCEEDED`：该配额的额度（= 用户拍板值）。 */
  limit?: number
}

export type QuotaKind = 'schedules' | 'min_interval' | 'daily_firings'

export interface SchedulerQuota {
  schedules: { used: number; limit: number }
  dailyFirings: { used: number; limit: number }
  minIntervalSecs: number
}

/** 配额（用户拍板 2026-11-14，W6-P3）。改数值必须走评审，不许在实现里调。 */
const QUOTA_SCHEDULES = 50
const QUOTA_MIN_INTERVAL_SECS = 300
const QUOTA_DAILY_FIRINGS = 200

/** agent 可建排班的 key 白名单（v1 只有周期消息）。新增 key 必须走评审改这里。 */
const AGENT_JOB_KEYS = new Set(['notify.emit'])

/** `params` 序列化上限，与 runner 的 JOB_PARAMS 同一口径（spec §8）。 */
const MAX_PARAMS_BYTES = 16 * 1024

/** actor 归属的保留参数名：出现即剥掉（见文件头 ①）。 */
const RESERVED_PARAM_KEYS = new Set(['ownerOrg', 'ownerNamespace'])

const RUN_LIMIT_MAX = 100

/** `job_schedule.timeout_ms` / `max_attempts` / `expected_interval_secs` 都是 int4。 */
const INT4_MAX = 2_147_483_647
/** `job_schedule.id` 是 bigserial（int8）。超出域的十进制 id 直接判 NOT_FOUND，绝不下发 PG。 */
const INT8_MAX = 9_223_372_036_854_775_807n

function fail(code: string, detail?: string): never {
  const err = new Error(code) as SchedulerPortError
  err.code = code
  if (detail !== undefined) err.detail = detail
  throw err
}

/** 超配额统一形态：`code='QUOTA_EXCEEDED'` + 结构化的 `kind`/`limit`（工具层直接透出）。 */
function quotaExceeded(kind: QuotaKind, limit: number, detail?: string): never {
  const err = new Error('QUOTA_EXCEEDED') as SchedulerPortError
  err.code = 'QUOTA_EXCEEDED'
  err.kind = kind
  err.limit = limit
  if (detail !== undefined) err.detail = detail
  throw err
}

/** 配额判据（与 quotaOf 共用，避免两处口径漂移）：本 namespace 的 agent 排班数。 */
const SCHEDULE_COUNT_SQL = `
  select count(*)::int as n from platform.job_schedule
   where owner_org = $1 and owner_namespace = $2 and deleted_at is null and source = 'agent'`

/** 配额判据：本 namespace 最近 24h 的 firing 数（跨该 namespace 的全部排班）。 */
const DAILY_FIRINGS_SQL = `
  select count(*)::int as n
    from platform.job_run r
    join platform.job_schedule s on s.id = r.schedule_id
   where s.owner_org = $1 and s.owner_namespace = $2
     and r.started_at > now() - interval '1 day'`

/** quotaOf 与 createSchedule 同源：一条 SQL 取两个计数（同一快照）。 */
const QUOTA_SNAPSHOT_SQL = `
  select (${SCHEDULE_COUNT_SQL}) as schedules_used,
         (${DAILY_FIRINGS_SQL}) as firings_used`

/** 最小间隔扫描的固定参考时刻（2026-01-05 是周一；固定起点保证判据与创建时刻无关）。 */
const MIN_INTERVAL_REF = new Date('2026-01-05T00:00:00.000Z')

/** cron 的分钟/小时/星期以周为周期：扫 8 天足以覆盖任意一次相邻触发。 */
const MIN_INTERVAL_SCAN_MS = 8 * 24 * 60 * 60 * 1000
/** 迭代上限保护：合规的最密 cron（5 分钟）8 天 = 2304 次；违规 cron 会早退。 */
const MIN_INTERVAL_SCAN_MAX_ITER = 5000

/**
 * 间隔缓存：`min`（配额闸门）与 `max`（期望间隔）**共享同一个键**（归一化 spec + tz）
 * 与同一条 FIFO 生命周期。两者都是「8 天扫描」的产物，分开缓存只会让同一 cron 白扫两次。
 *
 * 结果只取决于 (cron 解析后的 spec, timezone)，与当前时刻无关 ⇒ 进程内缓存可跨请求复用；
 * 键用解析后的 spec 归一（「每 5 分钟」的各种写法命中同一项）；上限 1024 条，
 * 超出按 FIFO 淘汰最旧一条（不清空，避免持续未命中把合法缓存冲掉）。
 */
const GAP_CACHE_MAX = 1024
type GapInfo = { min?: number; max?: number }
const gapCache = new Map<string, GapInfo>()

/** 「每 5 分钟」的区间步长、带前导零等写法解析后同形 ⇒ 必须落到同一缓存键。 */
function cronSpecKey(spec: CronSpec): string {
  return [
    spec.minutes.join(','), spec.hours.join(','), spec.daysOfMonth.join(','),
    spec.months.join(','), spec.daysOfWeek.join(','),
    spec.domRestricted ? 'd' : '*', spec.dowRestricted ? 'd' : '*',
  ].join('|')
}

/** 解析后的归一化缓存键：时区 + spec（两种间隔共用）。 */
function gapCacheKey(expr: string, timeZone: string): string {
  return `${timeZone}\u0000${cronSpecKey(parseCron(expr))}`
}

/** 写入/合并缓存项；新键且已满时 FIFO 淘汰最旧一条。 */
function rememberGap(cacheKey: string, patch: GapInfo): void {
  const prev = gapCache.get(cacheKey)
  if (!prev && gapCache.size >= GAP_CACHE_MAX) {
    const oldest = gapCache.keys().next()
    if (!oldest.done) gapCache.delete(oldest.value)
  }
  gapCache.set(cacheKey, { ...(prev ?? {}), ...patch })
}

/**
 * cron 在完整周期内的**真实最小间隔**（秒）：从固定参考时刻起连续迭代 8 天。
 * 不能只看「创建时刻的下一格到再下一格」——`0,4 * * * *` 在整点附近会算出 56 分钟，
 * 换个时刻又是 4 分钟（非确定性且可绕过）。**违规 cron 前几步即早退**。
 */
function minimumGapSecs(expr: string, timeZone: string): number {
  const cacheKey = gapCacheKey(expr, timeZone)
  const cached = gapCache.get(cacheKey)?.min
  if (cached !== undefined) return cached

  // 窗口锚到**首个触发**：稀疏 cron（如 `0,4 0 1 * *`）的首个触发可能远在参考时刻之后，
  // 锚在参考时刻会让循环一次都不跑（min=Infinity）⇒ 直接放行（复审回归）。
  // 从首个触发起扫 8 天，任何日内 burst 都包含该日首个触发。
  let prev = nextRunAt(expr, timeZone, MIN_INTERVAL_REF)
  const end = prev.getTime() + MIN_INTERVAL_SCAN_MS
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < MIN_INTERVAL_SCAN_MAX_ITER && prev.getTime() <= end; i++) {
    const next = nextRunAt(expr, timeZone, prev)
    const gap = (next.getTime() - prev.getTime()) / 1000
    // 早退：违规 cron 通常前几步就命中。
    if (gap < QUOTA_MIN_INTERVAL_SECS) { min = gap; break }
    if (gap < min) min = gap
    prev = next
  }

  rememberGap(cacheKey, { min })
  return min
}

/**
 * 「期望间隔」的缺省值（秒）：**一个完整扫描周期内的最大相邻间隔**，向上取整，最小 60。
 *
 * 为什么是最大间隔：`health.ts` 的「该跑没跑」= `2 × expected_interval_secs`。
 * 只看向邻两格会漏掉「工作日」cron 的周末：`0 0 * * 1-5` 的相邻两格是 86400，
 * 但周五→周一是 259200，`2×86400` 会在每周日假红约一天。取扫描窗口内的最大值 ⇒
 * **不会假红**；代价是对稀疏 cron 发现得晚（宁可晚报，不可假报）。每周 cron 的
 * 判红窗口因此是 `2×7 天 = 336 小时`（不是 288）。
 *
 * 窗口/迭代上限复用 `minimumGapSecs` 的 8 天基础设施；这里**不 early-exit**，必须扫完取 max。
 * **只在通过 `min_interval` 闸门后调用**：宽 cron（`* * * * *`）会在闸门处瞬拒，
 * 不会先付一次完整扫描（实测 ~16s/次）再被拒。缓存与 min 共享同一个键。
 */
function maxIntervalSecs(expr: string, timeZone: string): number {
  const cacheKey = gapCacheKey(expr, timeZone)
  const cached = gapCache.get(cacheKey)?.max
  if (cached !== undefined) return cached

  let prev = nextRunAt(expr, timeZone, MIN_INTERVAL_REF)
  const end = prev.getTime() + MIN_INTERVAL_SCAN_MS
  let max = 0
  for (let i = 0; i < MIN_INTERVAL_SCAN_MAX_ITER && prev.getTime() <= end; i++) {
    const next = nextRunAt(expr, timeZone, prev)
    const gap = (next.getTime() - prev.getTime()) / 1000
    if (gap > max) max = gap
    prev = next
  }

  const result = Math.max(Math.ceil(max), 60)
  rememberGap(cacheKey, { max: result })
  return result
}

/** 归属谓词：所有按 id 的操作都带上它；软删行视为「不存在」。 */
const OWNED_WHERE =
  'id = $1 and owner_org = $2 and owner_namespace = $3 and deleted_at is null'

/** 非「≤ int8 上界的十进制」id 一律 NOT_FOUND：否则 PostgreSQL 会抛 22P02/22003（不可控 500），
 *  且错误形状本身会暴露 id 是否在域内。 */
function parseId(id: string): string {
  const s = String(id)
  if (!/^\d+$/.test(s) || BigInt(s) > INT8_MAX) fail('NOT_FOUND')
  return s
}

type QueryFn = (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

/** 按 id + actor 归属取排班；不存在/不属于该 actor/已软删 ⇒ NOT_FOUND。
 *  `forUpdate` 供 runNow 在事务内用同一套谓词锁行（锁与归属判定不可分）。 */
async function assertOwned(
  query: QueryFn,
  id: string,
  actor: SchedulerActor,
  forUpdate = false,
): Promise<{ id: string; key: string }> {
  const { rows } = await query(
    `select id, key from platform.job_schedule where ${OWNED_WHERE}${forUpdate ? ' for update' : ''}`,
    [parseId(id), actor.org, actor.namespace],
  )
  const row = rows[0]
  if (!row) fail('NOT_FOUND')
  return { id: String(row.id), key: String(row.key) }
}

/** 正整数且落在 int4 域内：`Number.isSafeInteger` 放过的 1e12 会让 PG 抛 22003（不可控 500）。 */
function positiveInt(v: unknown, code: string): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isSafeInteger(n) || n <= 0 || n > INT4_MAX) fail(code)
  return n
}

/** 归属保留字不落库（只剥顶层：嵌套 payload 里同名字段是业务数据，不参与归属）。 */
function sanitizeParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params ?? {})) {
    if (RESERVED_PARAM_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

export function buildSchedulerPort(deps: {
  pool: Pool
  actor: SchedulerActor
  now?: () => Date
}): SchedulerPort {
  const { pool, actor } = deps
  const now = deps.now ?? (() => new Date())
  const asQuery: QueryFn = (sql, values) => pool.query(sql, values)

  return {
    async createSchedule(input) {
      const def = JOB_REGISTRY.find((d) => d.key === input.key)
      // 白名单 + registry 双重核对：`noSystemSchedule` 是「只由 agent/console 建行」的标记，
      // 缺了它说明这个 key 本该有系统排班，不该经 agent 面创建。
      if (!AGENT_JOB_KEYS.has(input.key) || !def || def.noSystemSchedule !== true) {
        fail('UNKNOWN_JOB_KEY', input.key)
      }
      if (!isValidCron(input.cron)) fail('INVALID_CRON', input.cron)
      // 显式值优先并校验；缺省在 nextRunAt 解析成功后从 cron 推导（见 maxIntervalSecs）。
      const explicitIntervalSecs = input.expectedIntervalSecs === undefined
        ? undefined
        : positiveInt(input.expectedIntervalSecs, 'INVALID_INTERVAL')
      const timeoutMs = input.timeoutMs === undefined
        ? def.timeoutMs
        : positiveInt(input.timeoutMs, 'INVALID_TIMEOUT')
      const maxAttempts = input.maxAttempts === undefined
        ? def.maxAttempts
        : positiveInt(input.maxAttempts, 'INVALID_ATTEMPTS')

      const params = sanitizeParams(input.params)
      const paramsJson = JSON.stringify(params)
      const bytes = Buffer.byteLength(paramsJson, 'utf8')
      if (bytes > MAX_PARAMS_BYTES) fail('PARAMS_TOO_LARGE', `${bytes}B > ${MAX_PARAMS_BYTES}B`)

      const at = now()
      let nextAt: Date
      try {
        nextAt = nextRunAt(input.cron, input.timezone, at)
      } catch (e) {
        // 语法已过 isValidCron；这里失败只可能是时区非法/DST/8 年内无触发点。
        fail('INVALID_SCHEDULE', e instanceof Error ? e.message : String(e))
      }

      const client = await pool.connect()
      try {
        await client.query('begin')
        // 锁等待上限（照抄 runNow）：配额锁被占时不许把连接无限期占住。
        await client.query("set local lock_timeout = '2s'")
        // 配额「计数 + 插入」必须对同一 (org, namespace) 串行：READ COMMITTED 下两条并发
        // 事务都读到 49 条，各自插入后就是 51 条。事务级 advisory lock 随提交/回滚自动释放。
        await client.query(
          'select pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [actor.org, actor.namespace],
        )

        const schedules = await client.query<{ n: number }>(
          SCHEDULE_COUNT_SQL, [actor.org, actor.namespace])
        if (schedules.rows[0].n >= QUOTA_SCHEDULES) {
          quotaExceeded('schedules', QUOTA_SCHEDULES, `${schedules.rows[0].n} >= ${QUOTA_SCHEDULES}`)
        }
        // 扫描放在便宜的条数检查之后：已超额的请求不再付全周期扫描的代价。
        let minIntervalSecs: number
        try {
          // 完整周期内的真实最小值；不信任调用方传的 expectedIntervalSecs。
          minIntervalSecs = minimumGapSecs(input.cron, input.timezone)
        } catch (e) {
          fail('INVALID_SCHEDULE', e instanceof Error ? e.message : String(e))
        }
        if (minIntervalSecs < QUOTA_MIN_INTERVAL_SECS) {
          quotaExceeded(
            'min_interval', QUOTA_MIN_INTERVAL_SECS,
            `${minIntervalSecs}s < ${QUOTA_MIN_INTERVAL_SECS}s`,
          )
        }

        // **顺序**：先过 min_interval 闸门再推导 max —— 宽 cron（`* * * * *`）在上一步
        // 就早退，不会先付一次完整 max 扫描（实测 ~16s/次）再被拒。合规 cron 的结果走
        // gapCache（与 min 同一个键），此后重复创建/列举不再扫描。
        let expectedIntervalSecs = explicitIntervalSecs
        if (expectedIntervalSecs === undefined) {
          try {
            expectedIntervalSecs = maxIntervalSecs(input.cron, input.timezone)
          } catch (e) {
            // 时区非法等：与 nextAt 失败同码（语法已过 isValidCron）。
            fail('INVALID_SCHEDULE', e instanceof Error ? e.message : String(e))
          }
        }

        const firings = await client.query<{ n: number }>(
          DAILY_FIRINGS_SQL, [actor.org, actor.namespace])
        if (firings.rows[0].n >= QUOTA_DAILY_FIRINGS) {
          quotaExceeded('daily_firings', QUOTA_DAILY_FIRINGS, `${firings.rows[0].n} >= ${QUOTA_DAILY_FIRINGS}`)
        }

        const { rows } = await client.query<{ id: string }>(
          `insert into platform.job_schedule
             (key, cron, timezone, params, owner_org, owner_namespace, source, created_by,
              enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs)
           values ($1,$2,$3,$4::jsonb,$5,$6,'agent',$7,true,$8,$9,$10,$11)
           returning id`,
          [
            input.key, input.cron, input.timezone, paramsJson,
            actor.org, actor.namespace, actor.userId,
            nextAt, timeoutMs, maxAttempts, expectedIntervalSecs,
          ],
        )
        await client.query('commit')
        return { id: String(rows[0].id), nextRunAt: nextAt.toISOString() }
      } catch (e) {
        await client.query('rollback').catch(() => {})
        // 55P03 = lock_not_available：配额锁有界等待失败，转端口错误码（未插行）。
        if ((e as { code?: string }).code === '55P03') fail('JOB_LOCK_TIMEOUT', 'quota lock')
        throw e
      } finally {
        client.release()
      }
    },

    async quotaOf() {
      // 判据与本文件 createSchedule 共用同一组 SQL 常量（不内联复制，避免口径漂移）。
      const { rows } = await pool.query<{ schedules_used: number; firings_used: number }>(
        QUOTA_SNAPSHOT_SQL, [actor.org, actor.namespace])
      return {
        schedules: { used: rows[0].schedules_used, limit: QUOTA_SCHEDULES },
        dailyFirings: { used: rows[0].firings_used, limit: QUOTA_DAILY_FIRINGS },
        minIntervalSecs: QUOTA_MIN_INTERVAL_SECS,
      }
    },

    async listSchedules(filter) {
      // 归属恒取 actor：`filter.ownerOrg` 只为接口兼容而保留，**传入值被忽略**。
      // 若沿用调用方传值，P3 适配层一旦透传客户端参数就是跨租户列举——端口自己必须兜住。
      const values: unknown[] = [actor.org]
      // 列举面是给 agent 用的（工具描述：「由 agent 建的排班」）⇒ 按 source 收口。
      // 不能只靠 owner_org 非空：system 行目前 owner 为空，但这是数据现状而非契约。
      let sql = `select id, key, cron, enabled, next_run_at, deleted_at
                   from platform.job_schedule
                  where owner_org = $1 and source = 'agent' and deleted_at is null`
      // namespace 只能**收窄**：传了别的值 ⇒ 空数组（列举类接口返回空比抛错更合适，也不泄露存在性）。
      if (filter.ownerNamespace !== undefined) {
        if (filter.ownerNamespace !== actor.namespace) return []
        values.push(filter.ownerNamespace)
        sql += ` and owner_namespace = $2`
      }
      sql += ' order by id asc'
      const { rows } = await pool.query<Record<string, unknown>>(sql, values)
      return rows.map((r) => ({
        id: String(r.id),
        key: String(r.key),
        cron: String(r.cron),
        enabled: Boolean(r.enabled),
        nextRunAt: r.next_run_at ? new Date(r.next_run_at as Date).toISOString() : null,
        deletedAt: r.deleted_at ? new Date(r.deleted_at as Date).toISOString() : null,
      }))
    },

    async setScheduleEnabled(id, enabled) {
      // 归属校验与写入是同一条 UPDATE（无 TOCTOU）；0 行 = 不存在/不是你的/已软删。
      // `updated_at=now()` 保证匹配到的行一定被更新 ⇒ rowCount 不会因「值没变」而误判 0。
      const { rowCount } = await pool.query(
        `update platform.job_schedule set enabled=$4, updated_at=now()
          where ${OWNED_WHERE}`,
        [parseId(id), actor.org, actor.namespace, enabled],
      )
      if (!rowCount) fail('NOT_FOUND')
    },

    async deleteSchedule(id) {
      // 先做归属校验（跨归属 NOT_FOUND），再走 store 的软删（清触发槽 + enabled=false）。
      const row = await assertOwned(asQuery, id, actor)
      await softDeleteSchedule(pool, Number(row.id), now())
    },

    async listRuns(scheduleId, limit) {
      // 排班已软删 ⇒ 视为不存在（agent 面看不到删掉的排班及其台账）。
      await assertOwned(asQuery, scheduleId, actor)
      const n = Math.trunc(Number(limit))
      if (!Number.isFinite(n) || n <= 0) return []
      const capped = Math.min(n, RUN_LIMIT_MAX)
      const { rows } = await pool.query<Record<string, unknown>>(
        `select id, status, started_at, finished_at, exit_code, output_tail
           from platform.job_run
          where schedule_id = $1
          order by started_at desc, id desc
          limit $2`,
        [parseId(scheduleId), capped],
      )
      return rows.map((r) => ({
        id: String(r.id),
        status: String(r.status),
        startedAt: new Date(r.started_at as Date).toISOString(),
        finishedAt: r.finished_at ? new Date(r.finished_at as Date).toISOString() : null,
        exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
        outputTail: r.output_tail === null || r.output_tail === undefined ? null : String(r.output_tail),
      }))
    },

    async runNow(id) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        // 锁等待上限（照抄 P1 手动触发路由）：排班行被 claim/别的触发持锁时，
        // **不许把连接无限期占住**。2s 到点由 PostgreSQL 抛 55P03，下面转 JOB_LOCK_TIMEOUT。
        await client.query("set local lock_timeout = '2s'")
        // 归属校验 + 行锁同一句：并发触发的第二个事务在此等待，提交后按最新快照重判 busy。
        const sch = await assertOwned(
          (sql, values) => client.query(sql, values), id, actor, true)
        const busy = await client.query(
          `select 1 from platform.job_run
            where schedule_id=$1 and status in ('queued','running') limit 1`,
          [sch.id],
        )
        if (busy.rows.length > 0) fail('JOB_ALREADY_PENDING', sch.id)
        // params_snapshot 留 null：claimQueuedManual 会回填排班 params（与端点同语义）。
        // 归属一并落到运行行（与 createSchedule 同源）：agent 触发的运行在台账里可区分。
        const ins = await client.query<{ id: string }>(
          `insert into platform.job_run
             (schedule_id, key, occurrence, trigger, status, owner_org, owner_namespace)
           values ($1,$2,now(),'manual','queued',$3,$4) returning id`,
          [sch.id, sch.key, actor.org, actor.namespace],
        )
        await client.query('commit')
        return { runId: String(ins.rows[0].id) }
      } catch (e) {
        await client.query('rollback').catch(() => {})
        // 55P03 = lock_not_available：排队等锁有界失败，转端口错误码（不插行，事务已回滚）。
        if ((e as { code?: string }).code === '55P03') fail('JOB_LOCK_TIMEOUT')
        throw e
      } finally {
        client.release()
      }
    },
  }
}
