import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricDef } from './authz'
import { visibleMetrics } from './authz'
import {
  L1_ORG,
  deleteMetric,
  deleteStaleL1Metrics,
  loadOrgCatalog,
  loadMergedCatalog,
  loadPlatformCatalog,
  selectMetricSnapshot,
  upsertL1Metric,
  upsertMetric,
} from './metric-store'
import { applyMigrations, makeIdentity, rawMigrationSqls } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——各测试文件用互不相同的 org，避免互相擦数据。 */
const ORG = 'org-t3-metric'
const OTHER_ORG = 'org-t3-metric-other'
/**
 * L1 行的 id 前缀（本文件专用；`catalog-consumers.test.ts` 用 `t8c:`、`routes/metrics.test.ts` 用 `t6test:`）。
 *
 * ⚠️ **每一条写进平台桶（`org='platform'`）的夹具都必须带它**，且 `afterAll` 只按它清理——
 * 两个方向都会出事，两个方向都是实测过的：
 *   · 不带前缀、而 id 又恰好与**真实声明**（`dbt/semantics/l1_metrics.yml` 的 `name`）同名
 *     ⇒ 清理会把平台桶里那条**真行**删掉（兄弟文件 `routes/metrics.test.ts` 曾用 `retail:net_sales`
 *     当夹具 id，跑完测试后 `sync --check` 报「新增 1」就是这个成因）；
 *   · 不带前缀的夹具行**不被清理** ⇒ 留在桶里，`sync --check` 把它读成「仓内声明里没有的行」
 *     而报「删除 N」（本文件原先的 `source_probe` / `entry_l1` 就是这个成因）。
 * 名字里的 `t8` 是历史（本文件随 T8 落地），关键是「与真实声明不可能同名」。
 */
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
  const put = (org: string, d: MetricDef) => upsertMetric(pool, org, d, 'fixture')

  /**
   * L1 物化路径的入参形状：`MetricDef` + **源系统**（L1 声明里 `source` 必填 ⇒ L1 行恒有源）。
   * sync 脚本传进来的正是它的 ComparableMetric（同形）。默认 `lemeng`（当前唯一已接入源）。
   */
  const l1 = (over: Partial<MetricDef> = {}, sourceSystem: string | null = 'lemeng') =>
    ({ ...def(over), sourceSystem,
      // 新鲜度链路（spec §10.7）缺省形态：承诺 1 天 + 空关系集（= 无自动水位，字段缺席）。
      // 夹具默认不接链路；要验链路的用例显式传 slaDays/freshnessRelations。
      slaDays: 1, freshnessRelations: [] as string[],
      // 值级掩码声明（spec 2026-10-17 §5.2）缺省形态：未声明 = null。要验掩码物化的用例显式传。
      masks: null })

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
    // ⚠️ id 带本文件前缀（理由见 L1_ID_PREFIX 的说明）：不带前缀的平台行**不被本文件清理**
    // ⇒ 留在桶里被 sync 的 `--check` 当成「仓内声明里没有的行」报删除漂移。
    const id = `${L1_ID_PREFIX}source_probe`
    // 先由**物化路径**落一行 l1（org = platform）
    await upsertL1Metric(pool, l1({ id, title: '平台口径' }))
    // 再由租户写路径覆盖同一 (org, id)：内容被覆盖，但 source 必须**留在** l1
    await put(L1_ORG, def({ id, title: '换个标题' }))

    const r = await pool.query('select title, source from data.metrics where org = $1 and id = $2', [L1_ORG, id])
    expect(r.rows[0].title).toBe('换个标题')
    expect(r.rows[0].source, 'source 被 upsert 改掉了 ⇒ 来源标注失去意义').toBe('l1')
  })

  it('★ L1 行的 source_system 等于声明的 source；L2 行为 null', async () => {
    // 源维度（spec §3⑧）的两种**行形状**：L1（平台声明）带源系统；L2（租户编译）没有源。
    const l1Id = `${L1_ID_PREFIX}src_dim`
    const l2Id = 'l2_no_source'
    await upsertL1Metric(pool, l1({ id: l1Id }, 'lemeng'))
    await put(ORG, def({ id: l2Id }))

    const r = await pool.query(
      'select id, source, source_system from data.metrics where id = any($1::text[])',
      [[l1Id, l2Id]],
    )
    const byId = new Map(r.rows.map((row) => [row.id, row]))
    expect(byId.get(l1Id), 'L1 行的 source_system 没有等于声明的 source').toMatchObject({
      source: 'l1', source_system: 'lemeng',
    })
    expect(byId.get(l2Id), 'L2 行不该有源系统（它是租户编译出来的，不来自某个源）').toMatchObject({
      source: 'l2', source_system: null,
    })
    // 加载面也要带上（映射保真，别只让表里有值而 MetricRow 里没有）
    expect((await loadPlatformCatalog(pool)).find((m) => m.id === l1Id)?.sourceSystem).toBe('lemeng')
    expect((await loadOrgCatalog(pool, ORG)).find((m) => m.id === l2Id)?.sourceSystem).toBeNull()
  })

  it('★ totalable（spec §8.4）：L1 带值写入并随声明刷新；L2 恒 false（def 误带也不写）', async () => {
    // 可加标记是 L1 声明（expression 形状）的推导产物：物化路径带值、冲突分支与
    // source_system 同一条「声明是真值」纪律一起刷；L2 写路径没有这个概念，恒 false。
    const id = `${L1_ID_PREFIX}totalable`
    await upsertL1Metric(pool, l1({ id, totalable: true }))
    expect((await loadPlatformCatalog(pool)).find((m) => m.id === id)?.totalable, 'L1 带值要落库')
      .toBe(true)
    await upsertL1Metric(pool, l1({ id }))   // 声明改成不可加 ⇒ 重新物化必须跟上
    expect((await loadPlatformCatalog(pool)).find((m) => m.id === id)?.totalable).toBe(false)

    await put(ORG, def({ id: 'l2_totalable_guard', totalable: true }))
    const r = await pool.query('select totalable from data.metrics where org = $1 and id = $2',
      [ORG, 'l2_totalable_guard'])
    expect(r.rows[0].totalable, 'L2 行不受 def 上的 totalable 影响（恒 false）').toBe(false)
  })

  it('★ sla_days / freshness_relations（spec §10.7）：L1 带值写入并随声明刷新；L2 写不碰它们', async () => {
    // 新鲜度链路（spec §10.7.3）：sync 从声明推导slaDays + freshnessRelations，物化路径带值、
    // 冲突分支与 source_system/totalable 同一条「声明是真值」纪律一起刷；L2 写路径没有这个概念。
    const id = `${L1_ID_PREFIX}sla_fresh`
    await upsertL1Metric(pool, {
      ...l1({ id }), slaDays: 1,
      freshnessRelations: ['stg_lemeng_retail_order_line'],
    })
    const got = (await loadPlatformCatalog(pool)).find((m) => m.id === id)
    expect(got?.slaDays, 'L1 带值要落库').toBe(1)
    expect(got?.freshnessRelations).toEqual(['stg_lemeng_retail_order_line'])

    // 声明改了 ⇒ 重新物化必须跟上（否则 sync --check 永远检出漂移）
    await upsertL1Metric(pool, { ...l1({ id }), slaDays: 2, freshnessRelations: [] })
    const flipped = (await loadPlatformCatalog(pool)).find((m) => m.id === id)
    expect(flipped?.slaDays).toBe(2)
    expect(flipped?.freshnessRelations).toEqual([])

    // 租户写路径撞上同 (org, id) 的 L1 行：内容被覆盖，但 sla_days / freshness_relations
    // **不**被抹成 null（与 source/totalable 同一条纪律——一次租户写不能把平台行的新鲜度链路清掉）
    await put(L1_ORG, def({ id, title: '租户路径覆盖同 id 行' }))
    const after = (await pool.query(
      'select sla_days, freshness_relations from data.metrics where org = $1 and id = $2', [L1_ORG, id],
    )).rows[0]
    expect(after.sla_days, '租户写不得抹掉平台行的 sla_days').toBe(2)
    expect(after.freshness_relations, '租户写不得抹掉平台行的 freshness_relations').toEqual([])

    // L2 行（写路径直落）恒 null——「没接链路」必须可辨
    await put(ORG, def({ id: 'l2_sla_guard' }))
    const l2 = (await pool.query(
      'select sla_days, freshness_relations from data.metrics where org = $1 and id = $2',
      [ORG, 'l2_sla_guard'],
    )).rows[0]
    expect(l2.sla_days).toBeNull()
    expect(l2.freshness_relations).toBeNull()
  })

  it('★ 声明的 source 改了 ⇒ 重新物化把 source_system 一起刷（否则 sync --check 永远检出漂移）', async () => {
    const id = `${L1_ID_PREFIX}src_flip`
    await upsertL1Metric(pool, l1({ id }, 'lemeng'))
    await upsertL1Metric(pool, l1({ id }, 'other_erp'))
    expect((await loadPlatformCatalog(pool)).find((m) => m.id === id)?.sourceSystem).toBe('other_erp')
  })

  it('★ upsertMetric 不碰 source_system（与 source 同一纪律：来源标注只由首次插入确定）', async () => {
    // 租户写路径撞上同 (org, id) 的 L1 行时，只覆盖内容：既不改 source，也不把 source_system 抹成 null
    // （抹了 = 平台行的源维度被一次租户写动作清掉，而 sync 的 --check 会因此长期报漂移）。
    const id = `${L1_ID_PREFIX}src_keep`
    await upsertL1Metric(pool, l1({ id }, 'lemeng'))
    await put(L1_ORG, def({ id, title: '租户路径覆盖同 id 行' }))

    const r = await pool.query(
      'select title, source, source_system from data.metrics where org = $1 and id = $2',
      [L1_ORG, id],
    )
    expect(r.rows[0]).toMatchObject({
      title: '租户路径覆盖同 id 行', source: 'l1', source_system: 'lemeng',
    })
  })

  it('两个写入口各自钉死自己的 source（upsertMetric 写不出 l1、upsertL1Metric 只落 platform）', async () => {
    await upsertL1Metric(pool, l1({ id: `${L1_ID_PREFIX}entry_l1` }))
    await put(ORG, def({ id: 'entry_l2' }))

    expect((await pool.query('select org, source from data.metrics where id = $1', [`${L1_ID_PREFIX}entry_l1`])).rows[0])
      .toMatchObject({ org: L1_ORG, source: 'l1' })
    expect((await pool.query('select org, source from data.metrics where id = $1', ['entry_l2'])).rows[0])
      .toMatchObject({ org: ORG, source: 'l2' })
  })

  it('loadOrgCatalog 只回本租户，且行 → MetricRow 映射保真（params jsonb 往返、created/updated 不外泄）', async () => {
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

    const catalog = await loadOrgCatalog(pool, ORG)
    expect(catalog.map((m) => m.id)).toContain('finance_margin')
    // 反向：别家租户的行一条都不能出现（隔离键 org 的判据）
    expect(catalog.map((m) => m.id)).not.toContain('other_org_only')
    // 映射保真：逐字段等于写入的那个对象 + source 标注 + #489 的两列 + totalable 缺省
    // （多出来的列没被塞进来、jsonb 没被序列化成字符串）。这两列**必须**在映射里 —— /metrics/all 的列表两列靠它。
    expect(catalog.find((m) => m.id === 'finance_margin'))
      .toEqual({ ...mine, source: 'l2', sourceSystem: null, updatedBy: 'fixture', version: 1, totalable: false,
        // 新鲜度链路（spec §10.7）：L2 行没有这个概念，恒 null（不是 []——「没声明」与「声明为空」可辨）
        slaDays: null, freshnessRelations: null,
        // 值级掩码（spec 2026-10-17 §5.2）：同理不是 L2 写入面的概念，恒 null
        masks: null })
  })

  it('deleteMetric 返「是否真删了一行」，且只删本租户的', async () => {
    await put(ORG, def({ id: 'to_delete' }))
    expect(await deleteMetric(pool, ORG, 'to_delete')).toBe(true)
    expect(await deleteMetric(pool, ORG, 'to_delete')).toBe(false)     // 再删一次：没有行可删

    await put(OTHER_ORG, def({ id: 'other_keep' }))
    expect(await deleteMetric(pool, ORG, 'other_keep')).toBe(false)    // 别家的同 id 删不掉
    expect((await loadOrgCatalog(pool, OTHER_ORG)).map((m) => m.id)).toContain('other_keep')
  })

  // ── T8：L1（平台）与 L2（租户）两层 ──────────────────────────────────────────────
  describe('L1 / L2 两层', () => {
    const l1Def = (over: Partial<MetricDef> = {}) =>
      l1({ id: `${L1_ID_PREFIX}net_sales`, title: '净销售额', ...over })

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
      await upsertL1Metric(pool, l1({ id, title: '平台口径', selectSql: 'select sum(x) as value from t' }))
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

      // ★ keepIds 必须把**并行兄弟文件此刻的 L1 夹具**一并带上。
      //
      // 为什么：`deleteStaleL1Metrics` 的删除侧是 `not (id = any(keepIds))`，作用域是**整个平台桶**
      // （`org='platform' and source='l1'`）——那正是 sync 要的语义（仓内声明集之外的行都要清）。
      // 但本用例跑在**跨文件共用的真库**上，且 vitest 默认多文件并行：只传本文件的 keep，
      // 调用瞬间就会**连带删掉 metrics.test.ts / catalog-consumers.test.ts 正在用的 L1 夹具行**，
      // 兄弟文件随后所有以它为 baseMetric 的写路径都会拿到 `400 L1_BASE_NOT_FOUND`
      // （不是期望的 409/201）——症状与代码缺陷极不相似，且取决于两文件相对耗时（CI 上稳定复现）。
      //
      // 收窄成「只删本文件自己造的那些」后，本用例仍然**只用 t8test:stale 验**「不在 keepIds ⇒ 被删」，
      // 断言一字未改；删除面则不再越出本文件的夹具。自带前缀的那些（readonly/stale）本文件自己负责。
      const siblingIds = (await loadPlatformCatalog(pool))
        .map((m) => m.id).filter((id) => !id.startsWith(L1_ID_PREFIX))
      const deleted = await deleteStaleL1Metrics(pool, [`${L1_ID_PREFIX}keep`, ...siblingIds])

      expect(deleted).toContain(`${L1_ID_PREFIX}stale`)
      expect(deleted).not.toContain(`${L1_ID_PREFIX}keep`)
      const ids = (await loadPlatformCatalog(pool)).map((m) => m.id)
      expect(ids).toContain(`${L1_ID_PREFIX}keep`)
      expect(ids).not.toContain(`${L1_ID_PREFIX}stale`)
      expect((await loadOrgCatalog(pool, ORG)).map((m) => m.id), 'l2 行被差集删了').toContain('l2_untouched')
    })

    it('★ 裁剪后词表经 authz 只少不多：合并集 → visibleMetrics ⊆ 合并集，且只按 scope 减', async () => {
      await upsertL1Metric(pool, l1Def({ id: `${L1_ID_PREFIX}public`, requiredScope: null }))
      await upsertL1Metric(pool, l1Def({ id: `${L1_ID_PREFIX}finance`, requiredScope: 'data:finance' }))
      await put(ORG, def({ id: 'l2_public', requiredScope: null }))

      const merged = await loadMergedCatalog(pool, ORG)
      const requester = { ...makeIdentity({ orgId: ORG, scopes: ['data:query'] }), orgId: ORG, channel: 'session' as const, keyId: null }
      // 已接入源给本文件的 L1 夹具默认源（`l1Def` 的 `lemeng`）——否则下面那两条 L1 断言
      // 会因为**源维度**（不是 scope）而红；本用例验的是「只按 scope 减」，源维度必须中性化。
      const visible = visibleMetrics(merged, requester, new Set(['lemeng']))

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

// ── 010 迁移（#489）：语义追溯的地基。单独一个 describe：它验的是 schema，不是 store 行为。──
describePg('010 迁移：两列 + 审计表（#489）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end() })

  it('★ 两列与新表就位，且迁移幂等（连跑两遍零效果）', async () => {
    await applyMigrations(pool)
    await applyMigrations(pool) // 第二遍：必须零效果、不报错（部署脚本每次全量重跑）
    const cols = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'data' and table_name = 'metrics'
          and column_name in ('updated_by', 'version')`)
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['updated_by', 'version'])

    const t = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'data' and table_name = 'metric_audit'`)
    expect(t.rows[0]!.n).toBe(1)
  })
})

