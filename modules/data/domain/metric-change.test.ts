// metric-change.test.ts — 变更单状态机 + 采纳/驳回（P0）。隔离键与其它文件不同。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { submitChange, listChanges, getChange, withdrawChange, adoptChange, rejectChange } from './metric-change'
import { applyPreview } from './metric-change-preview'
import { upsertL1Metric } from './metric-store'
import { writeL2Declaration } from './metric-write'
import type { MetricWriteDeps } from './metric-write'
import type { Requester } from './authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-metric-change'
const DECL = { baseMetric: 'b:sales', op: { kind: 'refine' }, alias: '我的销售' }
// 采纳用例的 L1 夹具：文件专属 id（不与真实物化 L1 撞名，upsertL1Metric 固定写平台桶），
// sourceSystem='lemeng' 与 writeDeps.adoptedSources 对齐（源接入闸）。
const L1_ID = 'b:p0mc_adopt_sales'
const L1_FIXTURE = {
  id: L1_ID,
  title: '销售(采纳夹具)',
  description: 'metric-change 测试夹具',
  requiredScope: null,
  subjectColumn: 'org',
  // 形状契约（parseL1Select）：`select <表达式> as value[, <维度>…] from <关系>`——不带 FROM 别名。
  selectSql: 'select sum(t.amt) as value, org, bizday from marts.f',
  groupBy: 'org, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}
const DECL_ADOPT = { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '我的销售' }
/**
 * declaration 档的**关系白名单夹具**（P5 CI 修复）：B11 白名单来自平台桶 L1 行的 selectSql
 * 关系（`compileNewDeclaration` 的 `allowedRelations`）。空库里没有真实物化的
 * `fct_retail_sale` ⇒ declaration 的 expression 会被判「未纳管关系」。本地曾因其它测试文件
 * 残留的 L1 行假绿——这里自建一条同关系的 L1，让白名单自足，不依赖执行顺序/残留数据。
 * id 与 title 均文件专属（平台桶跨文件共用；文件并行时各删各的）。
 */
const DECL_REL_L1_ID = 'p5mc:l1:decl_sales_fixture'
const DECL_REL_L1 = {
  id: DECL_REL_L1_ID,
  title: '声明关系白名单·metric-change',
  description: 'declaration 档 B11 关系白名单夹具',
  requiredScope: null,
  subjectColumn: 'org',
  selectSql: 'select sum(fct_retail_sale.sale_amount) as value, system_book, bizday from fct_retail_sale',
  groupBy: 'system_book, bizday',
  params: {},
  sourceSystem: 'lemeng',
  slaDays: 1,
  freshnessRelations: [],
  masks: null,
}
// 删档用例单用一份声明（别名错开）：047 部门内同名互斥后，x:adopt_me 与 x:del_me 两个 id
// 共用「我的销售」会在同 org 同桶撞 metrics_title_per_dept_uq（这正是 P1 要的行为）。
const DECL_DEL = { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '我的销售·删档' }

/** 身份夹具（同 metric-write.test.ts 形状）：pat 通道带 keyId，审计身份三件套非空。 */
const REQ: Requester = {
  userId: 'reviewer', orgId: ORG, channel: 'pat', keyId: 3, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
}
const writeDeps = (p: Pool): MetricWriteDeps => ({ pool: p, adoptedSources: new Set(['lemeng']), requester: REQ })

/** 把单据直接推到 preview_ready（跳过试算执行：采纳链路只关心状态与快照在位）。 */
async function markReady(id: number, preview: Record<string, unknown> = { rows: 1 }): Promise<void> {
  await pool.query(`update data.metric_change set status = 'preview_ready', preview = $2::jsonb where id = $1`,
    [id, JSON.stringify(preview)])
}

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
  // 隔离键自清扫（同 audit-store / asset-auth 约定）：重复跑本文件时旧单会累积，
  // 「重复提交 ⇒ 旧单 superseded 恰一条」的断言需要干净起点。只删本文件专属 ORG。
  await pool.query('delete from data.metric_change where org = $1', [ORG])
  await pool.query('delete from data.metrics where org = $1', [ORG])
})
afterAll(async () => {
  // 平台桶只回收本文件的夹具行（精确 id；不碰真实物化 L1）。
  await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1", [L1_ID])
  await pool.end()
})

describePg('submitChange', () => {
  it('create 档：合法声明落单（draft），重复提交把旧单 superseded', async () => {
    const r1 = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:net_sales', 'create', DECL)
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.change.status).toBe('draft')

    const r2 = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:net_sales', 'create', { ...DECL, alias: '改' })
    expect(r2.ok).toBe(true)
    const all = await listChanges(pool, ORG)
    expect(all.filter((c) => c.metricId === 'x:net_sales' && c.status === 'superseded')).toHaveLength(1)
    expect(all.filter((c) => c.metricId === 'x:net_sales' && c.status === 'draft')).toHaveLength(1)
  })

  it('自由 SQL 字段 ⇒ INVALID_DECLARATION（结构化声明纪律）', async () => {
    const r = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:bad', 'create',
      { baseMetric: 'b:sales', op: { kind: 'refine' }, selectSql: 'select 1' })
    expect(r).toMatchObject({ ok: false, error: 'INVALID_DECLARATION' })
  })

  it('meta 档：三字段字符串；非法类型 ⇒ INVALID_META', async () => {
    const ok = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_ok', 'meta',
      { bizDescription: '不含税', unit: '元', caliberNote: '' })
    expect(ok.ok).toBe(true)
    const bad = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_bad', 'meta',
      { bizDescription: 123 })
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_META' })
  })

  it('meta 档判据（P1 Task 3 订正，销缓办④）：三键全缺（{}）⇒ INVALID_META；带键但值空（{unit:\'\'} / 三键全空串）是显式清空提案，合法立单', async () => {
    // 空对象：采纳链一个字段都不动（EMPTY_META_PATCH 死单）⇒ 提交时就拒，不让它进队列（P0 终审 F3 保留）
    const empty = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_empty', 'meta', {})
    expect(empty).toMatchObject({ ok: false, error: 'INVALID_META' })
    // 带键但值空：updateMetricMeta 把 '' 收口成 null 写库（显式清空契约），单是可采纳的——P0 判它
    // 「恒死单」是注释错案，P1 订正（采纳后置 null 的端到端断言在 adoptChange 组）
    const clear = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_clear_unit', 'meta', { unit: '' })
    expect(clear.ok).toBe(true)
    const blank = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_blank', 'meta',
      { bizDescription: '', unit: '', caliberNote: '' })
    expect(blank.ok).toBe(true)
    // 至少一键有实质内容（非空白）⇒ 仍是合法提案
    const one = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_unit', 'meta', { unit: '元' })
    expect(one.ok).toBe(true)
  })

  it('withdraw 只允许提交者本人', async () => {
    const r = await submitChange(pool, ORG, { userId: 'u1', channel: 'pat' }, 'x:w', 'create', DECL)
    if (!r.ok) throw new Error('unreachable')
    expect(await withdrawChange(pool, ORG, r.change.id, '别人')).toBe(false)
    expect(await withdrawChange(pool, ORG, r.change.id, 'u1')).toBe(true)
  })
})

