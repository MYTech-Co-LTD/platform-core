import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { writeAudit } from './audit-store'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与其它测试文件不同，避免互相擦数据。 */
const ORG = 'org-t3-audit'

describePg('audit-store（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('denied 行：各列原样落库，row_count 为 null、reason 有值', async () => {
    await applyMigrations(pool)
    await writeAudit(pool, {
      org: ORG,
      userId: 'alice',
      channel: 'session',
      keyId: null,
      metricId: 'finance_margin',
      params: { day_from: '2026-01-01' },
      rowCount: null,                                   // 被拒时没有行数可记
      verdict: 'denied',
      reason: 'metric_not_authorized',
    })

    const r = await pool.query('select * from data.query_audit where org = $1', [ORG])
    expect(r.rowCount).toBe(1)
    expect(r.rows[0]).toMatchObject({
      org: ORG,                                          // 隔离键 = 主体值（一列两义）
      user_id: 'alice',
      channel: 'session',
      key_id: null,                                      // 非 pat 通道
      metric_id: 'finance_margin',
      params: { day_from: '2026-01-01' },                // jsonb 往返成对象，不是字符串
      row_count: null,                                   // 列可空，必须真落成 NULL（不是 0）
      verdict: 'denied',
      reason: 'metric_not_authorized',
    })
    expect(r.rows[0].created_at).toBeInstanceOf(Date)     // 默认值由库给
  })

  it('ok 行（pat 通道）：row_count 落值、key_id 落 bigint、reason 为 null；params 空对象 / 嵌套结构都能往返', async () => {
    const keyId = 4242
    await writeAudit(pool, {
      org: ORG,
      userId: 'bob',
      channel: 'pat',
      keyId,
      metricId: 'mart_sales_daily',
      params: { day_from: '2026-02-01', nested: { a: [1, 2], b: null } },
      rowCount: 3,
      verdict: 'ok',
      reason: null,
    })
    await writeAudit(pool, {
      org: ORG,
      userId: 'carol',
      channel: 'wecom',
      keyId: null,
      metricId: 'mart_sales_daily',
      params: {},                                        // 无参指标：空对象（不是 null）
      rowCount: 0,
      verdict: 'error',
      reason: 'warehouse_error',
    })

    const pat = await pool.query(
      "select key_id, params, row_count, reason, verdict from data.query_audit where org = $1 and user_id = 'bob'",
      [ORG],
    )
    // ⚠️ bigint 列经 node-pg 回来是 **string** ⇒ 断言前必须归一（这是列类型的事实，不是实现选择）
    expect(Number(pat.rows[0].key_id)).toBe(keyId)
    expect(pat.rows[0].params).toEqual({ day_from: '2026-02-01', nested: { a: [1, 2], b: null } })
    expect(pat.rows[0].row_count).toBe(3)
    expect(pat.rows[0].reason).toBeNull()
    expect(pat.rows[0].verdict).toBe('ok')

    const oa = await pool.query(
      "select params, row_count, key_id from data.query_audit where org = $1 and user_id = 'carol'",
      [ORG],
    )
    expect(oa.rows[0].params).toEqual({})
    // row_count = 0 与「没记」在审计里语义不同：这里必须是 0，不能被写库时当真值丢掉
    expect(oa.rows[0].row_count).toBe(0)
    expect(oa.rows[0].key_id).toBeNull()
  })
})
