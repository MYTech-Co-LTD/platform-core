// monitor-store.test.ts — 业务监控存储层（W7-V1 Task 1）。
// 真库用例自建夹具（同 metric-retire.test.ts 约定），空库可绿；隔离键 montest-*。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import {
  MONITOR_QUOTA_PER_ORG,
} from './monitor-spec'
import {
  applyOutcome, createMonitor, dueMonitors, listMonitors, quotaOf, recordRun, updateMonitorFlags,
} from './monitor-store'
import { validateNewMonitor } from './monitor-spec'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'montest-store'
const OTHER = 'montest-store-other'
const SUFFIX = Math.random().toString(36).slice(2, 8)
const ORG_R = `${ORG}-${SUFFIX}`
const OTHER_R = `${OTHER}-${SUFFIX}`

function baseInput(over: Partial<Parameters<typeof createMonitor>[1]> = {}) {
  return {
    org: ORG_R,
    name: '监控夹具',
    targetKind: 'metric' as const,
    metricId: 'm.test',
    verdict: 'missing' as const,
    cadenceSecs: 300,
    recipients: [{ kind: 'user' as const, ref: 'alice' }],
    createdBy: 'alice',
    ...over,
  }
}

describe('monitor 纯函数', () => {
  it('threshold 必须给闭集算子与有限阈值（缺一即拒，防「恒假永不触发」）', () => {
    expect(validateNewMonitor(baseInput({ verdict: 'threshold' })).ok).toBe(false)
    expect(validateNewMonitor(baseInput({ verdict: 'threshold', operator: 'gt' })).ok).toBe(false)
    expect(validateNewMonitor(baseInput({ verdict: 'threshold', operator: 'gt', threshold: Number.NaN })).ok).toBe(false)
    expect(validateNewMonitor(baseInput({ verdict: 'threshold', operator: 'nope' as never, threshold: 1 })).ok).toBe(false)
    const ok = validateNewMonitor(baseInput({ verdict: 'threshold', operator: 'gte', threshold: 100 }))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value).toMatchObject({ operator: 'gte', threshold: 100 })
  })

  it('missing/stale 的算子与阈值归 null', () => {
    const r = validateNewMonitor(baseInput({ operator: 'gt', threshold: 5 }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatchObject({ operator: null, threshold: null })
  })

  it('周期低于 300s 拒绝；收件人为空拒绝', () => {
    expect(validateNewMonitor(baseInput({ cadenceSecs: 60 })).ok).toBe(false)
    expect(validateNewMonitor(baseInput({ recipients: [] })).ok).toBe(false)
  })

  it('target_kind 闭集：metric 缺 metricId / 未知 kind 都拒绝', () => {
    expect(validateNewMonitor(baseInput({ metricId: null })).ok).toBe(false)
    expect(validateNewMonitor(baseInput({ targetKind: 'pipeline' as never })).ok).toBe(false)
  })

  it('合法输入归一化：dry_run 不在入参（建行恒 true），cooldown 默认 3600', () => {
    const r = validateNewMonitor(baseInput())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.cooldownSecs).toBe(3600)
      expect(r.value.channelPolicy).toBe('in_app')
      expect(Object.hasOwn(r.value, 'dryRun')).toBe(false)
    }
  })
})