describePg('adoptChange / rejectChange', () => {
  it('未试算（draft）⇒ 409 PREVIEW_UNAVAILABLE；不生效任何东西', async () => {
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:no_preview', 'create', DECL)
    if (!s.ok) throw new Error('unreachable')
    const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
    expect(out).toMatchObject({ ok: false, error: 'PREVIEW_UNAVAILABLE' })
    // 未生效：data.metrics 里不得出现该指标
    const live = await pool.query(`select id from data.metrics where org = $1 and id = 'x:no_preview'`, [ORG])
    expect(live.rows).toHaveLength(0)
  })

  it('preview_ready ⇒ 采纳走唯一编译点：data.metrics 出现行，单据 adopted 且带快照', async () => {
    await upsertL1Metric(pool, L1_FIXTURE)
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'create', DECL_ADOPT)
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
    expect(out.ok).toBe(true)
    const live = await pool.query(`select id, title from data.metrics where org = $1 and id = $2`, [ORG, 'x:adopt_me'])
    expect(live.rows[0]?.title).toBe('我的销售')
    const after = await getChange(pool, ORG, s.change.id)
    expect(after?.status).toBe('adopted')
    expect(after?.decidedBy).toBe('reviewer')
    expect(after?.decidedAt).not.toBeNull()
    expect(after?.preview).toMatchObject({ rows: 1 })
  })

  it('adopted_snapshot = 采纳时刻的 preview；采纳后的迟到重跑不污染（P1 Task 5 Step1 钉死）', async () => {
    await upsertL1Metric(pool, L1_FIXTURE)
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:snap_pin', 'create',
      { ...DECL_ADOPT, alias: '我的销售·快照钉' })
    if (!s.ok) throw new Error('unreachable')
    const snapOf = (v: number) => ({
      window: { from: '2026-11-04', to: '2026-11-11' }, value: v, rows: v, baseline: null,
      sample: [], compiledHash: 'b'.repeat(64), ranAt: `2026-11-12T01:00:0${v}Z`, durationMs: v,
    })
    await applyPreview(pool, s.change.id, { ok: true, snapshot: snapOf(1) })
    const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
    expect(out.ok).toBe(true)
    const snap1 = await pool.query('select adopted_snapshot, status from data.metric_change where id = $1', [s.change.id])
    expect(snap1.rows[0]?.status).toBe('adopted')
    expect(snap1.rows[0]?.adopted_snapshot).toMatchObject({ value: 1 }) // 采纳时刻的 preview
    // 采纳后的迟到重跑：UPDATE 钉 PENDING ⇒ 整行不动，快照不被新值污染
    await applyPreview(pool, s.change.id, { ok: true, snapshot: snapOf(2) })
    const snap2 = await pool.query('select adopted_snapshot, status, preview, preview_history from data.metric_change where id = $1', [s.change.id])
    expect(snap2.rows[0]?.adopted_snapshot).toMatchObject({ value: 1 })
    expect(snap2.rows[0]?.preview).toMatchObject({ value: 1 })
    expect(snap2.rows[0]?.preview_history).toEqual([])
    expect(snap2.rows[0]?.status).toBe('adopted')
  })

  it('重复采纳 ⇒ 409 CHANGE_STATE_CHANGED（CAS：已决单不再吃第二次采纳）', async () => {
    const adopted = (await listChanges(pool, ORG, 'adopted')).find((c) => c.metricId === 'x:adopt_me')
    if (adopted === undefined) throw new Error('前置缺失')
    const again = await adoptChange(writeDeps(pool), ORG, adopted.id)
    expect(again).toMatchObject({ ok: false, error: 'CHANGE_STATE_CHANGED' })
  })

  it('meta 档采纳：只动声明了的字段（缺席键不得清空既有值）', async () => {
    // 第一张：两字段都写 → 生效
    const s1 = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'meta',
      { bizDescription: '含税口径', unit: '元' })
    if (!s1.ok) throw new Error('unreachable')
    await markReady(s1.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, s1.change.id)).ok).toBe(true)
    const row1 = await pool.query(
      `select biz_description, unit, caliber_note from data.metrics where org = $1 and id = 'x:adopt_me'`, [ORG])
    expect(row1.rows[0]?.biz_description).toBe('含税口径')
    expect(row1.rows[0]?.unit).toBe('元')
    // 第二张：只声明 unit → bizDescription 缺席键必须保持原值（updateMetricMeta 语义：缺席=不改）
    const s2 = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'meta', { unit: '万元' })
    if (!s2.ok) throw new Error('unreachable')
    await markReady(s2.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, s2.change.id)).ok).toBe(true)
    const row2 = await pool.query(
      `select biz_description, unit from data.metrics where org = $1 and id = 'x:adopt_me'`, [ORG])
    expect(row2.rows[0]?.biz_description).toBe('含税口径')
    expect(row2.rows[0]?.unit).toBe('万元')
  })

  it('meta 档显式清空（{unit:\'\'}）采纳后 unit 置 null（P1 Task 3，销缓办④的显式清空契约）', async () => {
    // 前置：上一用例把 x:adopt_me 的 unit 改成 '万元'；本单只带 unit:'' ⇒ 显式清空
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'meta', { unit: '' })
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, s.change.id)).ok).toBe(true)
    const row = await pool.query(`select unit from data.metrics where org = $1 and id = 'x:adopt_me'`, [ORG])
    expect(row.rows[0]?.unit).toBeNull()
  })

  it('delete 档采纳：唯一编译点删除 L2 行，单据 adopted 留凭据', async () => {
    const mk = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:del_me', 'create', DECL_DEL)
    if (!mk.ok) throw new Error('unreachable')
    await markReady(mk.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, mk.change.id)).ok).toBe(true)
    const del = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:del_me', 'delete', {})
    if (!del.ok) throw new Error('unreachable')
    await markReady(del.change.id)
    const out = await adoptChange(writeDeps(pool), ORG, del.change.id)
    expect(out.ok).toBe(true)
    const live = await pool.query(`select id from data.metrics where org = $1 and id = 'x:del_me'`, [ORG])
    expect(live.rows).toHaveLength(0)
    expect((await getChange(pool, ORG, del.change.id))?.status).toBe('adopted')
  })

  it('delete 档 payload 收宽（下线提案尾波）：{reason?} 可立单，strict 闭集拒其余键', async () => {
    // 夹具：一行可删的 L2（payload 校验在 id 预检**之后**，行不存在会先 404 掩盖 payload 判定）
    const mk = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:del_payload', 'create',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '我的销售·payload' })
    if (!mk.ok) throw new Error('unreachable')
    await markReady(mk.change.id)
    expect((await adoptChange(writeDeps(pool), ORG, mk.change.id)).ok).toBe(true)

    // 合法：可选 reason（1–500 字）落 payload —— job 提单的人面展示文案
    const withReason = await submitChange(pool, ORG, { userId: 'j', channel: 'job' }, 'x:del_payload', 'delete',
      { reason: '连续 90 天 0 次使用（报表引用已排除）' })
    expect(withReason.ok).toBe(true)
    if (withReason.ok) {
      expect(withReason.change.status).toBe('draft')
      expect(withReason.change.payload).toEqual({ reason: '连续 90 天 0 次使用（报表引用已排除）' })
    }
    // 合法：空对象（旧判据原样保留）
    expect((await submitChange(pool, ORG, { userId: 'j', channel: 'job' }, 'x:del_payload', 'delete', {})).ok).toBe(true)

    // 非法：未知键（strict 闭集——给提案留出处，不给自由载荷开口子）
    expect(await submitChange(pool, ORG, { userId: 'j', channel: 'job' }, 'x:del_payload', 'delete',
      { reason: 'r', foo: 1 })).toMatchObject({ ok: false, error: 'INVALID_DECLARATION' })
    // 非法：空串 reason（min(1)）与超长 reason（max(500)）
    expect(await submitChange(pool, ORG, { userId: 'j', channel: 'job' }, 'x:del_payload', 'delete',
      { reason: '' })).toMatchObject({ ok: false, error: 'INVALID_DECLARATION' })
    expect(await submitChange(pool, ORG, { userId: 'j', channel: 'job' }, 'x:del_payload', 'delete',
      { reason: 'x'.repeat(501) })).toMatchObject({ ok: false, error: 'INVALID_DECLARATION' })
  })

  it('驳回必填原因；驳回后单据 rejected 且原因可读', async () => {
    // P1 起提交面有部门内同名互斥：x:adopt_me 已带「我的销售」生效行，这里 alias 必须错开
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:rej', 'create', { ...DECL, alias: '我的销售·驳回' })
    if (!s.ok) throw new Error('unreachable')
    expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '')).toBe(false)
    expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '差 12%，疑似含退货')).toBe(true)
    const after = await getChange(pool, ORG, s.change.id)
    expect(after?.status).toBe('rejected')
    expect(after?.rejectReason).toBe('差 12%，疑似含退货')
    expect(after?.decidedBy).toBe('reviewer')
    // 已决单不可再驳回（状态机单向）
    expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '再驳一次')).toBe(false)
  })
})

