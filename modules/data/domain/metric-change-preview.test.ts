// metric-change-preview.test.ts —— 试算纯函数（execute 全注入，不碰真仓库）。
// 隔离键与其它文件不同：org=org-p0-mc-preview；L1 夹具落平台桶（upsertL1Metric 固定写
// org='platform'）⇒ 隔离靠**文件专属指标 id**（不与真实物化 L1 撞名），afterAll 按精确 id 回收。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { getChange, submitChange } from './metric-change'
import type { MetricChangeRow } from './metric-change'
import {
  applyPreview, PREVIEW_RERUN_MIN_INTERVAL_MS, PREVIEW_TIMEOUT_MS, previewTooRecent, previewWindow,
  runPreview, timeColumnOf,
} from './metric-change-preview'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-mc-preview'
const L1_ID = 'b:p0mc_preview_sales'
/** L1 夹具：字段以 metric-store.ts 的 L1MetricDef 为准（masks/slaDays/freshnessRelations/sourceSystem 必填）。 */
const L1_FIXTURE = {
  id: L1_ID,
  title: '销售(试算夹具)',
  description: 'metric-change-preview 测试夹具',
  requiredScope: null,
  subjectColumn: 'org',
  // 形状契约（parseL1Select）：`select <表达式> as value[, <维度>…] from <关系>`——
  // 不能带 FROM 别名（尾随 ` t` 会让 L1_SELECT_RE 不匹配 ⇒ BAD_BASE_SQL）。
  selectSql: 'select sum(t.amt) as value, org, bizday from marts.f',
  groupBy: 'org, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}

function row(kind: MetricChangeRow['kind'], payload: unknown, metricId = 'x:net'): MetricChangeRow {
  return {
    id: 1, org: ORG, metricId, kind, payload: payload as Record<string, unknown>,
    status: 'draft', preview: null, previewHistory: [], submittedBy: 'a', submittedChannel: 'pat',
    submittedAt: '2026-11-12T00:00:00Z', decidedBy: null, decidedAt: null, rejectReason: null,
  }
}

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
  // 隔离键自清扫（同 metric-change.test.ts 约定）：只删本文件专属 org。
  await pool.query('delete from data.metric_change where org = $1', [ORG])
  await pool.query('delete from data.metrics where org = $1', [ORG])
})
afterAll(async () => {
  // 平台桶只回收本文件的夹具行（精确 id；不碰其它 53+ 条真实 L1）。
  await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_ID])
  await pool.end()
})

describe('timeColumnOf / previewWindow', () => {
  it('从 group_by 里认出时间列（bizday 优先），没有则 null', () => {
    expect(timeColumnOf('system_book, bizday')).toBe('bizday')
    expect(timeColumnOf('day')).toBe('day')
    expect(timeColumnOf('system_book')).toBeNull()
  })
  it('窗口 = 北京时区 [昨天-7, 昨天]', () => {
    const w = previewWindow()
    expect(w.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(7 * 86_400_000)
  })
  it('PREVIEW_TIMEOUT_MS 常量钉住（Task 4/5 引用它）', () => {
    expect(PREVIEW_TIMEOUT_MS).toBe(10_000)
  })
})

describe('previewTooRecent（重跑限速判据，P4 Task 4 销缓办①；纯函数，时钟注入）', () => {
  const NOW = Date.parse('2026-11-13T10:00:00.000Z')
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString()

  it('窗口常量钉住：60s', () => {
    expect(PREVIEW_RERUN_MIN_INTERVAL_MS).toBe(60_000)
  })
  it('成功快照 ranAt 在窗口内（<60s）⇒ true', () => {
    expect(previewTooRecent({ ranAt: at(30_000) }, NOW)).toBe(true)
    expect(previewTooRecent({ value: 1, rows: 2, ranAt: at(1_000) }, NOW)).toBe(true)
  })
  it('失败对象也有 ranAt（preview_failed 同样限速）⇒ true', () => {
    expect(previewTooRecent({ error: 'METRIC_NOT_FOUND', ranAt: at(5_000) }, NOW)).toBe(true)
  })
  it('边界：恰好/超过 60s ⇒ false（窗口外可重跑，不锁单）', () => {
    expect(previewTooRecent({ ranAt: at(60_000) }, NOW)).toBe(false)
    expect(previewTooRecent({ ranAt: at(120_000) }, NOW)).toBe(false)
  })
  it('null / 非对象 / 缺 ranAt / 坏时间串 ⇒ false（首跑与历史脏数据不误伤）', () => {
    expect(previewTooRecent(null, NOW)).toBe(false)
    expect(previewTooRecent(undefined, NOW)).toBe(false)
    expect(previewTooRecent('2026-11-13T09:59:30.000Z', NOW)).toBe(false)
    expect(previewTooRecent([], NOW)).toBe(false)
    expect(previewTooRecent({}, NOW)).toBe(false)
    expect(previewTooRecent({ ranAt: 'not-a-date' }, NOW)).toBe(false)
    expect(previewTooRecent({ ranAt: 123 }, NOW)).toBe(false)
  })
})

describe('runPreview（delete/meta 档：纯函数，execute 全注入）', () => {
  it('delete/meta 档：无编译，快照 value 可为 null 但 rows 必须有（当前口径仍可算）', async () => {
    const fakePool = { query: async () => ({ rows: [{ select_sql: 'select sum(x) as value, bizday from m', group_by: 'bizday' }] }) } as never
    const execute = async () => ({ rows: [{ rows: 3, value: 42 }] })
    const out = await runPreview({ pool: fakePool, execute }, ORG, row('delete', {}))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.snapshot.rows).toBe(3)
  })

  it('delete 档：指标行不存在 ⇒ ok:false / METRIC_NOT_FOUND', async () => {
    const fakePool = { query: async () => ({ rows: [] }) } as never
    const execute = async () => ({ rows: [] })
    const out = await runPreview({ pool: fakePool, execute }, ORG, row('delete', {}))
    expect(out).toEqual({ ok: false, error: 'METRIC_NOT_FOUND' })
  })
})

