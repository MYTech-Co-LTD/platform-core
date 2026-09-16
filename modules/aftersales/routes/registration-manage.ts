// routes/registration-manage.ts — 管理面：申请列表 + 决定（spec §2.5）。
//
// ★ 纪律③：**通过 ⇒ 申请状态与 employee/employee_store 的写入在同一事务**。
//   不允许「申请已通过但员工档案没改」——那会让申请列表与员工档案互相说谎。
//
// 与 M3a 的 `POST /employees/:id/approve` **语义不同**（那个直接改 employee 的 approve_status）：
// 本文的端点决的是**申请**，通过后按申请内容写回档案。**加而不改**。
import { z } from 'zod'
import { pickPrimaryStoreId } from '../domain/registration'
import { parseIdParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

const DecideBody = z.object({ decision: z.enum(['approve', 'reject']) })

/** `new_info` 的形状（服务端算出来的差异，键可能不全） */
interface NewInfo {
  name?: string
  phone?: string
  storeIds?: number[]
}

export function registerRegistrationManage(r: ModuleHono, ctx: RouteCtx): void {
  // ── 申请列表 ──────────────────────────────────────────────────────────────
  r.get('/employee-approvals', async (c) => {
    const org = c.get('identity').orgId
    const status = c.req.query('status')
    const params: unknown[] = [org]
    let where = 'org = $1'
    if (status) {
      params.push(status)
      where += ` and status = $${params.length}`
    }
    const res = await ctx.pool.query(
      `select id, open_id, approve_type, status, old_info, new_info, created_at, decided_at, decided_by
         from aftersales.employee_approval where ${where} order by id desc limit 500`,
      params,
    )
    return c.json({
      items: res.rows.map((a) => ({
        id: Number(a.id),
        openId: a.open_id,
        approveType: a.approve_type,
        status: a.status,
        oldInfo: a.old_info,
        newInfo: a.new_info,
        createdAt: a.created_at,
        decidedAt: a.decided_at,
        decidedBy: a.decided_by,
      })),
    })
  })

  // ── 决定（通过 ⇒ 单事务写回）────────────────────────────────────────────
  r.post('/employee-approvals/:id/decide', async (c) => {
    const org = c.get('identity').orgId
    const who = c.get('identity').displayName
    const id = parseIdParam(c.req.param('id'))
    // 404 不是 400：与 rule/masterdata 的既有口径一致（跨租户也走这条 ⇒ 不泄露存在性）
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const parsed = DecideBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { decision } = parsed.data

    const client = await ctx.pool.connect()
    try {
      await client.query('begin')

      // 状态机守卫：只决 pending 的（并发下另一个请求会 rowCount=0 ⇒ 409），**不先查后改**
      const lock = await client.query<{ open_id: string; new_info: NewInfo }>(
        `update aftersales.employee_approval set status = $3, decided_at = now(), decided_by = $4
          where org = $1 and id = $2 and status = 'pending'
        returning open_id, new_info`,
        [org, id, decision === 'approve' ? 'approved' : 'rejected', who],
      )
      if (lock.rowCount === 0) {
        await client.query('rollback')
        // 区分「不存在」与「已决」：再读一次（读不到 ⇒ 404）
        const exists = await ctx.pool.query(
          `select 1 from aftersales.employee_approval where org = $1 and id = $2`,
          [org, id],
        )
        const found = exists.rowCount! > 0
        return c.json({ error: found ? 'ALREADY_DECIDED' : 'NOT_FOUND' }, found ? 409 : 404)
      }

      if (decision === 'approve') {
        const ap = lock.rows[0]!
        const ni = ap.new_info ?? {}
        const primary = pickPrimaryStoreId({ name: ni.name ?? '', phone: ni.phone ?? '', storeIds: ni.storeIds ?? [] })

        // 写回档案：**先 select 再 insert/update**，不要写 `on conflict (org, open_id)`。
        // ⚠️ 实测：`employee` 在 `(org, open_id)` 上**只有普通索引、没有唯一约束**
        //    （唯一的那个是 `(org, source_id) where source_id <> ''`，用部分谓词躲开空值默认）
        //    ⇒ `on conflict (org, open_id)` 会直接报
        //    「there is no unique or exclusion constraint matching the ON CONFLICT specification」。
        //    也**不顺手加那个唯一索引**：源的 openid 有两种拼写（spec §3.3），M2b 导入可能撞重复。
        //
        // 这里不加锁也安全：同一个 openid **同时只可能有一条 pending 申请**（002 迁移的部分唯一索引），
        // 而本事务已用条件 update 把它从 pending 拿走了 ⇒ 不存在两个决定并发写同一 employee 行的窗口。
        const existing = await client.query<{ id: string }>(
          `select id from aftersales.employee where org = $1 and open_id = $2 order by id limit 1`,
          [org, ap.open_id],
        )
        let employeeId: number
        if (existing.rows[0]) {
          employeeId = Number(existing.rows[0].id)
          await client.query(
            `update aftersales.employee
                set name = $3, phone = $4, store_id = $5, approve_status = 'approved'
              where org = $1 and id = $2`,
            [org, employeeId, ni.name ?? '', ni.phone ?? '', primary],
          )
        } else {
          const ins = await client.query<{ id: string }>(
            `insert into aftersales.employee(org, open_id, name, phone, store_id, approve_status)
             values ($1, $2, $3, $4, $5, 'approved') returning id`,
            [org, ap.open_id, ni.name ?? '', ni.phone ?? '', primary],
          )
          employeeId = Number(ins.rows[0]!.id)
        }

        // employee_store 只在申请**确实动了门店**时重建（重建 = 删旧 + 插新，同一事务）
        if (ni.storeIds !== undefined) {
          await client.query(`delete from aftersales.employee_store where org = $1 and employee_id = $2`, [
            org,
            employeeId,
          ])
          for (const sid of ni.storeIds) {
            await client.query(
              `insert into aftersales.employee_store(org, employee_id, store_id) values ($1, $2, $3)`,
              [org, employeeId, sid],
            )
          }
        }
      }

      await client.query('commit')
      return c.json({ ok: true, id, decision })
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
}