// ── P1 Task 3（2026-11-12）：payload 带归属 + create 撞 id + 同名互斥 ──────────────
// 隔离键独立（org-p1-mo-change，计划全局约束）：同名互斥与撞 id 判据都是
// (org, coalesce(owner_dept,''), lower(title)) / (org, id) 作用域——与上方 P0 用例的 org
// 互不可见。概念判据用**租户概念**（data.metric_concept 插行），不依赖仓内 YAML 的实体清单。
describePg('P1 Task 3：归属随单 + 同名互斥 + 撞 id 拒收', () => {
  const PORG = 'org-p1-mo-change'
  const CONCEPT = 'p1mo_concept'
  const OWN_DECL = {
    baseMetric: L1_ID, op: { kind: 'refine' }, alias: '部门毛利·P1MO',
    entity: CONCEPT, synonyms: ['毛利别名'], ownerDept: 'dept-mo', variantNote: '只算自营仓',
  }

  beforeAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [PORG])
    await pool.query('delete from data.metrics where org = $1', [PORG])
    await pool.query('delete from data.metric_concept where org = $1', [PORG])
    await pool.query(
      'insert into data.metric_concept (org, name, label, created_by) values ($1, $2, $3, $4)',
      [PORG, CONCEPT, 'P1MO 测试概念', 'fixture'])
    await upsertL1Metric(pool, L1_FIXTURE)
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [PORG])
    await pool.query('delete from data.metrics where org = $1', [PORG])
    await pool.query('delete from data.metric_concept where org = $1', [PORG])
  })

  it('带归属 create：提交落单 → 采纳后 data.metrics 行带 owner_dept/variant_note/entity/synonyms', async () => {
    const s = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m1', 'create', OWN_DECL)
    expect(s.ok).toBe(true)
    if (s.ok) {
      // 单据 payload 原样保留归属字段（采纳读它；声明形状校验不得吞键）
      expect(s.change.payload).toMatchObject({ entity: CONCEPT, ownerDept: 'dept-mo', variantNote: '只算自营仓' })
      await markReady(s.change.id)
      expect((await adoptChange(writeDeps(pool), PORG, s.change.id)).ok).toBe(true)
    }
    const row = await pool.query(
      `select owner_dept, variant_note, entity, synonyms from data.metrics where org = $1 and id = 'x:p1mo_m1'`, [PORG])
    expect(row.rows[0]).toMatchObject({
      owner_dept: 'dept-mo', variant_note: '只算自营仓', entity: CONCEPT, synonyms: ['毛利别名'],
    })
  })

  it('同名互斥：同部门同名 409 TITLE_EXISTS_IN_DEPT；异部门桶放行；update 档保留自身 title 放行', async () => {
    // 前置：x:p1mo_m1 已生效（title=部门毛利·P1MO，桶 dept-mo）
    const same = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m2', 'create', { ...OWN_DECL })
    expect(same).toMatchObject({ ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' })
    // 同 title 换部门桶 = 另一个命名空间，放行
    const otherDept = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m2', 'create',
      { ...OWN_DECL, ownerDept: 'dept-other' })
    expect(otherDept.ok).toBe(true)
    // update 档：保留自身 title（excludeMetricId = 自身）⇒ 放行（不是 409）
    const self = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m1', 'update', OWN_DECL)
    expect(self.ok).toBe(true)
  })

  it('无 alias 的 refine：生效 title 继承基底 L1 行 title（与编译点同推导），同 title 即 409', async () => {
    const r1 = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_r1', 'create',
      { baseMetric: L1_ID, op: { kind: 'refine' } })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      await markReady(r1.change.id)
      expect((await adoptChange(writeDeps(pool), PORG, r1.change.id)).ok).toBe(true)
    }
    // 基底 title（'销售(采纳夹具)'）已被 r1 的生效行占用 ⇒ 第二条无 alias 的 refine 提交即 409
    const r2 = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_r2', 'create',
      { baseMetric: L1_ID, op: { kind: 'refine' } })
    expect(r2).toMatchObject({ ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' })
  })

  it('无 alias 的 expr：生效 title = 派生 title（compileExpr 同式），同式即 409', async () => {
    const exprDecl = { op: { kind: 'expr', expr: { kind: 'ref', id: L1_ID } } }
    const e1 = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_e1', 'create', exprDecl)
    expect(e1.ok).toBe(true)
    if (e1.ok) {
      await markReady(e1.change.id)
      expect((await adoptChange(writeDeps(pool), PORG, e1.change.id)).ok).toBe(true)
    }
    const e2 = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_e2', 'create', exprDecl)
    expect(e2).toMatchObject({ ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' })
  })

  it('未知概念 ⇒ 400 UNKNOWN_CONCEPT（平台 entities ∪ 租户概念并集之外）', async () => {
    const s = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_c1', 'create',
      { ...OWN_DECL, alias: '未知概念夹具', entity: 'p1mo_nope_xyz' })
    expect(s).toMatchObject({ ok: false, http: 400, error: 'UNKNOWN_CONCEPT' })
  })

  it('create 撞已有 (org, id) 行 ⇒ 400 METRIC_ID_EXISTS；update 档仍走 upsert 语义', async () => {
    // x:p1mo_m1 已在第一个用例生效
    const s = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m1', 'create', OWN_DECL)
    expect(s).toMatchObject({ ok: false, http: 400, error: 'METRIC_ID_EXISTS' })
    const u = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m1', 'update', OWN_DECL)
    expect(u.ok).toBe(true)
  })

  it('归属字段形状越界（synonyms >16 项）⇒ 400 INVALID_DECLARATION；缺席键采纳后保留既有值（coalesce）', async () => {
    const bad = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_z', 'create',
      { ...OWN_DECL, synonyms: Array.from({ length: 17 }, (_, i) => `同义词${i}`) })
    expect(bad).toMatchObject({ ok: false, http: 400, error: 'INVALID_DECLARATION' })
    // update 只带 variantNote ⇒ entity/synonyms/owner_dept 保留（缺席 = 不改），variant_note 更新
    const s = await submitChange(pool, PORG, { userId: 'a', channel: 'pat' }, 'x:p1mo_m1', 'update',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '部门毛利·P1MO', variantNote: '改口：含加盟仓' })
    expect(s.ok).toBe(true)
    if (s.ok) {
      await markReady(s.change.id)
      expect((await adoptChange(writeDeps(pool), PORG, s.change.id)).ok).toBe(true)
    }
    const row = await pool.query(
      `select owner_dept, variant_note, entity, synonyms from data.metrics where org = $1 and id = 'x:p1mo_m1'`, [PORG])
    expect(row.rows[0]).toMatchObject({
      owner_dept: 'dept-mo', entity: CONCEPT, synonyms: ['毛利别名'], variant_note: '改口：含加盟仓',
    })
  })
})

