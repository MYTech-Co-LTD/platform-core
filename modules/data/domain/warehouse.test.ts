import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  DATA_WAREHOUSE_UNCONFIGURED, resetWarehousePool, runWarehouseSql, warehouseConfigured, warehousePool,
} from './warehouse'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/** 只用于构造连接串，不解析域名也不拨号（惰性单例在 new Pool 时不建连接）。 */
const WAREHOUSE_URL = 'postgres://warehouse-user:warehouse-pass@warehouse.invalid:5432/warehouse'

describe('warehouseConfigured（不需要数据库）', () => {
  it('未配 / 空串 / 只有空白 ⇒ false；有值 ⇒ true（空白不算配置）', () => {
    expect(warehouseConfigured({})).toBe(false)
    expect(warehouseConfigured({ DATA_WAREHOUSE_URL: '' })).toBe(false)
    expect(warehouseConfigured({ DATA_WAREHOUSE_URL: '   ' })).toBe(false)
    expect(warehouseConfigured({ DATA_WAREHOUSE_URL: WAREHOUSE_URL })).toBe(true)
  })
})

describe('warehousePool（惰性单例；装载期不建连接）', () => {
  afterAll(() => { resetWarehousePool() })

  it('未配 ⇒ 抛，而不是给出一条坏连接（fail-closed 的可见面是常量化错误码）', () => {
    resetWarehousePool()
    expect(() => warehousePool({})).toThrow(DATA_WAREHOUSE_UNCONFIGURED)
    // 抛过之后单例仍是空的：不能因为一次拿不到就留下半成品
    expect(warehouseConfigured({})).toBe(false)
  })

  it('配了 ⇒ 两次拿到同一条（单例）；statement_timeout 已设；reset 后换新', async () => {
    resetWarehousePool()
    const a = warehousePool({ DATA_WAREHOUSE_URL: WAREHOUSE_URL })
    expect(warehousePool({ DATA_WAREHOUSE_URL: WAREHOUSE_URL })).toBe(a)
    expect(a.options.statement_timeout).toBe(30_000)   // 单条 SQL 不许挂 30s 以上（问数有超时预算）

    resetWarehousePool()
    const b = warehousePool({ DATA_WAREHOUSE_URL: WAREHOUSE_URL })
    expect(b).not.toBe(a)                              // 测试钩子确实清了单例

    resetWarehousePool()
    await Promise.all([a.end(), b.end()])              // 两条都没真连过，end 是干净的
  })
})

// 归一形状与「连的是哪个库」无关 ⇒ 用本地 pg 当替身（真仓库不必在场也能钉住契约）。
// 运行期灌进真仓库的口径归 T4/T6；本文件的职责只有形状。
describePg('runWarehouseSql（需要 DATABASE_URL，借本地 pg 当替身）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('归一成 { columns, rows }：列名保序、行是**值数组**（不是 pg 的行对象）、null 保留', async () => {
    const r = await runWarehouseSql(pool, "select 1 as a, 'x' as b, null::int as c")
    expect(r.columns).toEqual(['a', 'b', 'c'])
    expect(r.rows).toEqual([[1, 'x', null]])
  })

  it('多行按 SQL 顺序返回，行宽与 columns 对齐', async () => {
    const r = await runWarehouseSql(pool, 'select * from (values (2, \'b\'), (1, \'a\')) as t(n, s) order by n desc')
    expect(r.columns).toEqual(['n', 's'])
    expect(r.rows).toEqual([[2, 'b'], [1, 'a']])
  })

  it('零行 ⇒ rows 是空数组、columns 仍在（空结果不是错误）', async () => {
    const r = await runWarehouseSql(pool, 'select 1 as only_col where false')
    expect(r.columns).toEqual(['only_col'])
    expect(r.rows).toEqual([])
  })
})