describePg('monitor 存储层（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let idA = ''
  let idB = ''

  beforeAll(async () => {
    // 幂等：连跑两次迁移都必须不报错（部署每次全量重跑）。
    await applyMigrations(pool)
    await applyMigrations(pool)
    await pool.query('delete from data.monitor_run where org = any($1)', [[ORG_R, OTHER_R]])
    await pool.query('delete from data.monitor where org = any($1)', [[ORG_R, OTHER_R]])
    idA = (await createMonitor(pool, baseInput({ name: 'A' }))).id
    idB = (await createMonitor(pool, baseInput({ name: 'B', org: OTHER_R }))).id
  })

  afterAll(async () => {
    await pool.query('delete from data.monitor_run where org = any($1)', [[ORG_R, OTHER_R]])
    await pool.query('delete from data.monitor where org = any($1)', [[ORG_R, OTHER_R]])
    await pool.end()
  })

  it('建行恒 dry_run=true；按 org 隔离', async () => {
    const mine = await listMonitors(pool, ORG_R)
    expect(mine.map((m) => m.id)).toEqual([idA])
    expect(mine[0].dryRun).toBe(true)
    // V2b 默认值：防抖关闭（1 次即触发）与 streak 归零。
    expect(mine[0]).toMatchObject({ minBreachEvals: 1, consecutiveBreach: 0 })
    expect((await listMonitors(pool, OTHER_R)).map((m) => m.id)).toEqual([idB])
  })

  it('no_flap 参数落库（V2b）', async () => {
    const { id } = await createMonitor(pool, baseInput({ name: '防抖夹具', minBreachEvals: 3 }))
    const { rows } = await pool.query('select min_breach_evals from data.monitor where id = $1', [id])
    expect(rows[0].min_breach_evals).toBe(3)
    await pool.query('delete from data.monitor where id = $1', [id])
  })

  it('dueMonitors 只返回到期且启用的行', async () => {
    const now = new Date()
    // A：已到期（last_eval_at 早于 cadence）
    await applyOutcome(pool, { id: idA, org: ORG_R }, {
      state: 'ok', stateSince: now, lastEvalAt: new Date(now.getTime() - 301_000),
      notified: false, consecutiveFail: 0, consecutiveBreach: 0,
    })
    const due = await dueMonitors(pool, ORG_R, now, 50)
    expect(due.map((m) => m.id)).toEqual([idA])

    // 刚求值过 ⇒ 不到期
    await applyOutcome(pool, { id: idA, org: ORG_R }, {
      state: 'ok', stateSince: now, lastEvalAt: now, notified: false, consecutiveFail: 0, consecutiveBreach: 0,
    })
    expect((await dueMonitors(pool, ORG_R, now, 50)).length).toBe(0)
  })

  it('applyOutcome 跨 org 恒 0 行（SQL 层禁止跨租户写）', async () => {
    await applyOutcome(pool, { id: idB, org: ORG_R }, {
      state: 'firing', stateSince: new Date(), lastEvalAt: new Date(), notified: false, consecutiveFail: 0, consecutiveBreach: 1,
    })
    const { rows } = await pool.query('select state from data.monitor where id = $1', [idB])
    expect(rows[0].state).toBe('ok')
  })

  it('recordRun 落台账且按 org 可见', async () => {
    await recordRun(pool, {
      monitorId: idA, org: ORG_R, verdict: 'missing', value: null, watermarkRef: 'stg_x',
      stateAfter: 'firing', notified: false, dryRun: true, durationMs: 12, error: null,
    })
    const { rows } = await pool.query(
      'select verdict, notified, dry_run from data.monitor_run where monitor_id = $1', [idA])
    expect(rows).toEqual([{ verdict: 'missing', notified: false, dry_run: true }])
  })

  it('配额：第 21 条启用监控被拒', async () => {
    const org = `${ORG_R}-quota`
    await pool.query('delete from data.monitor where org = $1', [org])
    for (let i = 0; i < MONITOR_QUOTA_PER_ORG; i += 1) {
      await createMonitor(pool, baseInput({ org, name: `q${i}` }))
    }
    await expect(createMonitor(pool, baseInput({ org, name: 'overflow' })))
      .rejects.toMatchObject({ code: 'MONITOR_QUOTA_EXCEEDED' })
    expect(await quotaOf(pool, org)).toEqual({ used: MONITOR_QUOTA_PER_ORG, limit: MONITOR_QUOTA_PER_ORG })
    await pool.query('delete from data.monitor where org = $1', [org])
  })

  it('updateMonitorFlags 只改传了的项（影子期开闸）', async () => {
    expect(await updateMonitorFlags(pool, ORG_R, idA, { dryRun: false })).toBe(true)
    expect(await updateMonitorFlags(pool, OTHER_R, idA, { dryRun: false })).toBe(false)
    const { rows } = await pool.query('select dry_run, enabled from data.monitor where id = $1', [idA])
    expect(rows[0]).toEqual({ dry_run: false, enabled: true })
    await updateMonitorFlags(pool, ORG_R, idA, { dryRun: true })
  })
})
