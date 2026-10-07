import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { getReport, updateRequiredScope, updateSpec, upsertReport } from './report-store'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与其它测试文件不同，避免互相擦数据。 */
const ORG = 'org-renderer-store'

describePg('report-store 的 renderer（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.reports where org like $1', ['org-renderer-store%']).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('upsert 不带 renderer ⇒ 落 metabase；显式 platform ⇒ 读回来是 platform', async () => {
    await applyMigrations(pool)
    const org = 'org-renderer-store'
    await pool.query('delete from data.reports where org = $1', [org])

    const idA = await upsertReport(pool, org, {
      title: 'A', metabaseId: 11, embedParams: {}, requiredScope: null,
    })
    const idB = await upsertReport(pool, org, {
      title: 'B', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 迁移 007 起库侧强制：自绘行必须带规格
    })

    expect((await getReport(pool, org, idA))!.renderer).toBe('metabase')
    expect((await getReport(pool, org, idB))!.renderer).toBe('platform')
  })

  it('二次 upsert 覆盖 renderer（同 title 幂等路径也要带上它）', async () => {
    const org = 'org-renderer-store-2'
    await pool.query('delete from data.reports where org = $1', [org])
    await upsertReport(pool, org, { title: 'C', metabaseId: 12, embedParams: {}, requiredScope: null })
    const id = await upsertReport(pool, org, {
      title: 'C', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] }, // 同上：metabase→platform 的改渲染器路径也要带上规格
    })
    expect((await getReport(pool, org, id))!.renderer).toBe('platform')
  })

  it('updateRequiredScope：改页门落库并返回整行；没命中（跨租户/不存在）返回 null', async () => {
    const org = 'org-gate-store'
    await pool.query('delete from data.reports where org = $1', [org])
    const id = await upsertReport(pool, org, {
      title: 'D', metabaseId: 13, embedParams: {}, requiredScope: 'sales:read',
    })

    const updated = await updateRequiredScope(pool, org, id, 'finance:read', 1)
    expect(updated).toMatchObject({ id, title: 'D', requiredScope: 'finance:read', renderer: 'metabase' })
    const db = await pool.query('select required_scope from data.reports where org = $1 and id = $2', [org, id])
    expect(db.rows[0].required_scope).toBe('finance:read')

    // 发布（置 null）
    expect((await updateRequiredScope(pool, org, id, null, 2))!.requiredScope).toBeNull()

    // 跨租户 org ⇒ null（不存在性的唯一表达，不给存在性探针）
    expect(await updateRequiredScope(pool, 'org-gate-store-other', id, null, 3)).toBeNull()
  })

  it('version：新建行 = 1；每次写 +1；expectedVersion 不符 ⇒ 不更新', async () => {
    const org = 'org-version-store'
    await pool.query('delete from data.reports where org = $1', [org])
    const id = await upsertReport(pool, org, {
      title: 'V', metabaseId: 21, embedParams: {}, requiredScope: null,
    })
    expect((await getReport(pool, org, id))!.version).toBe(1)

    // 命中版本 ⇒ 更新且 +1
    const ok = await updateRequiredScope(pool, org, id, 'sales:read', 1)
    expect(ok).toMatchObject({ requiredScope: 'sales:read', version: 2 })

    // 陈旧版本 ⇒ null（不更新）
    expect(await updateRequiredScope(pool, org, id, 'finance:read', 1)).toBeNull()
    expect((await getReport(pool, org, id))!.requiredScope).toBe('sales:read')

    // 跨租户 ⇒ null
    expect(await updateRequiredScope(pool, 'org-version-store-other', id, null, 2)).toBeNull()

    // 重新登记（upsert 冲突分支）也 +1
    await upsertReport(pool, org, { title: 'V', metabaseId: 21, embedParams: {}, requiredScope: null })
    expect((await getReport(pool, org, id))!.version).toBe(3)
  })

  it('★ spec：自绘行必须带规格；条件更新（陈旧版本不落）', async () => {
    const org = 'org-spec-store'
    await pool.query('delete from data.reports where org = $1', [org])
    // 自绘行没有 spec ⇒ 库侧直接拒（跨列 check）
    await expect(upsertReport(pool, org, {
      title: 'S', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })).rejects.toThrow()

    const id = await upsertReport(pool, org, {
      title: 'S', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] },
    })
    expect((await getReport(pool, org, id))!.spec).toEqual({ panels: [] })
    expect((await getReport(pool, org, id))!.version).toBe(1)

    expect(await updateSpec(pool, org, id, { panels: [] }, 99)).toBeNull()          // 陈旧 ⇒ null
    const ok = await updateSpec(pool, org, id, { panels: [] }, 1)
    expect(ok).toMatchObject({ version: 2 })
  })

  it('★ create-only：撞名即不写、返回 null，且既有行一字未动（页门/规格/版本都不变）', async () => {
    const org = 'org-create-only-store'
    await pool.query('delete from data.reports where org = $1', [org])
    const first = await upsertReport(pool, org, {
      title: '同名探针', metabaseId: 0, embedParams: {},
      requiredScope: null, renderer: 'platform', spec: { panels: [] },
    })
    const before = await getReport(pool, org, first)

    // 第二次：同 title + create-only ⇒ null（撞名），且**什么都不写**
    const again = await upsertReport(pool, org, {
      title: '同名探针', metabaseId: 0, embedParams: {},
      requiredScope: 'data:manage', renderer: 'platform', spec: { panels: [] },
    }, 'create-only')
    expect(again).toBeNull()
    const after = await getReport(pool, org, first)
    // ★ 三样都不能变：页门（若被写就成了「静默撤下已发布」）、规格、版本
    expect(after).toMatchObject({ requiredScope: before!.requiredScope, version: before!.version })
    expect(after!.id).toBe(first)

    // 对照：默认 upsert 会改写（这正是报表面那条「重登记重置页门」陷阱）
    await upsertReport(pool, org, {
      title: '同名探针', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: { panels: [] },
    })
    const overwritten = await getReport(pool, org, first)
    expect(overwritten!.requiredScope).toBe('data:manage')     // 现象成立 ⇒ 本任务的动机可复现
    expect(overwritten!.version).toBe(before!.version + 1)
  })
})
