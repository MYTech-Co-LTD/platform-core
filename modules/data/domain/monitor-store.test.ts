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
  it('threshold 在 V1 直接拒绝（不建了却永不求值）', () => {
    const r = validateNewMonitor(baseInput({ verdict: 'threshold' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('MONITOR_VERDICT_UNSUPPORTED')
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
    expect((await listMonitors(pool, OTHER_R)).map((m) => m.id)).toEqual([idB])
  })

  it('dueMonitors 只返回到期且启用的行', async () => {
    const now = new Date()
    // A：已到期（last_eval_at 早于 cadence）
    await applyOutcome(pool, { id: idA, org: ORG_R }, {
      state: 'ok', stateSince: now, lastEvalAt: new Date(now.getTime() - 301_000),
      notified: false, consecutiveFail: 0,
    })
    const due = await dueMonitors(pool, ORG_R, now, 50)
    expect(due.map((m) => m.id)).toEqual([idA])

    // 刚求值过 ⇒ 不到期
    await applyOutcome(pool, { id: idA, org: ORG_R }, {
      state: 'ok', stateSince: now, lastEvalAt: now, notified: false, consecutiveFail: 0,
    })
    expect((await dueMonitors(pool, ORG_R, now, 50)).length).toBe(0)
  })

  it('applyOutcome 跨 org 恒 0 行（SQL 层禁止跨租户写）', async () => {
    await applyOutcome(pool, { id: idB, org: ORG_R }, {
      state: 'firing', stateSince: new Date(), lastEvalAt: new Date(), notified: false, consecutiveFail: 0,
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
