// worker-wiring.test.ts — worker 接线契约（Wave 6 P1）。
//
// 这里**不连库、不起 HTTP**：`/healthz` 的判定是 `worker-healthz.ts` 的纯函数，
// `SCHEDULER_*` 的 env 语义与节拍边界在 `worker-config.ts`，直接喂桩即可覆盖。
// 真实 SQL 判据在 `health.test.ts`（有 DATABASE_URL 时跑真 PG）。
//
// 变异靶点（评审要求可证伪）：
//   - 把 `parseSchedulerConfig` 的 `enabled` 改成恒 true ⇒ 「'0' ⇒ 关」用例必须红；
//   - 让空 registry 的 tick 也 seed（如把 seed 的 registry 换成 JOB_REGISTRY）⇒
//     「空 registry 不 insert job_schedule」用例必须红。
import { describe, expect, it } from 'vitest'
import { jobHealth } from './health'
import { createSchedulerLoop } from './loop'
import type { JobDef } from './registry'
import { parseSchedulerConfig, shouldRunTick } from './worker-config'
import { workerHealthz } from './worker-healthz'

/** 记录**完整 SQL**（不截断——截断到 20 字符会让前缀断言恒假，等于没断言）。 */
interface SqlRecorder {
  pool: { query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<unknown> }
  sqls: string[]
}

function recordingPool(): SqlRecorder {
  const sqls: string[] = []
  const query = async (sql: string) => { sqls.push(sql.trim()); return { rows: [], rowCount: 0 } }
  return {
    sqls,
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    },
  }
}

const def: JobDef = {
  key: 'jobtest-wire:one', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC',
  timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't',
}

const SCHEDULE_INSERT_RE = /^insert into platform\.job_schedule\b/i
const HEARTBEAT_INSERT_RE = /^insert into platform\.job_heartbeat\b/i

describe('scheduler 接线契约', () => {
  it('空 registry 的 tick 不 seed 排班（但仍打心跳，证明记录器真的看得到 insert）', async () => {
    const { pool, sqls } = recordingPool()
    const loop = createSchedulerLoop({ pool: pool as never, registry: [], maxConcurrency: 1, cwd: '/' })
    const stats = await loop.tick()
    expect(stats.started).toBe(0)
    // 正向对照：beat 确实发生 ⇒ 下面的「没有 job_schedule insert」不是空断言。
    expect(sqls.some((s) => HEARTBEAT_INSERT_RE.test(s))).toBe(true)
    expect(sqls.some((s) => SCHEDULE_INSERT_RE.test(s))).toBe(false)
  })

  it('非空 registry 的 tick 会 seed 排班（同一断言前缀在应命中时命中）', async () => {
    const { pool, sqls } = recordingPool()
    const loop = createSchedulerLoop({
      pool: pool as never, registry: [def], maxConcurrency: 1, cwd: '/',
    })
    const stats = await loop.tick()
    expect(stats.started).toBe(0)
    expect(sqls.some((s) => SCHEDULE_INSERT_RE.test(s))).toBe(true)
  })

  it('★ 心跳缺失 ⇒ ok=false 且原因点名心跳（不是「看起来没作业就算健康」）', async () => {
    const pool = { query: async () => ({ rows: [] }) }
    const h = await jobHealth(pool as never, new Date())
    expect(h.ok).toBe(false)
    expect(h.reasons.join()).toContain('心跳')
  })
})

