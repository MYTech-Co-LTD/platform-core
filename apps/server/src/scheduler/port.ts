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
import { isValidCron, nextRunAt } from './cron'
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
    expectedIntervalSecs: number
    timeoutMs?: number
    maxAttempts?: number
  }): Promise<{ id: string; nextRunAt: string }>
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
}

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
      const expectedIntervalSecs = positiveInt(input.expectedIntervalSecs, 'INVALID_INTERVAL')
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

      const { rows } = await pool.query<{ id: string }>(
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
      return { id: String(rows[0].id), nextRunAt: nextAt.toISOString() }
    },

    async listSchedules(filter) {
      // 归属恒取 actor：`filter.ownerOrg` 只为接口兼容而保留，**传入值被忽略**。
      // 若沿用调用方传值，P3 适配层一旦透传客户端参数就是跨租户列举——端口自己必须兜住。
      const values: unknown[] = [actor.org]
      let sql = `select id, key, cron, enabled, next_run_at, deleted_at
                   from platform.job_schedule
                  where owner_org = $1 and deleted_at is null`
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
