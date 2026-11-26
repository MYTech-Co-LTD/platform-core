// ticket-console.test.ts — 工单页对齐无极的服务端面（2026-11-26 / #2884）。
//
// 覆盖：筛选（状态/品牌/五个搜索项/处理时间）、计数语义、金额预览与落库一致、
// 处理必填（opinion/watermarkAt）与 remark 不再覆盖、小数报损数量、导出 Excel、
// 附件清单预签名、批量删除（含存储解析失败整单不动）、审计。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import ExcelJS from 'exceljs'
import { storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, ensureDimTables, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-console'
/** 对象存储指向一个必定拒绝连接的端口：删除会失败但很快返回，正好覆盖「孤儿对象」分支。 */
const TENANT_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'http://127.0.0.1:9',
  region: 'xinan1',
  bucket: 'b1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'sk-test',
}
const TENANT_REF = storageRefOf(TENANT_CFG)
const GHOST_REF = 's3|http://zos.ghost.test|ghost-bucket'

describePg('工单页对齐无极（#2884）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const manage = makeIdentity({ orgId: ORG, scopes: ['aftersales:manage', 'aftersales:delete'] })
  const guest = makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] })
  const ctx = { pool }
  const appManage = buildTestApp(mod, manage, ctx, TENANT_CFG)
  const appGuest = buildTestApp(mod, guest, ctx, TENANT_CFG)

  let seq = 0

  /** 直接造工单：本文件关心查询/导出/删除，不重复走访客提单的完整链路。 */
  async function createTicket(over: Record<string, unknown> = {}): Promise<number> {
    seq++
    const t = {
      code: `AS-${String(90000000 + seq)}`,
      product_name: '苹果',
      store_name: '熊喵一号店',
      damage_quantity: '2.00',
      basic_quantity: '10.000000',
      settlement_price_minor: 450,
      status: 'pending',
      amount_type: null,
      amount_minor: 0,
      refund_ratio: null,
      operator: null,
      remark: '店员填的原因',
      opinion: '',
      watermark_at: null,
      related_order: '',
      processed_at: null,
      store_affiliation: 'matched',
      ...over,
    }
    const res = await pool.query<{ id: string }>(
      `insert into aftersales.ticket(
         org, code, product_name, store_name,
         damage_quantity, basic_quantity, settlement_price_minor,
         status, amount_type, amount_minor, refund_ratio, operator, remark, opinion,
         watermark_at, related_order, processed_at, store_affiliation)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       returning id`,
      [ORG, t.code, t.product_name, t.store_name, t.damage_quantity, t.basic_quantity,
        t.settlement_price_minor, t.status, t.amount_type, t.amount_minor, t.refund_ratio,
        t.operator, t.remark, t.opinion, t.watermark_at, t.related_order, t.processed_at,
        t.store_affiliation],
    )
    return Number(res.rows[0]!.id)
  }

  async function addAttachment(ticketId: number, opts: { contentType?: string; ref?: string } = {}): Promise<void> {
    await pool.query(
      `insert into aftersales.ticket_attachment(org, ticket_id, object_key, content_type, size_bytes, storage_ref)
       values ($1,$2,$3,$4,$5,$6)`,
      [ORG, ticketId, `k/${ticketId}/${seq++}`, opts.contentType ?? 'image/jpeg', 10, opts.ref ?? ''],
    )
  }

  beforeAll(async () => {
    await applyMigrations(pool)
    await ensureDimTables(pool)
    for (const t of ['ticket_attachment', 'ticket', 'employee_store', 'employee', 'audit']) {
      await pool.query(`delete from aftersales.${t} where org = $1`, [ORG])
    }
    await pool.query('delete from data.dim_settlement_order_line where org = $1', [ORG])
    await pool.query('delete from data.dim_item where org = $1', [ORG])
    await pool.query('delete from data.dim_branch where org = $1', [ORG])

    await pool.query(
      `insert into data.dim_branch(org, code, name, enable, source_book, snapshot)
       values ($1,'S01','熊喵一号店',true,'3120',current_date)`, [ORG])
    await pool.query(
      `insert into data.dim_item(org, item_code, name, sale_cease, source_book, snapshot)
       values ($1,'I001','苹果',false,'3120',current_date)`, [ORG])
    await pool.query(
      `insert into data.dim_settlement_order_line(
         org, source, store_code, store_name, order_no, order_bizday, order_time,
         item_code, item_name, line_key, quantity, money, price_minor)
       values ($1,'transfer','S01','熊喵一号店','MO3120992607050085',current_date - 1,'2026-10-07 11:07:31',
               'I001','苹果','0',12.5,5625,450)`, [ORG])

    const e = await pool.query<{ id: string }>(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status)
       values ($1,'alice','13800000001','openid-alice','approved') returning id`, [ORG])
    await pool.query(
      `insert into aftersales.employee_store(org, employee_id, store_code) values ($1,$2,'S01')`,
      [ORG, e.rows[0]!.id])
  })

  afterAll(async () => {
    for (const t of ['ticket_attachment', 'ticket', 'employee_store', 'employee', 'audit']) {
      await pool.query(`delete from aftersales.${t} where org = $1`, [ORG])
    }
    await pool.query('delete from data.dim_settlement_order_line where org = $1', [ORG])
    await pool.query('delete from data.dim_item where org = $1', [ORG])
    await pool.query('delete from data.dim_branch where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  // ── 建单：小数报损数量 + 基本数量冻结 ──────────────────────────────────────

  it('提单：damageQuantity 接受两位小数，且 basic_quantity 冻结结算行数量', async () => {
    const res = await appGuest.request('/guest/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: 'req-decimal', storeCode: 'S01', itemCode: 'I001',
        orderNo: 'MO3120992607050085', lineKey: '0', damageQuantity: 1.25,
      }),
    })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query(
      'select damage_quantity, basic_quantity from aftersales.ticket where org = $1 and id = $2',
      [ORG, id],
    )
    expect(Number(row.rows[0].damage_quantity)).toBe(1.25)
    expect(Number(row.rows[0].basic_quantity)).toBe(12.5)
  })

  it('提单：三位小数 ⇒ 400 INVALID_BODY', async () => {
    const res = await appGuest.request('/guest/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: 'req-third-decimal', storeCode: 'S01', itemCode: 'I001',
        orderNo: 'MO3120992607050085', lineKey: '0', damageQuantity: 1.234,
      }),
    })
    expect(res.status).toBe(400)
  })

  // ── 列表筛选 / 计数 ────────────────────────────────────────────────────────

  it('GET /tickets：状态/品牌/搜索/处理时间筛选，非法值 400', async () => {
    const xm = await createTicket({ code: 'AS-90000101', store_name: '熊喵一号店', product_name: '苹果' })
    const pp = await createTicket({
      code: 'AS-90000102', store_name: '品品甜二号店', product_name: '香蕉',
      status: 'completed', amount_type: 'ratio', amount_minor: 800, refund_ratio: '0.5000',
      opinion: '已处理', watermark_at: '2026-11-25', processed_at: new Date(),
    })
    const wh = await createTicket({ code: 'AS-90000103', store_name: '仓储中心', product_name: '橙子', status: 'cancelled' })
    await addAttachment(xm, { contentType: 'image/jpeg' })
    await addAttachment(xm, { contentType: 'video/mp4' })
    await addAttachment(pp, { contentType: 'image/png' })

    const list = async (qs: string) => {
      const res = await appManage.request(`/tickets?${qs}`)
      expect(res.status, qs).toBe(200)
      return (await res.json()) as { items: Record<string, unknown>[]; total: number }
    }

    expect((await list('status=pending')).items.map((i) => i.id)).toContain(xm)
    expect((await list('brand=xiongmao')).items.map((i) => i.id)).toContain(xm)
    expect((await list('brand=xiongmao')).items.map((i) => i.id)).not.toContain(pp)
    expect((await list('brand=pptd')).items.map((i) => i.id)).toContain(pp)
    expect((await list('code=AS-90000102')).items.map((i) => i.id)).toEqual([pp])
    expect((await list(`product=${encodeURIComponent('香蕉')}`)).items.map((i) => i.id)).toEqual([pp])
    expect((await list(`store=${encodeURIComponent('品品甜')}`)).items.map((i) => i.id)).toEqual([pp])
    expect((await list(`opinion=${encodeURIComponent('已处理')}`)).items.map((i) => i.id)).toEqual([pp])
    // 处理时间：只 completed 有值 ⇒ 当天范围应只命中 pp
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    expect((await list(`processedFrom=${today}&processedTo=${today}`)).items.map((i) => i.id)).toEqual([pp])
    // 无品牌门店不进品牌筛选（不在任何品牌结果里）
    expect((await list('brand=pptd')).items.map((i) => i.id)).not.toContain(wh)

    // 行字段：品牌 / 报损金额（毛额）/ 附件计数 / 售后意见 / 水印
    const row = (await list('code=AS-90000101')).items[0]!
    expect(row.brand).toBe('xiongmao')
    expect(row.damage_amount_minor).toBe(900)
    expect(row.image_count).toBe(1)
    expect(row.video_count).toBe(1)
    const processed = (await list('code=AS-90000102')).items[0]!
    expect(processed.opinion).toBe('已处理')
    expect(processed.watermark_at).toBe('2026-11-25')
    expect(processed.damage_amount_minor).toBe(900)

    for (const qs of ['status=foo', 'brand=foo', 'processedFrom=2026-02-30']) {
      expect((await appManage.request(`/tickets?${qs}`)).status, qs).toBe(400)
    }
  })

  it('GET /tickets/counts：状态全局、品牌只跟随 status', async () => {
    const res = await appManage.request('/tickets/counts')
    const body = (await res.json()) as {
      status: { all: number; pending: number; completed: number; cancelled: number }
      brand: { xiongmao: number; pptd: number; none: number }
    }
    expect(body.status.all).toBe(body.status.pending + body.status.completed + body.status.cancelled)
    expect(body.status.completed).toBeGreaterThanOrEqual(1)
    // 不带 status：品牌计数是全量分布（熊喵 ≥ 1、品品甜 ≥ 1）
    expect(body.brand.xiongmao).toBeGreaterThanOrEqual(1)
    expect(body.brand.pptd).toBeGreaterThanOrEqual(1)

    const completed = (await (await appManage.request('/tickets/counts?status=completed')).json()) as {
      status: { all: number; completed: number }
      brand: { xiongmao: number; pptd: number; none: number }
    }
    // 状态计数仍是全局的（不因 status 参数而变）
    expect(completed.status.all).toBe(body.status.all)
    // 品牌计数只跟 completed
    expect(completed.brand.pptd).toBeGreaterThanOrEqual(1)
    expect(completed.brand.xiongmao).toBe(0)

    expect((await appManage.request('/tickets/counts?status=foo')).status).toBe(400)
  })

  // ── 金额预览 / 处理 ────────────────────────────────────────────────────────

  it('quote 与 process 用同一个函数：预览 800 分 = 落库 800 分；remark 不被覆盖', async () => {
    const id = await createTicket({ damage_quantity: '10.00', basic_quantity: '4.000000', settlement_price_minor: 100 })

    const quote = await appManage.request(`/tickets/${id}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 0.5 }),
    })
    expect(quote.status).toBe(200)
    const q = (await quote.json()) as { amountMinor: number; damageAmountMinor: number }
    expect(q.amountMinor).toBe(800) // (10 − 4×0.5) × 100
    expect(q.damageAmountMinor).toBe(1000)

    // 预览不写库
    const before = await pool.query('select status, amount_minor from aftersales.ticket where org = $1 and id = $2', [ORG, id])
    expect(before.rows[0]).toMatchObject({ status: 'pending', amount_minor: '0' })

    const proc = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 0.5, opinion: '按比例赔付', watermarkAt: '2026-11-26' }),
    })
    expect(proc.status).toBe(200)
    const after = await pool.query(
      `select status, amount_minor, refund_ratio, operator, remark, opinion, watermark_at::text, processed_at
         from aftersales.ticket where org = $1 and id = $2`, [ORG, id])
    expect(after.rows[0]).toMatchObject({
      status: 'completed', amount_minor: '800', refund_ratio: '0.5000',
      remark: '店员填的原因', opinion: '按比例赔付', watermark_at: '2026-11-26',
    })
    expect(after.rows[0].processed_at).not.toBeNull()

    const audit = await pool.query(
      `select detail from aftersales.audit where org = $1 and action = 'ticket.process' and target = $2`,
      [ORG, String(id)])
    expect(audit.rows[0].detail).toMatchObject({ amountMinor: 800, watermarkAt: '2026-11-26' })
  })

  it('quote：非 pending ⇒ 409；reject 预览 0 分', async () => {
    const done = await createTicket({ status: 'completed', amount_type: 'reject', amount_minor: 0 })
    const res = await appManage.request(`/tickets/${done}/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(res.status).toBe(409)

    const pending = await createTicket({})
    const q = await appManage.request(`/tickets/${pending}/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(q.status).toBe(200)
    expect((await q.json()) as { amountMinor: number }).toMatchObject({ amountMinor: 0 })
  })

  it('process：缺 opinion / watermarkAt ⇒ 400（必填）', async () => {
    const id = await createTicket({})
    for (const body of [
      { amountType: 'reject', watermarkAt: '2026-11-26' },
      { amountType: 'reject', opinion: '意见' },
      { amountType: 'reject', opinion: '', watermarkAt: '2026-11-26' },
      { amountType: 'reject', opinion: '意见', watermarkAt: '2026-02-30' },
    ]) {
      const res = await appManage.request(`/tickets/${id}/process`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  // ── 导出 / 附件清单 ────────────────────────────────────────────────────────

  it('GET /tickets/export：服务端 Excel + 列选择；未知列 400', async () => {
    const res = await appManage.request('/tickets/export?range=all&columns=code,damageAmount,refundAmount')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''")

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()))
    const ws = wb.getWorksheet('售后工单')!
    expect([1, 2, 3].map((c) => ws.getRow(1).getCell(c).value)).toEqual(['工单编号', '报损金额', '赔付金额'])
    expect(ws.rowCount).toBeGreaterThan(1)

    expect((await appManage.request('/tickets/export?range=all&columns=nope')).status).toBe(400)
    expect((await appManage.request('/tickets/export?range=nope')).status).toBe(400)
  })

  it('GET /tickets/export-manifest：只列有附件的工单，URL 是预签名', async () => {
    const withAtt = await createTicket({ code: 'AS-90000201' })
    const without = await createTicket({ code: 'AS-90000202' })
    await addAttachment(withAtt, { ref: TENANT_REF, contentType: 'image/jpeg' })

    const res = await appManage.request(`/tickets/export-manifest?range=selected&ids=${withAtt},${without}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tickets: { id: number; attachments: { url: string | null }[] }[]
    }
    expect(body.tickets.map((t) => t.id)).toEqual([withAtt])
    expect(body.tickets[0]!.attachments[0]!.url).toMatch(/^http/)

    expect((await appManage.request('/tickets/export-manifest?range=selected&ids=')).status).toBe(400)
  })

  // ── 批量删除 ───────────────────────────────────────────────────────────────

  it('批量删除：删附件行 + 工单 + 审计；对象删不掉只留孤儿（不回滚）', async () => {
    const id = await createTicket({ code: 'AS-90000301' })
    await addAttachment(id, { ref: TENANT_REF })

    const res = await appManage.request('/tickets/batch-delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { deleted: number[] }).toMatchObject({ deleted: [id] })

    const ticket = await pool.query('select 1 from aftersales.ticket where org = $1 and id = $2', [ORG, id])
    const att = await pool.query('select 1 from aftersales.ticket_attachment where org = $1 and ticket_id = $2', [ORG, id])
    expect(ticket.rowCount).toBe(0)
    expect(att.rowCount).toBe(0)
    const audit = await pool.query(
      `select detail from aftersales.audit where org = $1 and action = 'ticket.delete' and target = 'AS-90000301'`,
      [ORG])
    expect(audit.rows[0].detail).toMatchObject({ status: 'pending', attachments: 1 })
  })

  it('批量删除：附件存储解析不出来 ⇒ 该单整体不动', async () => {
    const id = await createTicket({ code: 'AS-90000302' })
    await addAttachment(id, { ref: GHOST_REF })

    const res = await appManage.request('/tickets/batch-delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { deleted: number[]; failed: { id: number; error: string }[] }
    expect(body.deleted).toEqual([])
    expect(body.failed[0]).toMatchObject({ id, error: 'STORAGE_UNRESOLVED' })
    const ticket = await pool.query('select 1 from aftersales.ticket where org = $1 and id = $2', [ORG, id])
    expect(ticket.rowCount).toBe(1)
  })

  it('批量删除：空/超限/非整数 ⇒ 400', async () => {
    for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, { ids: [1.5] }]) {
      const res = await appManage.request('/tickets/batch-delete', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })
})
