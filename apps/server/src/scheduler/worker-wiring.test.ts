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
import {
  parseDeliveryEnabled, parseJobGroups, parseSchedulerConfig, resolveWorkerRole, selectRunnableJobs, shouldRunTick,
} from './worker-config'
import { JOB_REGISTRY } from './registry'
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
  scope: 'platform', key: 'jobtest-wire:one', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC',
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

describe('parseDeliveryEnabled（角色拆分，#2504）', () => {
  it('未设 ⇒ 默认开；"0" ⇒ 关；"1" ⇒ 开', () => {
    expect(parseDeliveryEnabled({})).toBe(true)
    expect(parseDeliveryEnabled({ NOTIFY_DELIVERY_ENABLED: '' })).toBe(true)
    expect(parseDeliveryEnabled({ NOTIFY_DELIVERY_ENABLED: '0' })).toBe(false)
    expect(parseDeliveryEnabled({ NOTIFY_DELIVERY_ENABLED: '1' })).toBe(true)
  })

  it('与 SCHEDULER_ENABLED 互相独立（拆机时两边各设一边）', () => {
    // 数据单元：只跑调度
    const dataUnit = { SCHEDULER_ENABLED: '1', NOTIFY_DELIVERY_ENABLED: '0' }
    expect(parseSchedulerConfig(dataUnit).enabled).toBe(true)
    expect(parseDeliveryEnabled(dataUnit)).toBe(false)
    // 应用单元：只跑投递
    const appUnit = { SCHEDULER_ENABLED: '0', NOTIFY_DELIVERY_ENABLED: '1' }
    expect(parseSchedulerConfig(appUnit).enabled).toBe(false)
    expect(parseDeliveryEnabled(appUnit)).toBe(true)
  })
})

