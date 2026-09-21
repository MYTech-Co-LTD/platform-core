import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricDef } from './authz'
import { deleteMetric, loadCatalog, upsertMetric } from './metric-store'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——各测试文件用互不相同的 org，避免互相擦数据。 */
const ORG = 'org-t3-metric'
const OTHER_ORG = 'org-t3-metric-other'

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
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [OTHER_ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('upsertMetric 幂等：同 id 两次 → 一行，且字段被覆盖（不是 do nothing）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, def())

    await upsertMetric(pool, ORG, def({
      title: '销售日明细（v2）',
      description: '',
      requiredScope: 'data:query',
      groupBy: 'org',
      params: {},
    }))

    const r = await pool.query(
      `select title, description, required_scope, subject_column, select_sql, group_by, params
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
    })
  })

  it('upsertMetric 刷 updated_at、不动 created_at（「谁先建的」不能丢）', async () => {
    // 判据必须**确定性**：拿本次 now() 与上次 now() 比只能到毫秒，同一毫秒内假绿。
    // 故把两个时间戳先钉到一个明确的过去值，再看第二次 upsert 各自变成什么样。
    const PINNED = '2000-01-01T00:00:00Z'
    await upsertMetric(pool, ORG, def({ id: 'upsert_probe' }))
    await pool.query(
      'update data.metrics set created_at = $3, updated_at = $3 where org = $1 and id = $2',
      [ORG, 'upsert_probe', PINNED],
    )

    await upsertMetric(pool, ORG, def({ id: 'upsert_probe', title: '第二版' }))

    const r = await pool.query(
      'select title, created_at, updated_at from data.metrics where org = $1 and id = $2',
      [ORG, 'upsert_probe'],
    )
    expect(r.rows[0].title).toBe('第二版')
    expect(r.rows[0].created_at.toISOString(), 'created_at 被 upsert 改了').toBe(new Date(PINNED).toISOString())
    expect(r.rows[0].updated_at.getTime(), 'updated_at 没被刷新').toBeGreaterThan(Date.parse(PINNED))
  })

  it('loadCatalog 只回本租户，且行 → MetricDef 映射保真（params jsonb 往返、created/updated 不外泄）', async () => {
    const mine = def({
      id: 'finance_margin',
      title: '毛利',
      description: '',
      requiredScope: 'data:finance',
      selectSql: 'SELECT org, margin FROM marts.mart_margin',
      groupBy: 'org',
      params: { day_from: { column: 'day', type: 'date' }, top: { column: 'n', type: 'number', required: false } },
    })
    await upsertMetric(pool, ORG, mine)
    await upsertMetric(pool, OTHER_ORG, def({ id: 'other_org_only', title: '别家的' }))

    const catalog = await loadCatalog(pool, ORG)
    expect(catalog.map((m) => m.id)).toContain('finance_margin')
    // 反向：别家租户的行一条都不能出现（隔离键 org 的判据）
    expect(catalog.map((m) => m.id)).not.toContain('other_org_only')
    // 映射保真：逐字段等于写入的那个对象（多出来的列没被塞进来、jsonb 没被序列化成字符串）
    expect(catalog.find((m) => m.id === 'finance_margin')).toEqual(mine)
  })

  it('deleteMetric 返「是否真删了一行」，且只删本租户的', async () => {
    await upsertMetric(pool, ORG, def({ id: 'to_delete' }))
    expect(await deleteMetric(pool, ORG, 'to_delete')).toBe(true)
    expect(await deleteMetric(pool, ORG, 'to_delete')).toBe(false)     // 再删一次：没有行可删

    await upsertMetric(pool, OTHER_ORG, def({ id: 'other_keep' }))
    expect(await deleteMetric(pool, ORG, 'other_keep')).toBe(false)    // 别家的同 id 删不掉
    expect((await loadCatalog(pool, OTHER_ORG)).map((m) => m.id)).toContain('other_keep')
  })
})
