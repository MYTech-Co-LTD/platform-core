import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricDef } from './authz'
import { visibleMetrics } from './authz'
import {
  L1_ORG,
  deleteMetric,
  deleteStaleL1Metrics,
  loadCatalog,
  loadMergedCatalog,
  loadPlatformCatalog,
  upsertL1Metric,
  upsertMetric,
} from './metric-store'
import { applyMigrations, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——各测试文件用互不相同的 org，避免互相擦数据。 */
const ORG = 'org-t3-metric'
const OTHER_ORG = 'org-t3-metric-other'
/** L1 行的 id 前缀：与真实 sync 物化的 id 区分开，避免测试与「真跑过一次 sync」互相干扰。 */
const L1_ID_PREFIX = 't8test:'

/** 词表形状照 domain/authz.ts 的 `MetricDef`（原型 CATALOG 同形）。 */
function def(over: Partial<MetricDef> = {}): MetricDef {
  return {
    id: 'mart_sales_daily',
    title: '销售日明细',
    description: '按主体分日的销售明细',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
    groupBy: '',
    params: { day_from: { column: 'day', type: 'date', required: true } },
    ...over,
  }
}

describePg('metric-store（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  /** 租户写路径（source='l2'）。平台物化路径是另一个入口 `upsertL1Metric`。 */
  const put = (org: string, d: MetricDef) => upsertMetric(pool, org, d)

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = any($1::text[])', [[ORG, OTHER_ORG]]).catch(() => {})
    // ★ L1 桶（org='platform'）是**跨测试文件共用**的（它就是个固定桶名，不是本文件私有）：
    //   清理只按本文件的前缀删，别 `delete where org='platform'` —— 那会把同时并行跑的
    //   兄弟测试文件的 L1 夹具删掉（vitest 默认多文件并行，症状是随机红且难以复现）。
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${L1_ID_PREFIX}%`]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('upsertMetric 幂等：同 id 两次 → 一行，且字段被覆盖（不是 do nothing）', async () => {
    await applyMigrations(pool)
    await put(ORG, def())

    await put(ORG, def({
      title: '销售日明细（v2）',
      description: '',
      requiredScope: 'data:query',
      groupBy: 'org',
      params: {},
    }))

    const r = await pool.query(
      `select title, description, required_scope, subject_column, select_sql, group_by, params, source
         from data.metrics where org = $1 and id = $2`,
      [ORG, 'mart_sales_daily'],
    )
    expect(r.rowCount, '同 (org, id) 必须只有一行').toBe(1)
    expect(r.rows[0]).toMatchObject({
      title: '销售日明细（v2）',
      description: '',
      required_scope: 'data:query',
      subject_column: 'org',
      select_sql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
      group_by: 'org',
      params: {},
      source: 'l2',
    })
  })

  it('upsertMetric 刷 updated_at、不动 created_at（「谁先建的」不能丢）', async () => {
    // 判据必须**确定性**：拿本次 now() 与上次 now() 比只能到毫秒，同一毫秒内假绿。
    // 故把两个时间戳先钉到一个明确的过去值，再看第二次 upsert 各自变成什么样。
    const PINNED = '2000-01-01T00:00:00Z'
    await put(ORG, def({ id: 'upsert_probe' }))
    await pool.query(
      'update data.metrics set created_at = $3, updated_at = $3 where org = $1 and id = $2',
      [ORG, 'upsert_probe', PINNED],
    )

    await put(ORG, def({ id: 'upsert_probe', title: '第二版' }))

    const r = await pool.query(
      'select title, created_at, updated_at from data.metrics where org = $1 and id = $2',
      [ORG, 'upsert_probe'],
    )
    expect(r.rows[0].title).toBe('第二版')
    expect(r.rows[0].created_at.toISOString(), 'created_at 被 upsert 改了').toBe(new Date(PINNED).toISOString())
    expect(r.rows[0].updated_at.getTime(), 'updated_at 没被刷新').toBeGreaterThan(Date.parse(PINNED))
  })

  it('★ upsert 不改 source：来源标注只由首次插入确定（写动作改不掉「谁写的」）', async () => {
    const id = 'source_probe'
    // 先由**物化路径**落一行 l1（org = platform）
    await upsertL1Metric(pool, def({ id, title: '平台口径' }))
    // 再由租户写路径覆盖同一 (org, id)：内容被覆盖，但 source 必须**留在** l1
    await put(L1_ORG, def({ id, title: '换个标题' }))

    const r = await pool.query('select title, source from data.metrics where org = $1 and id = $2', [L1_ORG, id])
    expect(r.rows[0].title).toBe('换个标题')
    expect(r.rows[0].source, 'source 被 upsert 改掉了 ⇒ 来源标注失去意义').toBe('l1')
  })

  it('两个写入口各自钉死自己的 source（upsertMetric 写不出 l1、upsertL1Metric 只落 platform）', async () => {
    await upsertL1Metric(pool, def({ id: 'entry_l1' }))
    await put(ORG, def({ id: 'entry_l2' }))

    expect((await pool.query('select org, source from data.metrics where id = $1', ['entry_l1'])).rows[0])
      .toMatchObject({ org: L1_ORG, source: 'l1' })
    expect((await pool.query('select org, source from data.metrics where id = $1', ['entry_l2'])).rows[0])
      .toMatchObject({ org: ORG, source: 'l2' })
  })

  it('loadCatalog 只回本租户，且行 → MetricRow 映射保真（params jsonb 往返、created/updated 不外泄）', async () => {
    const mine = def({
      id: 'finance_margin',
      title: '毛利',
      description: '',
      requiredScope: 'data:finance',
      selectSql: 'SELECT org, margin FROM marts.mart_margin',
      groupBy: 'org',
      params: { day_from: { column: 'day', type: 'date' }, top: { column: 'n', type: 'number', required: false } },
    })
    await put(ORG, mine)
    await put(OTHER_ORG, def({ id: 'other_org_only', title: '别家的' }))

    const catalog = await loadCatalog(pool, ORG)
    expect(catalog.map((m) => m.id)).toContain('finance_margin')
    // 反向：别家租户的行一条都不能出现（隔离键 org 的判据）
    expect(catalog.map((m) => m.id)).not.toContain('other_org_only')
    // 映射保真：逐字段等于写入的那个对象 + source 标注（多出来的列没被塞进来、jsonb 没被序列化成字符串）
    expect(catalog.find((m) => m.id === 'finance_margin')).toEqual({ ...mine, source: 'l2' })
  })

  it('deleteMetric 返「是否真删了一行」，且只删本租户的', async () => {
    await put(ORG, def({ id: 'to_delete' }))
    expect(await deleteMetric(pool, ORG, 'to_delete')).toBe(true)
    expect(await deleteMetric(pool, ORG, 'to_delete')).toBe(false)     // 再删一次：没有行可删

    await put(OTHER_ORG, def({ id: 'other_keep' }))
    expect(await deleteMetric(pool, ORG, 'other_keep')).toBe(false)    // 别家的同 id 删不掉
    expect((await loadCatalog(pool, OTHER_ORG)).map((m) => m.id)).toContain('other_keep')
  })

  // ── T8：L1（平台）与 L2（租户）两层 ──────────────────────────────────────────────
  describe('L1 / L2 两层', () => {
    const l1Def = (over: Partial<MetricDef> = {}): MetricDef =>
      def({ id: `${L1_ID_PREFIX}net_sales`, title: '净销售额', ...over })

    it('loadPlatformCatalog 只回 org=platform 的 l1 行（不含任何 l2 行）', async () => {
      await upsertL1Metric(pool, l1Def())
      await put(ORG, def({ id: 'l2_hidden_from_platform' }))

      const platform = await loadPlatformCatalog(pool)
      const ids = platform.map((m) => m.id)
      expect(ids).toContain(`${L1_ID_PREFIX}net_sales`)
      expect(ids).not.toContain('l2_hidden_from_platform')
      expect(platform.every((m) => m.source === 'l1')).toBe(true)
    })

    it('loadMergedCatalog = L1（平台）∪ L2（本 org），**不含别家 L2**', async () => {
      await upsertL1Metric(pool, l1Def())
      await put(ORG, def({ id: 'mine_l2' }))
      await put(OTHER_ORG, def({ id: 'other_l2' }))

      const merged = await loadMergedCatalog(pool, ORG)
      const ids = merged.map((m) => m.id)
      expect(ids).toContain(`${L1_ID_PREFIX}net_sales`)  // L1 对每个租户可见
      expect(ids).toContain('mine_l2')
      expect(ids, '别家租户的 L2 行漏进来了 ⇒ 跨租户串词表').not.toContain('other_l2')
    })

    it('★ L2 不可覆盖 L1 口径：同 id 撞上时 L1 赢（加载侧的第二道闸）', async () => {
      const id = `${L1_ID_PREFIX}collide`
      await upsertL1Metric(pool, def({ id, title: '平台口径', selectSql: 'select sum(x) as value from t' }))
      // 绕过写侧闸门直接落一条同 id 的 L2 行（模拟历史数据/直写库）
      await pool.query(
        `insert into data.metrics (org, id, title, description, required_scope, subject_column, select_sql, group_by, params, source)
         values ($1, $2, '被篡改的租户口径', '', null, 'org', 'select sum(y) as value from t2', '', '{}'::jsonb, 'l2')
         on conflict (org, id) do update set title = excluded.title, select_sql = excluded.select_sql`,
        [ORG, id],
      )

      const merged = await loadMergedCatalog(pool, ORG)
      const hit = merged.filter((m) => m.id === id)
      expect(hit, '同 id 出现了两条 ⇒ L2 顶掉了 L1').toHaveLength(1)
      expect(hit[0].source).toBe('l1')
      expect(hit[0].title).toBe('平台口径')
    })

    it('★ deleteMetric 删不掉 L1 行（只读纪律落在 SQL 的 source=l2 上，不靠调用方自觉）', async () => {
      const id = `${L1_ID_PREFIX}readonly`
      await upsertL1Metric(pool, l1Def({ id }))
      // 即便调用方拿着 platform 这个 org 值来删，也删不掉
      expect(await deleteMetric(pool, L1_ORG, id)).toBe(false)
      expect((await loadPlatformCatalog(pool)).map((m) => m.id)).toContain(id)
    })

    it('deleteStaleL1Metrics：删掉不在 keepIds 里的 l1 行，保留在的，且不碰 l2', async () => {
      await upsertL1Metric(pool, l1Def({ id: `${L1_ID_PREFIX}keep` }))
      await upsertL1Metric(pool, l1Def({ id: `${L1_ID_PREFIX}stale` }))
      await put(ORG, def({ id: 'l2_untouched' }))

      const deleted = await deleteStaleL1Metrics(pool, [`${L1_ID_PREFIX}keep`])

      expect(deleted).toContain(`${L1_ID_PREFIX}stale`)
      expect(deleted).not.toContain(`${L1_ID_PREFIX}keep`)
      const ids = (await loadPlatformCatalog(pool)).map((m) => m.id)
      expect(ids).toContain(`${L1_ID_PREFIX}keep`)
      expect(ids).not.toContain(`${L1_ID_PREFIX}stale`)
      expect((await loadCatalog(pool, ORG)).map((m) => m.id), 'l2 行被差集删了').toContain('l2_untouched')
    })

    it('★ 裁剪后词表经 authz 只少不多：合并集 → visibleMetrics ⊆ 合并集，且只按 scope 减', async () => {
      await upsertL1Metric(pool, l1Def({ id: `${L1_ID_PREFIX}public`, requiredScope: null }))
      await upsertL1Metric(pool, l1Def({ id: `${L1_ID_PREFIX}finance`, requiredScope: 'data:finance' }))
      await put(ORG, def({ id: 'l2_public', requiredScope: null }))

      const merged = await loadMergedCatalog(pool, ORG)
      const requester = { ...makeIdentity({ orgId: ORG, scopes: ['data:query'] }), orgId: ORG, channel: 'session' as const, keyId: null }
      const visible = visibleMetrics(merged, requester)

      // 只少不多：可见集是合并集的子集
      expect(visible.every((m) => merged.some((x) => x.id === m.id))).toBe(true)
      expect(visible.length).toBeLessThanOrEqual(merged.length)
      // 减的**只有** scope 不够的那些（不是随机少）
      expect(visible.map((m) => m.id)).toContain('l2_public')
      expect(visible.map((m) => m.id)).toContain(`${L1_ID_PREFIX}public`)
      expect(visible.map((m) => m.id), 'data:finance 的指标对只有 data:query 的人可见了').not.toContain(`${L1_ID_PREFIX}finance`)
    })
  })
})