// ── 016 迁移（spec §8.4）：totalable 列。验的是 schema，不是 store 行为。──────────────
describePg('016 迁移：totalable 列（spec §8.4）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end() })

  it('★ 列就位（not null default false）、存量行缺省 false，且迁移幂等（连跑两遍零效果）', async () => {
    await applyMigrations(pool)
    await applyMigrations(pool) // 第二遍：必须零效果、不报错（部署脚本每次全量重跑）

    const cols = await pool.query<{ is_nullable: string; column_default: string }>(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'data' and table_name = 'metrics' and column_name = 'totalable'`)
    expect(cols.rows, 'totalable 必须 not null default false').toEqual([
      { is_nullable: 'NO', column_default: 'false' },
    ])

    // 不写 totalable 的普通行（L2 路径）落缺省 false —— 自动合计只给推导出 true 的 L1 行
    await upsertMetric(pool, ORG, def({ id: 'totalable_default_probe' }), 'fixture')
    const r = await pool.query('select totalable from data.metrics where org = $1 and id = $2',
      [ORG, 'totalable_default_probe'])
    expect(r.rows[0].totalable).toBe(false)
    await pool.query('delete from data.metrics where org = $1 and id = $2',
      [ORG, 'totalable_default_probe']).catch(() => {})
  })
})

// ── 017 迁移（spec §10.7）：新鲜度 SLA 两列 + load_log 逐关系水位两列。验的是 schema。──
describePg('017 迁移：sla_days / freshness_relations + load_log 水位列（spec §10.7）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end() })

  /** 017 的正文（唯一事实源 = 迁移文件；这里读原文执行，不复制 SQL）。 */
  const sql017 = async () => {
    const all = await rawMigrationSqls()
    const text = all.find((s) => s.includes('017_metric_freshness') || s.includes('sla_days'))
    expect(text, '017 迁移文件必须在 migrations/ 目录里').toBeTruthy()
    return text as string
  }

  it('★ data.metrics 两列就位（可空）、迁移幂等（连跑两遍零效果）', async () => {
    await applyMigrations(pool)
    await applyMigrations(pool) // 第二遍：必须零效果、不报错（部署脚本每次全量重跑）

    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'data' and table_name = 'metrics'
          and column_name in ('sla_days', 'freshness_relations') order by column_name`)
    expect(cols.rows).toEqual([
      { column_name: 'freshness_relations', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'sla_days', data_type: 'integer', is_nullable: 'YES' },
    ])
  })

  it('★ load_log 半句：表在 ⇒ 两列补上；表缺 ⇒ 整句 no-op 不报错（平台库没有这张表是常态）', async () => {
    // data.load_log 物化在**仓库库**（pg_duckdb，materialize.sh 建）；平台库（本测试库的常态）没有它。
    // 迁移用 `alter table if exists` 兜这两种世界：表在就补列，表缺席就安静跳过——不许因「表不在这」翻车。
    const text = await sql017()

    // 形态 ①：旧形状的 load_log 在场 ⇒ 补出 relation / max_bizday（幂等：先建旧形状再跑）
    await pool.query('create table if not exists data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text)')
    await pool.query(text)
    const cols = await pool.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'data' and table_name = 'load_log'
          and column_name in ('relation', 'max_bizday') order by column_name`)
    expect(cols.rows).toEqual([
      { column_name: 'max_bizday', data_type: 'date' },
      { column_name: 'relation', data_type: 'text' },
    ])

    // 形态 ②：表摘掉再跑 ⇒ 不报错（no-op）；旧行兼容性：relation NULL 的仓级历史行还在
    await pool.query('drop table if exists data.load_log')
    await expect(pool.query(text)).resolves.toBeTruthy()
  })
})

// ── 记人记版本 + 快照点读（#489）：语义追溯的两列与审计的前后态都靠它。──
describePg('记人 / 版本 / 快照（#489）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end()
  })

  const snapDef = (title: string): MetricDef => ({
    id: 'ma_ver', title, description: 'd', requiredScope: null,
    subjectColumn: 'org', selectSql: 'select sum(x.y) as value, bizday from x',
    groupBy: 'bizday', params: {},
  })

  it('★ upsert 记人并累加版本：首建 version=1、再写 +1，人跟着换', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, snapDef('t1'), 'ZhangDuo')
    let row = (await pool.query(`select version, updated_by from data.metrics where org=$1 and id=$2`,
      [ORG, 'ma_ver'])).rows[0]
    expect(row).toMatchObject({ version: 1, updated_by: 'ZhangDuo' })

    await upsertMetric(pool, ORG, snapDef('t2'), 'LiLei')
    row = (await pool.query(`select version, updated_by, title from data.metrics where org=$1 and id=$2`,
      [ORG, 'ma_ver'])).rows[0]
    expect(row).toMatchObject({ version: 2, updated_by: 'LiLei', title: 't2' })
  })

  it('★ 快照点读：本 org 的 l2 行拿得到，不存在 / 别家 org / 平台桶 都是 null', async () => {
    await upsertMetric(pool, ORG, snapDef('t2'), 'LiLei')
    const snap = await selectMetricSnapshot(pool, ORG, 'ma_ver')
    expect(snap).toMatchObject({ title: 't2', subjectColumn: 'org', groupBy: 'bizday' })
    expect(await selectMetricSnapshot(pool, ORG, 'no_such')).toBeNull()
    expect(await selectMetricSnapshot(pool, 'platform', 'ma_ver')).toBeNull()
  })
})
