// worker-wiring.test.ts — worker 接线契约（Wave 6 P1）。
//
// 这里**不连库、不起 HTTP**：`/healthz` 的判定是 `worker-healthz.ts` 的纯函数，
// 开关语义（尤其 `SCHEDULER_ENABLED=0`）直接喂桩即可覆盖。真实 SQL 判据在
// `health.test.ts`（有 DATABASE_URL 时跑真 PG）。
import { describe, expect, it } from 'vitest'
import { jobHealth } from './health'
import { createSchedulerLoop } from './loop'
import { workerHealthz } from './worker-healthz'

describe('scheduler 接线契约', () => {
  it('createSchedulerLoop 在没有任何到期任务时返回零统计（不抛）', async () => {
    // 纯契约：pool 用最小桩，claim 查询返回空 ⇒ tick 应安静返回。
    const calls: string[] = []
    const pool = {
      query: async (sql: string) => { calls.push(sql.trim().slice(0, 20)); return { rows: [], rowCount: 0 } },
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    }
    const loop = createSchedulerLoop({ pool: pool as never, registry: [], maxConcurrency: 1, cwd: '/' })
    const stats = await loop.tick()
    expect(stats.started).toBe(0)
    expect(calls.some((c) => c.startsWith('insert into platform.j'))).toBe(false)
  })

  it('★ 心跳缺失 ⇒ ok=false 且原因点名心跳（不是「看起来没作业就算健康」）', async () => {
    const pool = { query: async () => ({ rows: [] }) }
    const h = await jobHealth(pool as never, new Date())
    expect(h.ok).toBe(false)
    expect(h.reasons.join()).toContain('心跳')
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