// ── P1 Task 4（2026-11-13）：决策竞态串行化（销缓办⑥）+ 23505 映射 ────────────────
// 隔离键独立（org-p1-mo-race，计划全局约束）：竞态用例会故意制造占名行，不能与上方
// Task 3 describe 的同名判据夹具互相污染。锁键 = hashtext(org || ':mc:' || 变更单 id)，
// adopt 与 reject 争的是同一张单——org 隔离即锁键隔离。
describePg('P1 Task 4：决策竞态串行化 + adopt 撞名映射 409', () => {
  const RORG = 'org-p1-mo-race'

  beforeAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [RORG])
    await pool.query('delete from data.metrics where org = $1', [RORG])
    await upsertL1Metric(pool, L1_FIXTURE)
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [RORG])
    await pool.query('delete from data.metrics where org = $1', [RORG])
  })

  /** 立一张 preview_ready 的 create 单（竞态/持锁/占名用例的公共前置）。 */
  async function readyCreate(mid: string, alias: string): Promise<number> {
    const s = await submitChange(pool, RORG, { userId: 'a', channel: 'pat' }, mid, 'create',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias })
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    return s.change.id
  }

  it('锁机制：外部持锁时 adoptChange 排队等待（不偷跑写），放锁后才采纳', async () => {
    const id = await readyCreate('x:race_hold', '持锁夹具')
    const holder = await pool.connect()
    try {
      const key = `${RORG}:mc:${id}`
      await holder.query('select pg_advisory_lock(hashtext($1))', [key])
      let settled = false
      const adoptP = adoptChange(writeDeps(pool), RORG, id).then((r) => { settled = true; return r })
      // 持锁期间 adopt 不得完成、更不得落行（无锁实现此刻早已偷跑完写 + 翻状态）
      await new Promise((r) => setTimeout(r, 80))
      expect(settled).toBe(false)
      const mid = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [RORG, 'x:race_hold'])
      expect(mid.rows).toHaveLength(0)
      await holder.query('select pg_advisory_unlock(hashtext($1))', [key])
      expect((await adoptP).ok).toBe(true)
    } finally {
      holder.release()
    }
  })

  it('并发 adopt+reject（Promise.all 两连接真并发）⇒ 恰一胜，无「写已生效但单据 rejected」形态', async () => {
    for (let round = 0; round < 3; round++) {
      const mid = `x:race_rr${round}`
      const id = await readyCreate(mid, `竞态夹具·第${round}轮`)
      const [adopt, rej] = await Promise.all([
        adoptChange(writeDeps(pool), RORG, id),
        rejectChange(pool, RORG, id, 'reviewer', `并发驳回·第${round}轮`),
      ])
      const adoptWon = adopt.ok === true
      const rejectWon = rej === true
      expect(adoptWon).not.toBe(rejectWon)
      const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [RORG, mid])
      if (rejectWon) {
        // 驳回赢 ⇒ 采纳必须停在域写之前（锁内先读态后写）——毒形态：行已生效 + 单据 rejected
        expect(adopt).toMatchObject({ ok: false, http: 409 })
        expect(live.rows).toHaveLength(0)
      } else {
        expect(live.rows).toHaveLength(1)
      }
    }
  })

  it('reject 同锁：并发双 reject 恰一枚生效；adopt 已采纳后再 reject ⇒ false', async () => {
    const id = await readyCreate('x:race_rj', '双驳夹具')
    const [r1, r2] = await Promise.all([
      rejectChange(pool, RORG, id, 'reviewer1', '先到'),
      rejectChange(pool, RORG, id, 'reviewer2', '后到'),
    ])
    // 两把同键锁串行：第一枚把状态推离 PENDING，第二枚 WHERE 钉 PENDING ⇒ 恰一 true
    expect(r1).not.toBe(r2)
    expect(await rejectChange(pool, RORG, id, 'reviewer3', '三驳')).toBe(false)
  })

  it('并发 adopt+withdraw（Promise.all 同键真并发）⇒ 恰一胜，无「写已生效但单据 withdrawn」形态', async () => {
    for (let round = 0; round < 3; round++) {
      const mid = `x:race_wd${round}`
      const id = await readyCreate(mid, `撤回竞态·第${round}轮`)
      const [adopt, wd] = await Promise.all([
        adoptChange(writeDeps(pool), RORG, id),
        // readyCreate 以 userId 'a' 立单 ⇒ 只有 'a' 能撤（withdraw 是提交者私权）
        withdrawChange(pool, RORG, id, 'a'),
      ])
      const adoptWon = adopt.ok === true
      const wdWon = wd === true
      expect(adoptWon).not.toBe(wdWon)
      const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [RORG, mid])
      if (wdWon) {
        // 撤回赢 ⇒ 采纳必须停在域写之前（锁内先读态后写）——毒形态：行已生效 + 单据 withdrawn
        expect(adopt).toMatchObject({ ok: false, http: 409 })
        expect(live.rows).toHaveLength(0)
      } else {
        expect(live.rows).toHaveLength(1)
      }
    }
  })

  it('adopt 撞 metrics_title_per_dept_uq（submit→adopt 窗口被并发占名）⇒ 409 TITLE_EXISTS_IN_DEPT，不是裸 23505', async () => {
    const id = await readyCreate('x:race_title', '撞名窗口夹具')
    // 占名：另一条 L2 用同 alias 直接生效（模拟「别人的单先被采纳」——决策锁不覆盖这个窗口）
    const snatcher = await writeL2Declaration(writeDeps(pool), RORG, 'x:race_snatcher',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '撞名窗口夹具' })
    expect(snatcher.ok).toBe(true)
    const out = await adoptChange(writeDeps(pool), RORG, id)
    expect(out).toMatchObject({ ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' })
    // 单据保持 preview_ready（域写回滚 + CAS 未跑）：评审者可驳回，或占名行删除后重试
    expect((await getChange(pool, RORG, id))?.status).toBe('preview_ready')
  })
})

