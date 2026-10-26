// report-version.test.ts — 报表版本存储（发布 / 下线 / 回滚 / 历史）的真库用例。
//
// 需要 `DATABASE_URL`（本地 compose pg）；没有就整组 skip（与 report-store.test.ts 同口径）。
// ⚠️ 用例**按生命周期顺序**共享一个报表（发布 v1 → 无改动 → 改草稿 → 发布 v2 → 回滚 v3 →
//    下线）：版本号是跨用例的状态，拆成互相独立的夹具反而要重复造 6 份同形数据。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertMetric } from './metric-store'
import { parseReportSpec } from './report-spec'
import type { ReportSpec } from './report-spec'
import { getReport, updateSpec, upsertReport } from './report-store'
import {
  getPublishedSpec, getVersion, listVersions, publishVersion, rollbackVersion, unpublishVersion,
} from './report-version'
import type { VersionRow } from './report-version'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/** 隔离键（text = 该租户的 Casdoor org）。两个 org 才能钉「跨租户恒 404」。 */
const ORG = 'org-report-version'
const OTHER_ORG = 'org-report-version-other'
/** L2 指标（`upsertMetric` 只写 l2）：`sourceSystem=null` ⇒ 源裁剪恒通过，不受 adoptedSources 影响。 */
const METRIC = 'rv:sales'

/** 夹具走 `parseReportSpec` 归一（与发布通路同形：defaults 已补齐）。 */
function specOf(panels: unknown[]): ReportSpec {
  const parsed = parseReportSpec({ panels })
  if (!parsed.ok) throw new Error(`fixture spec invalid: ${parsed.code}`)
  return parsed.spec
}

const SPEC_V1 = specOf([
  { chart: 'table', title: '销售', metricId: METRIC, dims: [], args: {}, span: 24 },
])
const SPEC_V2 = specOf([
  { chart: 'table', title: '销售', metricId: METRIC, dims: [], args: {}, span: 24 },
  { chart: 'text', title: '说明', content: '第二版', span: 24 },
])