describe('resolveWorkerRole（两个 loop 都关 ⇒ 响亮失败）', () => {
  it('应用单元（只投递）与数据单元（只调度）都放行', () => {
    expect(resolveWorkerRole({ once: false, deliveryEnabled: true, schedulerEnabled: false }).ok).toBe(true)
    expect(resolveWorkerRole({ once: false, deliveryEnabled: false, schedulerEnabled: true }).ok).toBe(true)
    expect(resolveWorkerRole({ once: false, deliveryEnabled: true, schedulerEnabled: true }).ok).toBe(true)
  })

  it('两关都 0 ⇒ 拒绝（空转容器不许看起来正常）', () => {
    const r = resolveWorkerRole({ once: false, deliveryEnabled: false, schedulerEnabled: false })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toContain('都被关闭')
  })

  it('--once 与关投递互斥（--once 只跑投递，静默成功会让运维脚本误判）', () => {
    const r = resolveWorkerRole({ once: true, deliveryEnabled: false, schedulerEnabled: false })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toContain('--once')
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

describe('作业域（#2511 调度器拆分）', () => {
  it('parseJobGroups：缺省/空串 = 两域；单域；顺序归一；未知名抛错', () => {
    expect(parseJobGroups(undefined)).toEqual(['platform', 'data'])
    expect(parseJobGroups('')).toEqual(['platform', 'data'])
    expect(parseJobGroups('data')).toEqual(['data'])
    expect(parseJobGroups(' data , platform ')).toEqual(['platform', 'data'])
    expect(() => parseJobGroups('dataa')).toThrow(/未知域/)
  })

  it('单域 ⇒ 实例 id 按域固定；双域 ⇒ 沿用历史 id（台账连续）', () => {
    expect(parseSchedulerConfig({ SCHEDULER_JOB_GROUPS: 'data' }).instanceId).toBe('scheduler-data')
    expect(parseSchedulerConfig({ SCHEDULER_JOB_GROUPS: 'platform' }).instanceId).toBe('scheduler-platform')
    expect(parseSchedulerConfig({}).instanceId).toBe('scheduler')
    expect(parseSchedulerConfig({ SCHEDULER_INSTANCE_ID: 'x' }).instanceId).toBe('x')
  })

  it('selectRunnableJobs：只留本域，且缺 requiresEnv 的进 blocked 不进 claim 集合', () => {
    const env = { DATABASE_URL: 'postgres://x' }
    const data = selectRunnableJobs(JOB_REGISTRY, ['data'], env)
    expect(data.runnable.every((d) => d.scope === 'data')).toBe(true)
    // 数据域里 dbt 类缺 DATA_WAREHOUSE_URL/ZOS ⇒ 被挡住（而不是跑起来必然失败）
    expect(data.blocked.some((b) => b.key === 'data.dbt_tick')).toBe(true)
    expect(data.runnable.some((d) => d.key === 'data.dbt_tick')).toBe(false)

    const platform = selectRunnableJobs(JOB_REGISTRY, ['platform'], env)
    expect(platform.runnable.every((d) => d.scope === 'platform')).toBe(true)
    // org.sync 需要 Casdoor 管理员凭据：缺了必须被挡住（这是 2026-11-19 那次的真实故障形态）
    expect(platform.blocked).toContainEqual({
      key: 'org.sync',
      missing: ['CASDOOR_URL', 'CASDOOR_ADMIN_USER', 'CASDOOR_ADMIN_PWD'],
    })
    expect(platform.runnable.some((d) => d.key === 'org.sync')).toBe(false)
  })

  it('两域同时选 ⇒ 与拆分前的全量 registry 等价', () => {
    // 「全部 env 都在」的样本：每个新增 job 的 requiresEnv 都要在这里补齐，
    // 否则这条会被误判成「有 job 被挡」——它守的是「两域合起来 == 全量 registry」，不是缺键场景。
    const env = { DATABASE_URL: 'postgres://x', DATA_WAREHOUSE_URL: 'postgres://w', LEMENG_ZOS_BUCKET: 'b', LEMENG_ZOS_REGION: 'r', LEMENG_ZOS_ENDPOINT: 'e', CASDOOR_URL: 'u', CASDOOR_ADMIN_USER: 'a', CASDOOR_ADMIN_PWD: 'p', ZOS_ACCESS_KEY: 'k', ZOS_SECRET_KEY: 's', ZOS_ENDPOINT: 'e', ZOS_REGION: 'r', ZOS_BUCKET: 'b' }
    const all = selectRunnableJobs(JOB_REGISTRY, ['platform', 'data'], env)
    expect(all.blocked).toEqual([])
    expect(all.runnable.length).toBe(JOB_REGISTRY.length)
  })
})

describe('workerHealthz 判定表', () => {
  it('SCHEDULER_ENABLED=0（应用单元）：只取决于投递心跳，调度陈旧不参与', () => {
    // 投递新鲜 + 调度（即使报红）⇒ 200：回滚开关不许把 worker 判红。
    const fresh = workerHealthz({
      notifyFresh: true,
      deliveryEnabled: true,
      schedulerEnabled: false,
      jobHealth: { ok: false, reasons: ['调度心跳陈旧：已 999s 未更新'] },
    })
    expect(fresh.status).toBe(200)
    expect(fresh.body).toBe('ok')

    // 投递陈旧 ⇒ 503，且原因**只有**投递，不夹带调度。
    const stale = workerHealthz({ notifyFresh: false, deliveryEnabled: true, schedulerEnabled: false })
    expect(stale.status).toBe(503)
    expect(stale.body).toContain('通知投递心跳陈旧')
    expect(stale.body).not.toContain('调度')
  })

  it('NOTIFY_DELIVERY_ENABLED=0（数据单元）：投递心跳缺席不判红，只看调度', () => {
    // 这是拆机的关键判据：调度专用容器**没有** notify.worker_heartbeat，
    // 若仍按投递心跳判定，业务调度容器会永久 unhealthy（且 openship 会反复重建它）。
    const ok = workerHealthz({
      notifyFresh: false,
      deliveryEnabled: false,
      schedulerEnabled: true,
      jobHealth: { ok: true, reasons: [] },
    })
    expect(ok.status).toBe(200)
    expect(ok.body).toBe('ok')

    // 调度不健康时照样红——忽略投递心跳不等于不看调度。
    const bad = workerHealthz({
      notifyFresh: true,
      deliveryEnabled: false,
      schedulerEnabled: true,
      jobHealth: { ok: false, reasons: ['调度心跳陈旧：已 999s 未更新'] },
    })
    expect(bad.status).toBe(503)
    expect(bad.body).toContain('调度心跳')
  })

  it('缺 env 被挡的作业 ⇒ 503 且点名缺哪个键（配置错必须在健康面可见）', () => {
    const r = workerHealthz({
      notifyFresh: true, deliveryEnabled: true, schedulerEnabled: true,
      jobHealth: { ok: true, reasons: [] },
      blockedJobs: [{ key: 'org.sync', missing: ['CASDOOR_ADMIN_PWD'] }],
    })
    expect(r.status).toBe(503)
    expect(r.body).toContain('org.sync')
    expect(r.body).toContain('CASDOOR_ADMIN_PWD')
  })

  it('两个 loop 都关 ⇒ 503（空转容器不算健康，方向 fail-closed）', () => {
    const r = workerHealthz({ notifyFresh: true, deliveryEnabled: false, schedulerEnabled: false })
    expect(r.status).toBe(503)
    expect(r.body).toContain('都被关闭')
  })

  it('调度心跳缺失 ⇒ 503 且 body 含原因', async () => {
    // 真 jobHealth + 空心跳桩：三判据的 SQL 都回空行，只有心跳一条命中。
    const h = await jobHealth({ query: async () => ({ rows: [] }) } as never, new Date())
    const r = workerHealthz({ notifyFresh: true, deliveryEnabled: true, schedulerEnabled: true, jobHealth: h })
    expect(r.status).toBe(503)
    expect(r.body).toContain('调度心跳')
  })

  it('投递与调度都新鲜 ⇒ 200', () => {
    const r = workerHealthz({
      notifyFresh: true,
      deliveryEnabled: true,
      schedulerEnabled: true,
      jobHealth: { ok: true, reasons: [] },
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('ok')
  })

  it('开了调度却没给 jobHealth ⇒ fail-closed 503（健康面不可观测不假绿）', () => {
    const r = workerHealthz({
      notifyFresh: true, deliveryEnabled: true, schedulerEnabled: true, jobHealth: null,
    })
    expect(r.status).toBe(503)
    expect(r.body).toContain('调度健康未求值')
  })
})
