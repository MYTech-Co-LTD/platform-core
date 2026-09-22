import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import {
  importEmployee, importEmployeeApproval, importProduct, importRegion, importRule, importStore, importTicket,
} from './import'
import {
  FIXTURE_EMPLOYEE, FIXTURE_EMPLOYEE_APPROVE, FIXTURE_RULE, FIXTURE_TICKET,
} from './fixtures'
import { cleanEmployee, cleanEmployeeApproval, cleanRule, cleanStore, cleanTicket } from './clean'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-m2b-import'

describePg('导入层（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeEach(async () => {
    await applyMigrations(pool)
    // 清序：先子后父（FK）
    await pool.query(`delete from aftersales.ticket_attachment where org = $1`, [ORG])
    await pool.query(`delete from aftersales.ticket where org = $1`, [ORG])
    await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
    await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
    await pool.query(`delete from aftersales.employee_approval where org = $1`, [ORG])
    await pool.query(`delete from aftersales.ticket_rule where org = $1`, [ORG])
    await pool.query(`delete from aftersales.product where org = $1`, [ORG])
    await pool.query(`delete from aftersales.store where org = $1`, [ORG])
    await pool.query(`delete from aftersales.region where org = $1`, [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('链路：region→store（FK 解析）→product→employee（store_info 拆行+主门店）→ticket（二义洗清+快照）', async () => {
    await importRegion(pool, ORG, [
      { sourceId: 'R001', name: '华东' },
      { sourceId: 'R002', name: '华北' },
    ])
    // 夹具补导 S002：FIXTURE_EMPLOYEE.store_info='S001，S002' 两段都要能解析到档案，下面的 2 行断言才成立
    await importStore(pool, ORG, [
      cleanStore({ _id: 'S001', name: '一号店', region_id: 'R001' }),
      cleanStore({ _id: 'S002', name: '二号店', region_id: 'R002' }),
    ])
    await importProduct(pool, ORG, [{ sourceId: 'P001', name: '商品甲', spec: '500ml', basicQuantity: 10, basicUnitPriceMinor: 1250n }])

    const empStat = await importEmployee(pool, ORG, [cleanEmployee(FIXTURE_EMPLOYEE)])
    expect(empStat).toMatchObject({ table: 'employee', fetched: 1, imported: 1 })

    const tStat = await importTicket(pool, ORG, [cleanTicket(FIXTURE_TICKET)])   // product_name='P001' 命中档案
    expect(tStat.imported).toBe(1)

    // FK 与二义洗清
    const t = await pool.query<{
      product_id: string | null; product_name: string; store_id: string | null; store_name: string;
      basic_unit_price_minor: string; amount_minor: string; code: string; related_order: string; client_request_id: string;
    }>(`select product_id, product_name, store_id, store_name, basic_unit_price_minor, amount_minor, code, related_order, client_request_id
          from aftersales.ticket where org = $1`, [ORG])
    expect(t.rows[0].product_id).not.toBeNull()                 // 'P001' 命中 source_id ⇒ 挂 FK
    expect(t.rows[0].product_name).toBe('商品甲')               // 快照名取档案名，不信源串
    expect(t.rows[0].store_id).not.toBeNull()
    expect(t.rows[0].basic_unit_price_minor).toBe('1250')
    expect(t.rows[0].amount_minor).toBe('20000')
    expect(t.rows[0].client_request_id).toBe('')                // 迁移行不占幂等键位
    // employee_store 拆行 + 主门店 = 串里第一个可解析的
    const links = await pool.query<{ store_id: string }>(
      `select es.store_id from aftersales.employee_store es
        join aftersales.employee e on e.id = es.employee_id
       where es.org = $1 order by es.id`, [ORG])
    expect(links.rows).toHaveLength(2)
    // 「不可解析段跳过」的行为此处不锁（S001/S002 都有档案）——由下一条「解析不到档案」用例专门锁
    const emp = await pool.query<{ store_id: string | null }>(
      `select store_id from aftersales.employee where org = $1`, [ORG])
    expect(Number(emp.rows[0].store_id)).toBe(Number(links.rows[0].store_id))
  })

  it('store_info 段解析不到档案 ⇒ 只该段跳过：落链 1 行、行照常导入、reasons 记 unresolved_store_ref', async () => {
    await importStore(pool, ORG, [cleanStore({ _id: 'S001', name: '一号店', region_id: 'R001' })])
    const stat = await importEmployee(pool, ORG, [
      cleanEmployee({ ...FIXTURE_EMPLOYEE, store_info: 'S001，S999' }),   // S999 无档案
    ])
    expect(stat).toMatchObject({ fetched: 1, imported: 1, skipped: 0 })   // 行不跳（主门店=S001 可解析）
    expect(stat.reasons['unresolved_store_ref']).toBe(1)                  // 丢的是「链」不是「行」——计数可见，不静默
    const links = await pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.employee_store where org = $1`, [ORG])
    expect(links.rows[0].n).toBe(1)                                      // 只有 S001 落链
  })

  it('未知状态/类型 ⇒ 整行跳过记因，绝不落库为 pending（T3/T5 的前提）', async () => {
    const stat = await importTicket(pool, ORG, [
      cleanTicket({ ...FIXTURE_TICKET, _id: 'wo-x1', status: '神秘态' }),
      cleanTicket({ ...FIXTURE_TICKET, _id: 'wo-x2', after_sales_type: '第四种' }),
      cleanTicket(FIXTURE_TICKET),
    ])
    expect(stat).toMatchObject({ fetched: 3, imported: 1, skipped: 2 })
    expect(stat.reasons['unknown_status']).toBe(1)
    expect(stat.reasons['unknown_amount_type']).toBe(1)
    const rows = await pool.query<{ n: number; status: string }>(
      `select count(*)::int as n, max(status) as status from aftersales.ticket where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0]).toEqual({ n: 1, status: 'completed' })           // 落库的只有可映射行——未知态从未变 pending
  })

  it('幂等重跑：同批再导一遍 = 行数不变、字段被覆盖更新（source_id 是幂等位）', async () => {
    await importRegion(pool, ORG, [{ sourceId: 'R001', name: '华东' }])
    await importRegion(pool, ORG, [{ sourceId: 'R001', name: '华东新区' }])   // 重跑带 drifted 值
    const rows = await pool.query<{ n: number; name: string }>(
      `select count(*)::int as n, max(name) as name from aftersales.region where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0]).toEqual({ n: 1, name: '华东新区' })
  })

  it('缺 source_id 的行跳过并记原因（不打断整批）', async () => {
    const stat = await importRule(pool, ORG, [cleanRule({ ...FIXTURE_RULE, _id: '' }), cleanRule(FIXTURE_RULE)])
    expect(stat).toMatchObject({ fetched: 2, imported: 1, skipped: 1 })
    expect(stat.reasons['no_source_id']).toBe(1)
  })

  it('not-null 时间列的缺值不炸批：ticket/approval 缺全部时间键 → created_at 落当前时刻', async () => {
    // *.created_at 是 not null 列：clean 产物可为 null（源缺值），原样传 NULL 会 23502 打断整批。
    // 此处按 `?? new Date()` 收口到列缺省语义（迁移时刻），与「未知枚举跳行」不冲突——
    // 枚举错值是语义事故，时间缺值只是未录。（refund_ratio 缺值已改跳行/守卫语义，见下两条用例。）
    const { create_time: _noTime, ...noTime } = FIXTURE_TICKET   // 拿掉全部时间键的源行（destructure 比 delete 类型干净）
    const tStat = await importTicket(pool, ORG, [cleanTicket(noTime)])
    expect(tStat.imported).toBe(1)
    const t = await pool.query<{ created_at: Date }>(
      `select created_at from aftersales.ticket where org = $1 and source_id <> ''`, [ORG])
    expect(t.rows[0].created_at).not.toBeNull()

    const aStat = await importEmployeeApproval(pool, ORG, [cleanEmployeeApproval({ ...FIXTURE_EMPLOYEE_APPROVE, ctime: '', _ctime: '' })])
    expect(aStat.imported).toBe(1)
    const a = await pool.query<{ created_at: Date }>(
      `select created_at from aftersales.employee_approval where org = $1 and source_id <> ''`, [ORG])
    expect(a.rows[0].created_at).not.toBeNull()
  })

  it('规则缺 refund_ratio ⇒ 跳行记因 missing_refund_ratio，绝不静默落 0（2026-09-22 裁决①）', async () => {
    // 「没有比例的规则」落 0 = 替业务写死「无退款」——与未知枚举跳行同一条 skip 哲学。
    const stat = await importRule(pool, ORG, [cleanRule({ ...FIXTURE_RULE, refund_ratio: null })])
    expect(stat).toMatchObject({ fetched: 1, imported: 0, skipped: 1 })
    expect(stat.reasons['missing_refund_ratio']).toBe(1)
    const rows = await pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.ticket_rule where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0].n).toBe(0)                                        // 该行从未落库，更没落成 0.0000
  })

  it('重跑：库内已有比例、源侧同 source_id 行缺该字段 ⇒ 比例保持库内值不降级（裁决②）', async () => {
    await importRule(pool, ORG, [cleanRule(FIXTURE_RULE)])                // 首跑落 0.05
    const stat = await importRule(pool, ORG, [
      cleanRule({ ...FIXTURE_RULE, refund_ratio: null, name: '改名重跑' }), // 重跑：源缺比例 + drifted 名
    ])
    expect(stat).toMatchObject({ fetched: 1, imported: 1, skipped: 0 })   // 已存在行不跳——走的 DO UPDATE
    const rows = await pool.query<{ name: string; refund_ratio: string }>(
      `select name, refund_ratio::text as refund_ratio from aftersales.ticket_rule where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0].name).toBe('改名重跑')                            // update 确实执行了（不是整行跳过）
    expect(rows.rows[0].refund_ratio).toBe('0.0500')                      // 源缺值绝不把库内非空值降级
  })

  it('employee_approval 走 004 的 source_id 幂等位', async () => {
    await importEmployeeApproval(pool, ORG, [cleanEmployeeApproval(FIXTURE_EMPLOYEE_APPROVE)])
    await importEmployeeApproval(pool, ORG, [cleanEmployeeApproval(FIXTURE_EMPLOYEE_APPROVE)])
    const rows = await pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.employee_approval where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0].n).toBe(1)
  })
})