describePg('runPreview（create 档：编译 L1 夹具）', () => {
  it('create(refine)：值 + 行数 + baseline Δ + 样本 + 哈希', async () => {
    // 编译需要 L1 目录：夹具一条（平台桶，文件专属 id）
    const { upsertL1Metric } = await import('./metric-store')
    await upsertL1Metric(pool, L1_FIXTURE)
    const calls: string[] = []
    const execute = async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      void params
      if (sql.includes('p.bizday')) return { rows: [{ rows: 12, value: 900 }] }   // 窗口聚合
      if (sql.startsWith('select count')) return { rows: [{ rows: 12, value: 900 }] }
      return { rows: [{ org: 'A', bizday: '2026-11-11', value: 900 }] }          // sample
    }
    const out = await runPreview({ pool, execute }, ORG, row('create', { baseMetric: L1_ID, op: { kind: 'refine' } }))
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.snapshot.rows).toBe(12)
      expect(out.snapshot.value).toBe(900)
      expect(out.snapshot.baseline?.id).toBe(L1_ID)
      expect(out.snapshot.baseline?.deltaPct).toBe(0)
      expect(out.snapshot.sample.length).toBeGreaterThan(0)
      expect(out.snapshot.compiledHash).toMatch(/^[0-9a-f]{64}$/)
      expect(out.snapshot.window).not.toBeNull()
      // 求值 SQL 带了窗口参数（时间列从 group_by 认出 ⇒ between $1 and $2）
      expect(calls.some((s) => s.includes('between $1 and $2'))).toBe(true)
    }
  })
})

describePg('applyPreview', () => {
  it('成功 ⇒ preview_ready + 快照落库；失败 ⇒ preview_failed', async () => {
    const sub = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:ap', 'meta', { bizDescription: '试算回写' })
    if (!sub.ok) throw new Error('unreachable')
    const snapshot = {
      window: { from: '2026-11-04', to: '2026-11-11' }, value: 1, rows: 2, baseline: null,
      sample: [], compiledHash: 'a'.repeat(64), ranAt: '2026-11-12T00:00:00Z', durationMs: 3,
    }
    await applyPreview(pool, sub.change.id, { ok: true, snapshot })
    const ready = await getChange(pool, ORG, sub.change.id)
    expect(ready?.status).toBe('preview_ready')
    expect(ready?.preview).toMatchObject({ value: 1, rows: 2, window: { to: '2026-11-11' } })

    await applyPreview(pool, sub.change.id, { ok: false, error: 'PREVIEW_TIMEOUT' })
    const failed = await getChange(pool, ORG, sub.change.id)
    expect(failed?.status).toBe('preview_failed')
    expect(failed?.preview).toMatchObject({ error: 'PREVIEW_TIMEOUT' })
  })

  it('失败回写带 issues ⇒ preview 一并落库（P4 Task 4，销缓办⑥：失败明细不只剩一个错误码）', async () => {
    const sub = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:ap_issues', 'meta', { unit: '元' })
    if (!sub.ok) throw new Error('unreachable')
    await applyPreview(pool, sub.change.id, {
      ok: false, error: 'DECLARATION_INVALID', issues: [{ path: 'expression', message: 'relation 不在白名单' }],
    })
    const after = await getChange(pool, ORG, sub.change.id)
    expect(after?.status).toBe('preview_failed')
    expect(after?.preview).toMatchObject({
      error: 'DECLARATION_INVALID',
      issues: [{ path: 'expression', message: 'relation 不在白名单' }],
    })
    expect(typeof after?.preview?.ranAt).toBe('string')
  })

  it('已终态单（adopted）上 applyPreview 不改状态（P1 Task 4 修复②：UPDATE 钉 PENDING，重跑落后于采纳不得复活单据）', async () => {
    const sub = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:ap_done', 'meta', { unit: '元' })
    if (!sub.ok) throw new Error('unreachable')
    await pool.query(
      `update data.metric_change set status = 'adopted', decided_by = 'r', decided_at = now() where id = $1`,
      [sub.change.id],
    )
    const snapshot = {
      window: { from: '2026-11-04', to: '2026-11-11' }, value: 1, rows: 2, baseline: null,
      sample: [], compiledHash: 'a'.repeat(64), ranAt: '2026-11-12T00:00:00Z', durationMs: 3,
    }
    // 成功路径：rowCount=0 ⇒ 静默跳过（单已终态，试算结果作废），状态不得被写回 preview_ready
    await applyPreview(pool, sub.change.id, { ok: true, snapshot })
    expect((await getChange(pool, ORG, sub.change.id))?.status).toBe('adopted')
    // 失败路径同款：终态单也不得被写成 preview_failed
    await applyPreview(pool, sub.change.id, { ok: false, error: 'PREVIEW_TIMEOUT' })
    expect((await getChange(pool, ORG, sub.change.id))?.status).toBe('adopted')
  })
})

