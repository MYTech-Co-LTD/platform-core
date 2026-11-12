// metric-change-preview.test.ts —— 试算纯函数（execute 全注入，不碰真仓库）。
// 隔离键与其它文件不同：org=org-p0-mc-preview；L1 夹具落平台桶（upsertL1Metric 固定写
// org='platform'）⇒ 隔离靠**文件专属指标 id**（不与真实物化 L1 撞名），afterAll 按精确 id 回收。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { getChange, submitChange } from './metric-change'
import type { MetricChangeRow } from './metric-change'
import { applyPreview, PREVIEW_TIMEOUT_MS, previewWindow, runPreview, timeColumnOf } from './metric-change-preview'

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
    status: 'draft', preview: null, submittedBy: 'a', submittedChannel: 'pat',
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