describePg('报表版本存储（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let id = ''
  let v1: VersionRow | null = null

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.reports where org = any($1)', [[ORG, OTHER_ORG]])
    await pool.query('delete from data.metrics where org = $1', [ORG])
    await upsertMetric(pool, ORG, {
      id: METRIC,
      title: '销售额',
      description: '版本存储夹具',
      requiredScope: null,
      subjectColumn: 'org',
      selectSql: 'select 1 as value',
      groupBy: '',
      params: {},
    }, 'fixture')
    id = await upsertReport(pool, ORG, {
      title: '月度报表',
      metabaseId: 0,
      embedParams: {},
      requiredScope: null,
      renderer: 'platform',
      spec: SPEC_V1,
    })
  })

  afterAll(async () => {
    // 报表删除会级联删 `report_versions`（迁移 022 的 `on delete cascade`）
    await pool.query('delete from data.reports where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('发布 v1：新建快照 + 指针指向它 + 草稿计数器被快照', async () => {
    const out = await publishVersion(pool, ORG, id, 1, 'u-test', '首次发布', new Set())
    expect(out).toMatchObject({ ok: true, publishedVersion: 1, requiredScope: null })

    const row = await getReport(pool, ORG, id)
    expect(row).toMatchObject({
      version: 1,
      publishedVersion: 1,
      publishedDraftVersion: 1,
    })
    expect(row!.publishedVersionId).not.toBeNull()

    const versions = await listVersions(pool, ORG, id)
    expect(versions.map((v) => v.version)).toEqual([1])
    v1 = await getVersion(pool, ORG, id, 1)
    expect(v1).toMatchObject({
      version: 1,
      title: '月度报表',
      requiredScope: null,
      draftVersion: 1,
      publishedBy: 'u-test',
      note: '首次发布',
    })
    expect(v1!.spec).toEqual(SPEC_V1)

    const published = await getPublishedSpec(pool, ORG, id)
    expect(published).toMatchObject({ version: 1, title: '月度报表', requiredScope: null })
    expect(published!.spec).toEqual(SPEC_V1)
  })

  it('无改动再发布 ⇒ unchanged，不新增版本；陈旧 expectedVersion ⇒ STALE_WRITE', async () => {
    const again = await publishVersion(pool, ORG, id, 1, 'u-test', '', new Set())
    expect(again).toMatchObject({ ok: true, unchanged: true, publishedVersion: 1 })
    expect((await listVersions(pool, ORG, id)).length).toBe(1)

    // fail-closed：期望版本陈旧 ⇒ 拒，且一条版本都不落
    const stale = await publishVersion(pool, ORG, id, 999, 'u-test', '', new Set())
    expect(stale).toEqual({ ok: false, reason: 'STALE_WRITE' })
    expect((await listVersions(pool, ORG, id)).length).toBe(1)
  })

  it('metabase 行 / 不存在 ⇒ 各自响亮失败', async () => {
    const mbId = await upsertReport(pool, ORG, {
      title: '嵌入报表', metabaseId: 31, embedParams: {}, requiredScope: null,
    })
    expect(await publishVersion(pool, ORG, mbId, 1, 'u-test', '', new Set()))
      .toEqual({ ok: false, reason: 'RENDERER_NOT_SELF_DRAWN' })
    expect(await publishVersion(pool, ORG, 'no-such-report', 1, 'u-test', '', new Set()))
      .toEqual({ ok: false, reason: 'NOT_FOUND' })
    // 跨租户：同一 id 在别的 org 下不存在（不给存在性探针）
    expect(await publishVersion(pool, OTHER_ORG, id, 1, 'u-test', '', new Set()))
      .toEqual({ ok: false, reason: 'NOT_FOUND' })
  })

  it('改草稿后发布 ⇒ v2；?v=1 仍可钉住，未发布版本 ⇒ null', async () => {
    const updated = await updateSpec(pool, ORG, id, SPEC_V2, 1)
    expect(updated!.version).toBe(2)

    const out = await publishVersion(pool, ORG, id, 2, 'u-test', '第二版', new Set())
    expect(out).toMatchObject({ ok: true, publishedVersion: 2 })

    const latest = await getPublishedSpec(pool, ORG, id)
    expect(latest!.version).toBe(2)
    expect(latest!.spec).toEqual(SPEC_V2)

    // 历史版本钉住：v1 的定义要点得到（版本是**定义**版本，不是只有当前那一版）
    const pinned = await getPublishedSpec(pool, ORG, id, 1)
    expect(pinned).toMatchObject({ version: 1, title: '月度报表' })
    expect(pinned!.spec).toEqual(SPEC_V1)
    expect(await getPublishedSpec(pool, ORG, id, 99)).toBeNull()
  })

  it('跨租户 / 不存在 ⇒ getPublishedSpec、getVersion、listVersions 全 null/空', async () => {
    expect(await getPublishedSpec(pool, OTHER_ORG, id)).toBeNull()
    expect(await getPublishedSpec(pool, ORG, 'no-such-report')).toBeNull()
    expect(await getVersion(pool, OTHER_ORG, id, 1)).toBeNull()
    expect(await listVersions(pool, OTHER_ORG, id)).toEqual([])
  })

  it('回滚 v1 ⇒ 新版本 v3（内容 = v1），历史三行全在且旧行不被改写', async () => {
    const out = await rollbackVersion(pool, ORG, id, 1, 2, 'u-test', '', new Set())
    expect(out).toMatchObject({ ok: true, publishedVersion: 3 })

    const row = await getReport(pool, ORG, id)
    expect(row).toMatchObject({
      version: 3,                    // 草稿跟着回滚：v1 内容成了新草稿
      publishedVersion: 3,
      publishedDraftVersion: 3,
    })

    const versions = await listVersions(pool, ORG, id)
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1])

    const v3 = await getVersion(pool, ORG, id, 3)
    expect(v3!.spec).toEqual(SPEC_V1)
    expect(v3!.note).toBe('rollback from v1')   // 空 note ⇒ 默认文案

    // append-only：v1/v2 行逐字不变（回滚只新增，不改旧行）
    expect(await getVersion(pool, ORG, id, 1)).toEqual(v1)
    expect((await getVersion(pool, ORG, id, 2))!.spec).toEqual(SPEC_V2)

    const published = await getPublishedSpec(pool, ORG, id)
    expect(published!.version).toBe(3)
    expect(published!.spec).toEqual(SPEC_V1)
  })

  it('下线 ⇒ 指针为空；/published-spec 与 ?v=* 一并失效（下线是总闸）', async () => {
    const ok = await unpublishVersion(pool, ORG, id, 3)
    expect(ok).toBe(true)

    const row = await getReport(pool, ORG, id)
    expect(row).toMatchObject({
      version: 4,                                  // 下线推进草稿计数器
      publishedVersionId: null,
      publishedVersion: null,
      publishedDraftVersion: null,
      requiredScope: 'data:manage',                // 页门挂回草稿预览档
    })

    expect(await getPublishedSpec(pool, ORG, id)).toBeNull()
    expect(await getPublishedSpec(pool, ORG, id, 1)).toBeNull()
    expect(await getPublishedSpec(pool, ORG, id, 3)).toBeNull()

    // 版本行不删：历史照旧
    expect((await listVersions(pool, ORG, id)).map((v) => v.version)).toEqual([3, 2, 1])

    // 陈旧 expectedVersion ⇒ false（路由层据此再查一次分 404/409）
    expect(await unpublishVersion(pool, ORG, id, 3)).toBe(false)
  })
})