describe('parseSchedulerConfig（env → 行为，可变异验证）', () => {
  it('未设 SCHEDULER_ENABLED ⇒ 默认开；"0" ⇒ 关；"1" ⇒ 开', () => {
    expect(parseSchedulerConfig({}).enabled).toBe(true)
    expect(parseSchedulerConfig({ SCHEDULER_ENABLED: '0' }).enabled).toBe(false)
    expect(parseSchedulerConfig({ SCHEDULER_ENABLED: '1' }).enabled).toBe(true)
  })

  it('tickMs / maxConcurrency：缺省值与非法值抛错', () => {
    expect(parseSchedulerConfig({}).tickMs).toBe(30000)
    expect(parseSchedulerConfig({}).maxConcurrency).toBe(2)
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() => parseSchedulerConfig({ SCHEDULER_TICK_MS: bad })).toThrow(/SCHEDULER_TICK_MS/)
      expect(() => parseSchedulerConfig({ SCHEDULER_MAX_CONCURRENCY: bad }))
        .toThrow(/SCHEDULER_MAX_CONCURRENCY/)
    }
  })

  it('healthPort：空串回退（不落 Number("") === 0）', () => {
    // .env 里 `SCHEDULER_HEALTH_PORT=` ⇒ 空串，必须回退到 WORKER_HEALTH_PORT 而不是 0。
    expect(parseSchedulerConfig({ SCHEDULER_HEALTH_PORT: '', WORKER_HEALTH_PORT: '13100' }).healthPort)
      .toBe(13100)
    expect(parseSchedulerConfig({ WORKER_HEALTH_PORT: '', PORT: '13200' }).healthPort).toBe(13200)
    expect(parseSchedulerConfig({}).healthPort).toBe(13000)
    expect(parseSchedulerConfig({ SCHEDULER_HEALTH_PORT: '13001' }).healthPort).toBe(13001)
    expect(() => parseSchedulerConfig({ PORT: '0' })).toThrow(/端口/)
  })
})

describe('shouldRunTick（节拍边界）', () => {
  it('首次（last=0）即跑；差值 < tickMs 不跑、>= 跑', () => {
    expect(shouldRunTick(1_700_000_000_000, 0, 30000)).toBe(true)
    expect(shouldRunTick(1_000_000 + 29_999, 1_000_000, 30_000)).toBe(false)
    expect(shouldRunTick(1_000_000 + 30_000, 1_000_000, 30_000)).toBe(true)
    expect(shouldRunTick(1_000_000 + 30_001, 1_000_000, 30_000)).toBe(true)
  })
})

describe('workerHealthz 判定表', () => {
  it('SCHEDULER_ENABLED=0：只取决于投递心跳，调度陈旧不参与', () => {
    // 投递新鲜 + 调度（即使报红）⇒ 200：回滚开关不许把 worker 判红。
    const fresh = workerHealthz({
      notifyFresh: true,
      schedulerEnabled: false,
      jobHealth: { ok: false, reasons: ['调度心跳陈旧：已 999s 未更新'] },
    })
    expect(fresh.status).toBe(200)
    expect(fresh.body).toBe('ok')

    // 投递陈旧 ⇒ 503，且原因**只有**投递，不夹带调度。
    const stale = workerHealthz({ notifyFresh: false, schedulerEnabled: false })
    expect(stale.status).toBe(503)
    expect(stale.body).toContain('通知投递心跳陈旧')
    expect(stale.body).not.toContain('调度')
  })

  it('调度心跳缺失 ⇒ 503 且 body 含原因', async () => {
    // 真 jobHealth + 空心跳桩：三判据的 SQL 都回空行，只有心跳一条命中。
    const h = await jobHealth({ query: async () => ({ rows: [] }) } as never, new Date())
    const r = workerHealthz({ notifyFresh: true, schedulerEnabled: true, jobHealth: h })
    expect(r.status).toBe(503)
    expect(r.body).toContain('调度心跳')
  })

  it('投递与调度都新鲜 ⇒ 200', () => {
    const r = workerHealthz({
      notifyFresh: true,
      schedulerEnabled: true,
      jobHealth: { ok: true, reasons: [] },
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('ok')
  })

  it('开了调度却没给 jobHealth ⇒ fail-closed 503（健康面不可观测不假绿）', () => {
    const r = workerHealthz({ notifyFresh: true, schedulerEnabled: true, jobHealth: null })
    expect(r.status).toBe(503)
    expect(r.body).toContain('调度健康未求值')
  })
})
