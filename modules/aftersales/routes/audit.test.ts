// routes/audit.test.ts — 写操作审计（评审 P0-2；迁移 007 aftersales.audit）
//
// 覆盖：规则 CRUD（含硬删前读出被删内容）、员工新建/审批、申请决定、附件 GC（dry-run 也记）、
// 以及「事务回滚不留审计」。ticket.process 的审计断言在 ticket.test.ts（那边有完整造单夹具）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { TenantStorageConfig } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, ensureDimTables, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-audit'
const TENANT_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'https://zos.audit.test',
  region: 'xinan1',
  bucket: 'audit-b1',
  accessKeyId: 'AKIAAUDIT',
  secretAccessKey: 'sk-audit',
}

describePg('写操作审计', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'auditor-1', scopes: ['aftersales:manage'] }),
    { pool },
    TENANT_CFG,
  )

  const query = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql, params)

  const audits = async () =>
    (await query<{ actor: string; action: string; target: string; detail: Record<string, unknown> }>(
      'select actor, action, target, detail from aftersales.audit where org = $1 order by id',
      [ORG],
    )).rows

  beforeAll(async () => {
    await applyMigrations(pool)
    // 员工新建会校验 data.dim_branch（#476）——CI 包间顺序不保证 data 先迁移，这里自愈
    await ensureDimTables(pool)
  })

  beforeEach(async () => {
    await query('delete from aftersales.audit where org = $1', [ORG])
    await query('delete from aftersales.ticket_rule where org = $1', [ORG])
    await query('delete from aftersales.employee_store where org = $1', [ORG])
    await query('delete from aftersales.employee where org = $1', [ORG])
    await query('delete from aftersales.employee_approval where org = $1', [ORG])
  })

  afterAll(async () => {
    await query('delete from aftersales.audit where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  it('规则 create/update/delete 各落一行审计；硬删记下被删内容', async () => {
    const created = await (await send('/rules', 'POST', { name: '常规', refundRatio: 0.1, remark: '' })).json() as { id: number }
    const updated = await send(`/rules/${created.id}`, 'PUT', { name: '常规改', refundRatio: 0.2, remark: 'x' })
    expect(updated.status).toBe(200)
    const deleted = await send(`/rules/${created.id}`, 'DELETE')
    expect(deleted.status).toBe(200)

    const rows = await audits()
    expect(rows.map((r) => r.action)).toEqual(['rule.create', 'rule.update', 'rule.delete'])
    expect(rows.every((r) => r.actor === 'auditor-1')).toBe(true)
    expect(rows[0].detail).toMatchObject({ name: '常规', refundRatio: 0.1 })
    expect(rows[1].detail).toMatchObject({ name: '常规改', refundRatio: 0.2 })
    // 硬删：被删内容必须留痕（删后无法回读）
    expect(rows[2].detail).toMatchObject({ name: '常规改', refundRatio: '0.2000' })
  })

  it('员工新建 ⇒ employee.create；detail 不含手机号明文', async () => {
    const res = await send('/employees', 'POST', { name: '张三', phone: '13800001111' })
    expect(res.status).toBe(201)
    const rows = await audits()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'employee.create', actor: 'auditor-1' })
    expect(JSON.stringify(rows[0].detail)).not.toContain('13800001111')
  })

  it('员工审批 ⇒ employee.approve（记目标状态）', async () => {
    const emp = await (await send('/employees', 'POST', { name: '李四' })).json() as { id: number }
    const res = await send(`/employees/${emp.id}/approve`, 'POST', { approveStatus: 'approved' })
    expect(res.status).toBe(200)
    const rows = (await audits()).filter((r) => r.action === 'employee.approve')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target: String(emp.id) })
    expect(rows[0].detail).toMatchObject({ approveStatus: 'approved' })
  })

  it('申请决定 ⇒ approval.decide；与档案写回同事务（一行审计）', async () => {
    const ap = await query<{ id: string }>(
      `insert into aftersales.employee_approval(org, open_id, approve_type, status, new_info)
       values ($1, 'openid-audit-1', 'register', 'pending', '{"name":"王五","storeCodes":["S09"]}') returning id`,
      [ORG],
    )
    const id = Number(ap.rows[0].id)
    const res = await send(`/employee-approvals/${id}/decide`, 'POST', { decision: 'approve' })
    expect(res.status).toBe(200)
    const rows = await audits()
    const decide = rows.filter((r) => r.action === 'approval.decide')
    expect(decide).toHaveLength(1)
    expect(decide[0].detail).toMatchObject({ decision: 'approve', status: 'approved' })
  })

  it('附件 GC：dry-run 也落审计（扫描结果本身是运维证据）', async () => {
    const res = await send('/attachments/gc', 'POST', { dryRun: true, olderThanDays: 7 })
    expect(res.status).toBe(200)
    const rows = (await audits()).filter((r) => r.action === 'attachment.gc')
    expect(rows).toHaveLength(1)
    expect(rows[0].detail).toMatchObject({ dryRun: true, olderThanDays: 7 })
    expect(rows[0].detail).toHaveProperty('scanned')
  })

  it('事务回滚 ⇒ 不留审计（审计记的是「已发生的写」，不是尝试）', async () => {
    // 员工新建 + 不存在的 storeCode ⇒ 400 且事务回滚
    const res = await send('/employees', 'POST', { name: '赵六', storeCode: 'NO-SUCH-STORE' })
    expect(res.status).toBe(400)
    expect(await audits()).toEqual([])
  })
})