// ── P5 Task 1（2026-11-13）：恢复 declaration 档（能力归还）─────────────────────
// P4 把 `POST /metrics/declarations` 退役成 410，而变更单 kind 集不含 declaration ⇒「新租户
// 全额声明」失去提案通路。本档把 W8 声明搬回变更单：提交宽校验 + L1 撞名 fail-early、试算
// 复用写路径编译尺、采纳调用既有唯一写路径 createTenantDeclaration（**直接生效**，无草稿）。
describePg('P5 Task 1：declaration 档（能力归还）', () => {
  const DORG = 'org-p5-decl'
  /** W8 全量声明条目（与 POST /metrics/declarations 的 `declaration` 同形；reads 供默认掩码判据）。 */
  const ENTRY = {
    name: 'p5mc:retail:decl_sales',
    label: 'P5 声明·销售额',
    definition: 'P5 Task 1 恢复 declaration 档的夹具口径',
    owner: 'data-platform',
    tier: 'experimental',
    source: 'lemeng',
    expression: 'sum(fct_retail_sale.sale_amount)',
    grain: ['system_book', 'bizday'],
    freshness_sla_days: 1,
    reads: [],
  }

  beforeAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [DORG])
    await pool.query('delete from data.metrics where org = $1', [DORG])
    // 撞名判据的被撞者：平台桶 L1 夹具（upsertL1Metric 固定写 org='platform'）
    await upsertL1Metric(pool, L1_FIXTURE)
    // 编译尺的 B11 关系白名单（空库自足；见 DECL_REL_L1 注释）
    await upsertL1Metric(pool, DECL_REL_L1)
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [DORG])
    await pool.query('delete from data.metrics where org = $1', [DORG])
    await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = $1",
      [DECL_REL_L1_ID])
  })

  it('提交合法声明 ⇒ 落单 kind=declaration，metricId = entry.name', async () => {
    const r = await submitChange(pool, DORG, { userId: 'a', channel: 'pat' }, ENTRY.name, 'declaration', ENTRY)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.change.kind).toBe('declaration')
      expect(r.change.metricId).toBe(ENTRY.name)
    }
  })

  it('name 撞 L1 ⇒ 400 ID_RESERVED_BY_L1，且不落单（fail-early）', async () => {
    const r = await submitChange(pool, DORG, { userId: 'a', channel: 'pat' }, L1_ID, 'declaration',
      { ...ENTRY, name: L1_ID })
    expect(r).toMatchObject({ ok: false, http: 400, error: 'ID_RESERVED_BY_L1' })
    const n = await pool.query(
      'select count(*)::int as n from data.metric_change where org = $1 and metric_id = $2', [DORG, L1_ID])
    expect(n.rows[0]?.n).toBe(0)
  })

  it('宽校验：缺 expression / grain 空 / name 与 metricId 不一致 ⇒ 400 INVALID_DECLARATION', async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...ENTRY, expression: '' },
      { ...ENTRY, grain: [] },
      { ...ENTRY, name: 'p5mc:retail:other' },
    ]
    for (const [i, payload] of cases.entries()) {
      const r = await submitChange(pool, DORG, { userId: 'a', channel: 'pat' }, ENTRY.name, 'declaration', payload)
      expect(r, `case ${i}`).toMatchObject({ ok: false, http: 400, error: 'INVALID_DECLARATION' })
    }
  })

  it('采纳 ⇒ 走既有唯一写路径：data.metrics 出现 basis=declared 行且 declaration 列有值', async () => {
    const s = await submitChange(pool, DORG, { userId: 'a', channel: 'pat' }, ENTRY.name, 'declaration', ENTRY)
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    const out = await adoptChange(writeDeps(pool), DORG, s.change.id)
    expect(out.ok).toBe(true)
    const live = await pool.query(
      'select basis, declaration, title from data.metrics where org = $1 and id = $2', [DORG, ENTRY.name])
    expect(live.rows[0]).toMatchObject({ basis: 'declared', title: ENTRY.label })
    expect(live.rows[0]?.declaration).toMatchObject({ name: ENTRY.name, source: 'lemeng' })
    expect((await getChange(pool, DORG, s.change.id))?.status).toBe('adopted')
  })

  it('同 null 桶已有同名 ⇒ 提交期 409 TITLE_EXISTS_IN_DEPT，且不落单（不留绿单死在采纳期）', async () => {
    const TITLE = 'P5 声明·同名夹具'
    // 落库桶 = null（insertTenantDeclaration 列清单不含 owner_dept）⇒ 判据桶必须同构
    await pool.query(
      `insert into data.metrics (org, id, title, subject_column, select_sql)
       values ($1, 'p5mc:retail:title_probe', $2, 'org', 'select 1 as value from probe')`,
      [DORG, TITLE])
    try {
      const r = await submitChange(pool, DORG, { userId: 'a', channel: 'pat' }, 'p5mc:retail:title_dup',
        'declaration', { ...ENTRY, name: 'p5mc:retail:title_dup', label: TITLE })
      expect(r).toMatchObject({ ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' })
      const n = await pool.query(
        'select count(*)::int as n from data.metric_change where org = $1 and metric_id = $2',
        [DORG, 'p5mc:retail:title_dup'])
      expect(n.rows[0]?.n).toBe(0)
    } finally {
      await pool.query('delete from data.metrics where org = $1 and id = $2', [DORG, 'p5mc:retail:title_probe'])
    }
  })

  it('采纳撞同名唯一索引（submit→adopt 并发窗口）⇒ 409 TITLE_EXISTS_IN_DEPT 而非 500；单据仍 preview_ready', async () => {
    const RACE = { ...ENTRY, name: 'p5mc:retail:race_decl', label: 'P5 声明·并发窗口' }
    const s = await submitChange(pool, DORG, { userId: 'a', channel: 'pat' }, RACE.name, 'declaration', RACE)
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    // 提单之后才出现的同名行：模拟决策锁覆盖不到的「submit→adopt」占名窗口
    await pool.query(
      `insert into data.metrics (org, id, title, subject_column, select_sql)
       values ($1, 'p5mc:retail:race_probe', $2, 'org', 'select 1 as value from probe')`,
      [DORG, RACE.label])
    try {
      const out = await adoptChange(writeDeps(pool), DORG, s.change.id)
      expect(out).toMatchObject({ ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' })
      expect((await getChange(pool, DORG, s.change.id))?.status).toBe('preview_ready')
    } finally {
      await pool.query('delete from data.metrics where org = $1 and id = $2', [DORG, 'p5mc:retail:race_probe'])
    }
  })
})


// ── P6 Task 2 修复轮（2026-11-14）：采纳即授权 —— 域层 creator 门认 data:manage ──────────
// 授权模型：**提交人 ≠ 采纳人**（agent 提案、人决策）。故 creator 判据只能在**采纳期**按
// 采纳人判；域层门 = creator ∪ data:manage（与 updateMetricMeta :348-351 同形）。
// 提交期不判 creator——agent 的 PAT 可能无 manage，而真正采纳它的人有 manage，提交期预测不了。
describePg('P6 Task 2 修复轮：采纳即授权（creator ∪ data:manage）', () => {
  const AORG = 'org-p6-adopt-authz'
  const OWNER = 'p6-owner'
  const AGENT = 'p6-agent'
  const THIRD = 'p6-third'
  const ADMIN = 'p6-admin'
  const submitterOf = (userId: string) => ({ userId, channel: 'pat' })
  const adoptDeps = (userId: string, scopes: string[] = []): MetricWriteDeps => ({
    pool,
    adoptedSources: new Set(['lemeng']),
    requester: {
      userId, orgId: AORG, channel: 'session', keyId: null, scopes,
      hasScope: (c) => scopes.includes(c),
    },
  })

  beforeAll(async () => {
    await upsertL1Metric(pool, L1_FIXTURE)
    await pool.query('delete from data.metric_change where org = $1', [AORG])
    await pool.query('delete from data.metrics where org = $1', [AORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [AORG])
    await pool.query('delete from data.metrics where org = $1', [AORG])
  })

  it('★ A 建 L2 → agent（非 creator、无 manage）提单 update → 非 manage 第三人采纳 403；admin 采纳同一单 ⇒ 成功', async () => {
    const id = 'p6a:update'
    const seeded = await writeL2Declaration(adoptDeps(OWNER), AORG, id, {
      baseMetric: L1_ID, op: { kind: 'refine' }, alias: '采纳授权·A 建',
    })
    expect(seeded).toEqual({ ok: true })
    // 提交期不判 creator：agent 的 PAT 无 manage 也能提案（由采纳人授权决定结果）
    const s = await submitChange(pool, AORG, submitterOf(AGENT), id, 'update', {
      baseMetric: L1_ID, op: { kind: 'refine' }, alias: '采纳授权·agent 改',
    })
    if (!s.ok) throw new Error(`agent 提单被拒: ${s.error}`)
    await markReady(s.change.id)
    // 非 manage 第三人采纳 ⇒ 域层 creator 门 403；单保持 preview_ready（可换人采纳）
    const denied = await adoptChange(adoptDeps(THIRD, ['data:query']), AORG, s.change.id)
    expect(denied).toMatchObject({ ok: false, http: 403, error: 'NOT_METRIC_CREATOR' })
    expect((await getChange(pool, AORG, s.change.id))?.status).toBe('preview_ready')
    // admin（持 manage）采纳**同一单** ⇒ 成功，行按提案改写
    const ok = await adoptChange(adoptDeps(ADMIN, ['data:manage']), AORG, s.change.id)
    expect(ok.ok).toBe(true)
    const row = await pool.query('select title from data.metrics where org = $1 and id = $2', [AORG, id])
    expect(row.rows[0]?.title).toBe('采纳授权·agent 改')
    expect((await getChange(pool, AORG, s.change.id))?.status).toBe('adopted')
  })

  it('★ created_by 为 NULL 的存量行：非 manage 采纳 403 METRIC_CREATOR_UNKNOWN；manage 采纳 ⇒ 成功', async () => {
    const id = 'p6a:legacy'
    // 直接落一条 created_by=NULL 的 L2（027 前存量且 028 回填不出）
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by,
          params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations, created_by, certified)
       values ($1, $2, '采纳授权·存量', '', null, 'org', 'select 1 as value', '', '{}'::jsonb,
               'l2', null, 'legacy', 1, false, null, null, null, 'draft')`,
      [AORG, id])
    const s = await submitChange(pool, AORG, submitterOf(AGENT), id, 'update', {
      baseMetric: L1_ID, op: { kind: 'refine' }, alias: '采纳授权·存量改',
    })
    if (!s.ok) throw new Error('unreachable')
    await markReady(s.change.id)
    const denied = await adoptChange(adoptDeps(THIRD, ['data:query']), AORG, s.change.id)
    expect(denied).toMatchObject({ ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' })
    expect((await getChange(pool, AORG, s.change.id))?.status).toBe('preview_ready')
    // manage 豁免下放行（否则会永远卡在「不知道谁建的」→ 孤儿治理无人可做）
    expect((await adoptChange(adoptDeps(ADMIN, ['data:manage']), AORG, s.change.id)).ok).toBe(true)
    const row = await pool.query('select title from data.metrics where org = $1 and id = $2', [AORG, id])
    expect(row.rows[0]?.title).toBe('采纳授权·存量改')
  })
})

// ── P6 Task 4（2026-11-14）：reveal 写入面 —— 变更单 payload ──────────────────────────
// `reveal` 是 P1（047）就有的列（CHECK panel|report，default panel），P5 只接了读侧；
// 本波让 create/update/override/declaration 四档 payload 都能带它，采纳时落列。
// 语义：新行缺席 ⇒ 'panel'；update 缺席 ⇒ 保留既有（与归属/策略字段同一条 coalesce 纪律）。
describePg('P6 Task 4：reveal 随变更单落列', () => {
  const RORG = 'org-p6-reveal'
  const OVR_L1 = {
    id: 'p6mc:l1:reveal_ovr_sales',
    title: 'P6 reveal 覆盖夹具',
    description: 'P6 Task 4 override 档夹具',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'select sum(fct_retail_sale.sale_amount) as value, system_book, bizday from fct_retail_sale',
    groupBy: 'system_book, bizday',
    params: {},
    sourceSystem: 'lemeng',
    slaDays: 1,
    freshnessRelations: [],
    masks: null,
  }
  const DECL_ENTRY = {
    name: 'p6mc:retail:reveal_decl_sales',
    label: 'P6 声明·reveal 成本',
    definition: 'P6 Task 4 reveal 落列夹具（declaration 档）',
    owner: 'data-platform',
    tier: 'experimental',
    source: 'lemeng',
    expression: 'sum(fct_retail_sale.sale_amount)',
    grain: ['system_book', 'bizday'],
    freshness_sla_days: 1,
    reads: [],
    reveal: 'report',
  }
  const OVR_ENTRY = {
    name: OVR_L1.id,
    label: 'P6 覆盖·reveal 毛利',
    definition: 'P6 Task 4 reveal 落列夹具（override 档）',
    owner: 'data-platform',
    tier: 'experimental',
    source: 'lemeng',
    expression: 'sum(fct_retail_sale.sale_amount)',
    grain: ['system_book', 'bizday'],
    freshness_sla_days: 1,
    reads: [],
    reveal: 'report',
  }
  const revealOf = async (id: string): Promise<string | undefined> =>
    (await pool.query('select reveal from data.metrics where org = $1 and id = $2', [RORG, id])).rows[0]?.reveal as string | undefined
  const submit = (metricId: string, kind: 'create' | 'update' | 'override' | 'declaration', payload: unknown) =>
    submitChange(pool, RORG, { userId: 'p6-reveal', channel: 'pat' }, metricId, kind, payload)
  const adopt = async (s: Awaited<ReturnType<typeof submit>>): Promise<void> => {
    if (!s.ok) throw new Error(`提单失败: ${s.error}`)
    await markReady(s.change.id)
    const out = await adoptChange(writeDeps(pool), RORG, s.change.id)
    if (!out.ok) throw new Error(`采纳失败: ${out.error}`)
  }

  beforeAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [RORG])
    await pool.query('delete from data.metrics where org = $1', [RORG])
    await upsertL1Metric(pool, L1_FIXTURE)
    await upsertL1Metric(pool, DECL_REL_L1)
    await upsertL1Metric(pool, OVR_L1)
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [RORG])
    await pool.query('delete from data.metrics where org = $1', [RORG])
    await pool.query("delete from data.metrics where org = 'platform' and source = 'l1' and id = any($1)",
      [[DECL_REL_L1_ID, OVR_L1.id]])
  })

  it('create 带 reveal=report ⇒ 采纳后列值 report（直查库，不采信回包）', async () => {
    const s = await submit('x:p6rv_create', 'create',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·create', reveal: 'report' })
    expect(s.ok).toBe(true)
    if (s.ok) expect(s.change.payload).toMatchObject({ reveal: 'report' })
    await adopt(s)
    expect(await revealOf('x:p6rv_create')).toBe('report')
  })

  it('update 缺席 reveal ⇒ 保留既有 report；显式带 panel ⇒ 改回 panel', async () => {
    // 前置：create 已落 report 行（上一用例）
    const keep = await submit('x:p6rv_create', 'update',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·create' })
    await adopt(keep)
    expect(await revealOf('x:p6rv_create')).toBe('report')
    const back = await submit('x:p6rv_create', 'update',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·create', reveal: 'panel' })
    await adopt(back)
    expect(await revealOf('x:p6rv_create')).toBe('panel')
  })

  it('新行不传 reveal ⇒ 列默认 panel', async () => {
    const s = await submit('x:p6rv_default', 'create',
      { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·默认' })
    await adopt(s)
    expect(await revealOf('x:p6rv_default')).toBe('panel')
  })

  it('declaration 档带 reveal ⇒ 采纳后列值 report', async () => {
    const s = await submit(DECL_ENTRY.name, 'declaration', DECL_ENTRY)
    await adopt(s)
    expect(await revealOf(DECL_ENTRY.name)).toBe('report')
  })

  it('override 档带 reveal ⇒ 采纳后列值 report', async () => {
    const s = await submit(OVR_ENTRY.name, 'override', OVR_ENTRY)
    await adopt(s)
    expect(await revealOf(OVR_ENTRY.name)).toBe('report')
  })

  it('非法值（四档）⇒ 提交期 400 INVALID_DECLARATION，且不落单（zod 形状闸）', async () => {
    const cases: Array<['create' | 'update' | 'override' | 'declaration', string, unknown]> = [
      ['create', 'x:p6rv_bad_create', { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·坏', reveal: 'half' }],
      ['update', 'x:p6rv_bad_update', { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·坏', reveal: 'half' }],
      ['declaration', 'p6mc:retail:reveal_bad_decl', { ...DECL_ENTRY, name: 'p6mc:retail:reveal_bad_decl', label: 'P6 声明·坏 reveal', reveal: 'half' }],
      ['override', OVR_L1.id, { ...OVR_ENTRY, label: 'P6 覆盖·坏 reveal', reveal: 'half' }],
    ]
    for (const [i, [kind, metricId, payload]] of cases.entries()) {
      const r = await submit(metricId, kind, payload)
      expect(r, `case ${i}`).toMatchObject({ ok: false, http: 400, error: 'INVALID_DECLARATION' })
      const n = await pool.query(
        'select count(*)::int as n from data.metric_change where org = $1 and metric_id = $2 and payload->>\'reveal\' = \'half\'',
        [RORG, metricId])
      expect(n.rows[0]?.n, `case ${i} 不得落单`).toBe(0)
    }
  })

  it('绕过 zod 的手改单（列 CHECK 兜底）⇒ 采纳期 23514 映射 400，不裸 500；单据仍 preview_ready', async () => {
    // 直接插单绕过 submitChange 的 zod：模拟历史单/手工改库——DB CHECK 是最后一道闸。
    const ins = await pool.query(
      `insert into data.metric_change (org, metric_id, kind, payload, submitted_by, submitted_channel, status)
       values ($1, 'x:p6rv_check', 'create', $2::jsonb, 'p6-reveal', 'pat', 'preview_ready')
       returning id`,
      [RORG, JSON.stringify({ baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·CHECK', reveal: 'half' })])
    const id = Number(ins.rows[0]!.id)
    const out = await adoptChange(writeDeps(pool), RORG, id)
    expect(out).toMatchObject({ ok: false, http: 400, error: 'INVALID_DECLARATION' })
    expect((await getChange(pool, RORG, id))?.status).toBe('preview_ready')
    const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [RORG, 'x:p6rv_check'])
    expect(live.rows).toHaveLength(0)
    await pool.query('delete from data.metric_change where id = $1', [id])
  })

  it('绕过 zod 的非字符串 reveal（null/number/bool）⇒ 采纳期 400，不静默忽略（三档都拒绝）', async () => {
    // 自足起点：清掉前序用例的覆盖行与遗留未决单（pending 唯一索引会挡直插）。
    await pool.query('delete from data.metrics where org = $1 and id = $2', [RORG, OVR_L1.id])
    await pool.query(
      "delete from data.metric_change where org = $1 and status in ('draft','preview_ready','preview_failed')", [RORG])
    // 提交期 zod 已挡（`z.enum` 只收两个字符串）；这里模拟手改库/历史单直插单据。
    const mkTicket = async (metricId: string, kind: 'create' | 'override' | 'declaration', payload: unknown): Promise<number> => {
      const ins = await pool.query(
        `insert into data.metric_change (org, metric_id, kind, payload, submitted_by, submitted_channel, status)
         values ($1, $2, $3, $4::jsonb, 'p6-reveal', 'pat', 'preview_ready')
         returning id`,
        [RORG, metricId, kind, JSON.stringify(payload)])
      return Number(ins.rows[0]!.id)
    }
    const cases: Array<[string, 'create' | 'override' | 'declaration', unknown]> = [
      ['x:p6rv_nonstr_num', 'create', { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·非串', reveal: 123 }],
      ['x:p6rv_nonstr_null', 'create', { baseMetric: L1_ID, op: { kind: 'refine' }, alias: 'reveal·null', reveal: null }],
      [OVR_L1.id, 'override', { ...OVR_ENTRY, label: 'P6 覆盖·非串 reveal', reveal: false }],
      ['p6mc:retail:reveal_nonstr_decl', 'declaration',
        { ...DECL_ENTRY, name: 'p6mc:retail:reveal_nonstr_decl', label: 'P6 声明·非串 reveal', reveal: true }],
    ]
    for (const [i, [metricId, kind, payload]] of cases.entries()) {
      const id = await mkTicket(metricId, kind, payload)
      const out = await adoptChange(writeDeps(pool), RORG, id)
      expect(out, `case ${i}`).toMatchObject({ ok: false, http: 400, error: 'INVALID_DECLARATION' })
      expect((await getChange(pool, RORG, id))?.status, `case ${i}`).toBe('preview_ready')
      const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [RORG, metricId])
      expect(live.rows, `case ${i} 不得落行`).toHaveLength(0)
      await pool.query('delete from data.metric_change where id = $1', [id])
    }
  })

  it('列 CHECK 兜底对称覆盖：override / declaration 档的非法字符串 reveal 同样 400（非裸 500）', async () => {
    // 前置用例已采纳一条覆盖草稿行；本用例要走到 INSERT（而非 409 OVERRIDE_EXISTS）⇒ 先清掉。
    await pool.query('delete from data.metrics where org = $1 and id = $2', [RORG, OVR_L1.id])
    await pool.query(
      "delete from data.metric_change where org = $1 and status in ('draft','preview_ready','preview_failed')", [RORG])
    const mkTicket = async (metricId: string, kind: 'override' | 'declaration', payload: unknown): Promise<number> => {
      const ins = await pool.query(
        `insert into data.metric_change (org, metric_id, kind, payload, submitted_by, submitted_channel, status)
         values ($1, $2, $3, $4::jsonb, 'p6-reveal', 'pat', 'preview_ready')
         returning id`,
        [RORG, metricId, kind, JSON.stringify(payload)])
      return Number(ins.rows[0]!.id)
    }
    const cases: Array<[string, 'override' | 'declaration', unknown]> = [
      [OVR_L1.id, 'override', { ...OVR_ENTRY, label: 'P6 覆盖·CHECK', reveal: 'half' }],
      ['p6mc:retail:reveal_check_decl', 'declaration',
        { ...DECL_ENTRY, name: 'p6mc:retail:reveal_check_decl', label: 'P6 声明·CHECK', reveal: 'half' }],
    ]
    for (const [i, [metricId, kind, payload]] of cases.entries()) {
      const id = await mkTicket(metricId, kind, payload)
      const out = await adoptChange(writeDeps(pool), RORG, id)
      expect(out, `case ${i}`).toMatchObject({ ok: false, http: 400, error: 'INVALID_DECLARATION' })
      expect((await getChange(pool, RORG, id))?.status, `case ${i}`).toBe('preview_ready')
      const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [RORG, metricId])
      expect(live.rows, `case ${i} 不得落行`).toHaveLength(0)
      await pool.query('delete from data.metric_change where id = $1', [id])
    }
  })
})
