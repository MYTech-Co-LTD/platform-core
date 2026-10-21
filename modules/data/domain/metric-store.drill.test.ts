// metric-store.drill.test.ts — 下钻三列的存取与读侧 fail-closed（下钻 spec 2026-10-21 §2.3/§2.5，迁移 021）。
//
// 验两件事：
//   · 写侧：`upsertL1Metric` 把 `DrillBinding` 物化进 drill_expr / drill_dims / drill_detail，
//     读侧 `loadMergedCatalog` 原样读回（jsonb 往返保真——不是字符串、不缺字段）。
//   · 读侧：**不信任存储形状**——三列任一缺/坏 ⇒ drill 缺席（undefined = 未声明），绝不半绑。
//     「有 expr 无 dims」的残行漏出半个绑定，比没有绑定更危险（spec §2.5：未声明即不下钻）。
import { afterAll, beforeAll, describe, expect, it, assert } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { L1_ORG, loadMergedCatalog, upsertL1Metric } from './metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text）——与本模块其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-drill-store'
/** 本文件的 L1 夹具 id 前缀（平台桶跨文件共用 ⇒ 清理只按前缀删，别 `where org='platform'`）。 */
const L1_PREFIX = 'drillstore:'

describePg('metric-store 下钻三列（迁移 021，需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await applyMigrations(pool)
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    // 平台桶跨文件共用 ⇒ 只删本文件前缀的那些（别 `where org='platform'`，会删掉并行兄弟的夹具）
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${L1_PREFIX}%`])
      .catch(() => {})
    await pool.end().catch(() => {})
  })

  it('upsertL1Metric 写入下钻三列，loadMergedCatalog 读回 DrillBinding', async () => {
    await upsertL1Metric(pool, {
      id: 'drillstore:retail:net_sales', title: 't', description: 'd',
      requiredScope: null, subjectColumn: 'org',
      selectSql: "select sum(fct_t.net_amount) as value, system_book from fct_t where state = 'FINISHED' group by system_book",
      groupBy: 'system_book', params: {}, sourceSystem: 'lemeng',
      slaDays: 1, freshnessRelations: [], masks: null,
      drill: { expr: '(sale_amount@order)', dims: ['system_book', 'bizday'], relation: 'vw_t', filter: "state = 'FINISHED'" },
    })
    const rows = await loadMergedCatalog(pool, ORG)
    const row = rows.find((m) => m.id === 'drillstore:retail:net_sales')
    assert.deepEqual(row?.drill, { expr: '(sale_amount@order)', dims: ['system_book', 'bizday'], relation: 'vw_t', filter: "state = 'FINISHED'" })
  })

  it('drill 列残缺（有 expr 无 dims）⇒ 读侧判未声明（fail-closed，不半绑）', async () => {
    await pool.query(
      "insert into data.metrics (org, id, title, description, subject_column, select_sql, group_by, params, source, drill_expr) values ($1,'drillstore:half','t','d','org','select 1 as value','','{}','l2','(x)') on conflict (org,id) do update set drill_expr = excluded.drill_expr",
      [ORG])
    const rows = await loadMergedCatalog(pool, ORG)
    // 哨兵：这行必须真的出现在合并词表里——否则下一条断言是空的（没行也 undefined）
    assert.notEqual(rows.find((m) => m.id === 'drillstore:half'), undefined, '夹具行必须可见，否则 fail-closed 断言空转')
    assert.equal(rows.find((m) => m.id === 'drillstore:half')?.drill, undefined)
  })
})