describePg('applyPreview 快照历史（P1 Task 5，销缓办①）', () => {
  const snapOf = (v: number) => ({
    window: { from: '2026-11-04', to: '2026-11-11' }, value: v, rows: v * 2, baseline: null,
    sample: [], compiledHash: 'a'.repeat(64), ranAt: `2026-11-12T00:00:0${v}Z`, durationMs: v,
  })
  const submit = (metricId: string, payload: Record<string, unknown>) =>
    submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, metricId, 'meta', payload)

  it('首跑：history 归一为空数组（不是 null）', async () => {
    const sub = await submit('x:hist_first', { unit: '元' })
    if (!sub.ok) throw new Error('unreachable')
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(1) })
    const after = await getChange(pool, ORG, sub.change.id)
    expect(after?.previewHistory).toEqual([])
  })

  it('重跑两次：history 长 1、最新在前（被顶掉的首跑快照在 history[0]）', async () => {
    const sub = await submit('x:hist_two', { unit: '个' })
    if (!sub.ok) throw new Error('unreachable')
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(1) })
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(2) })
    const after = await getChange(pool, ORG, sub.change.id)
    expect(after?.status).toBe('preview_ready')
    expect(after?.preview).toMatchObject({ value: 2 })
    expect(after?.previewHistory).toHaveLength(1)
    expect(after?.previewHistory?.[0]).toMatchObject({ value: 1 })
  })

  it('封顶 5 条 FIFO：第 6 条进 history 时丢最旧，最新始终在前', async () => {
    const sub = await submit('x:hist_cap', { caliberNote: 'cap' })
    if (!sub.ok) throw new Error('unreachable')
    for (const v of [1, 2, 3, 4, 5, 6]) await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(v) })
    const atSix = await getChange(pool, ORG, sub.change.id)
    expect(atSix?.previewHistory?.map((s) => s.value)).toEqual([5, 4, 3, 2, 1]) // 封顶先到，尚无丢失
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(7) })
    const after = await getChange(pool, ORG, sub.change.id)
    expect(after?.preview).toMatchObject({ value: 7 })
    expect(after?.previewHistory?.map((s) => s.value)).toEqual([6, 5, 4, 3, 2]) // 最旧（1）已丢
  })

  it('失败回写也保历史：旧成功快照进 history，失败错误对象成为当前 preview', async () => {
    const sub = await submit('x:hist_fail', { unit: '件' })
    if (!sub.ok) throw new Error('unreachable')
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(1) })
    await applyPreview(pool, sub.change.id, { ok: false, error: 'PREVIEW_TIMEOUT' })
    const after = await getChange(pool, ORG, sub.change.id)
    expect(after?.status).toBe('preview_failed')
    expect(after?.preview).toMatchObject({ error: 'PREVIEW_TIMEOUT' })
    expect(after?.previewHistory).toHaveLength(1)
    expect(after?.previewHistory?.[0]).toMatchObject({ value: 1 })
  })

  it('终态单（adopted）整行不动：history 不写、preview 不换、adopted_snapshot 仍是采纳时刻快照', async () => {
    const sub = await submit('x:hist_done', { bizDescription: '历史钉' })
    if (!sub.ok) throw new Error('unreachable')
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(1) })
    // 采纳时刻的凭据 = 当时的 preview（snapOf(1)）；直接翻状态模拟采纳落账
    await pool.query(
      `update data.metric_change set status = 'adopted', decided_by = 'r', decided_at = now(), adopted_snapshot = preview where id = $1`,
      [sub.change.id],
    )
    const before = await getChange(pool, ORG, sub.change.id)
    // 迟到的重跑（成功+失败各一次）都不得碰任何列
    await applyPreview(pool, sub.change.id, { ok: true, snapshot: snapOf(9) })
    await applyPreview(pool, sub.change.id, { ok: false, error: 'PREVIEW_TIMEOUT' })
    const after = await getChange(pool, ORG, sub.change.id)
    expect(after).toEqual(before)
    const snap = await pool.query('select adopted_snapshot from data.metric_change where id = $1', [sub.change.id])
    expect(snap.rows[0]?.adopted_snapshot).toMatchObject({ value: 1 }) // 采纳时刻的 preview，未被 9 污染
  })
})
