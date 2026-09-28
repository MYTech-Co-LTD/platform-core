import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { getReport, upsertReport } from './report-store'
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
    })
    expect((await getReport(pool, org, id))!.renderer).toBe('platform')
  })
})
