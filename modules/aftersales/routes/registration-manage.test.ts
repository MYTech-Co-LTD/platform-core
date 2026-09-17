// routes/registration-manage.test.ts — 管理面申请审批（真 PG）。
// 重点：**通过 ⇒ 单事务写回 employee + employee_store**；并发决定只有一个能落。
import { Hono } from 'hono'
import { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../test-util'
import { registerRegistrationManage } from './registration-manage'

const ORG = 'test-m3b1-manage'
const OTHER_ORG = 'test-m3b1-manage-other'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

function app() {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    c.set('identity', { userId: 'admin1', orgId: ORG, displayName: '管理员', scopes: [], hasScope: () => true })
    await next()
  })
  registerRegistrationManage(r, { pool })
  return r
}

async function cleanup() {
  await pool.query(`delete from aftersales.employee_approval where org = any($1::text[])`, [[ORG, OTHER_ORG]])
  await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
  await pool.query(`delete from aftersales.store where org = $1`, [ORG])
}
// 自带迁移（评审 N3）：本文件必须**自足**，不能依赖别的包先迁完 aftersales schema。
// `pnpm -r` 的包间执行顺序不保证 —— 靠 apps/server「顺带」迁移就是「本地红、CI 绿」的时序红
// （#84 里那 3 个 `relation "aftersales.employee_approval" does not exist` 正是这么来的）。
// 放在 cleanup **之前**：cleanup 自己就查 aftersales.* 的表，表还不存在它先挂。
beforeAll(async () => {
  await applyMigrations(pool)
  await cleanup()
})
beforeEach(cleanup)
afterAll(async () => {
  await cleanup()
  await pool.end()
})

/** 建两张门店并返回 id（**在 cleanup 之后**调，别放 beforeAll） */
async function seedStores(): Promise<number[]> {
  await pool.query(
    `insert into aftersales.store(org, name, address, phone) values ($1,'店A','',''), ($1,'店B','','')`,
    [ORG],
  )
  return (await pool.query<{ id: string }>(`select id from aftersales.store where org=$1 order by id`, [ORG])).rows.map(
    (r) => Number(r.id),
  )
}

async function seedApproval(openId: string, type: 'register' | 'change', info: object): Promise<number> {
  const ins = await pool.query<{ id: string }>(
    `insert into aftersales.employee_approval(org, open_id, approve_type, old_info, new_info)
     values ($1, $2, $3, '{}'::jsonb, $4::jsonb) returning id`,
    [ORG, openId, type, JSON.stringify(info)],
  )
  return Number(ins.rows[0]!.id)
}

const decide = (id: number, decision: string) =>
  app().request(`/employee-approvals/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  })

describe('GET /employee-approvals', () => {
  it('列表 + status 筛选；只回本 org', async () => {
    await seedApproval('o1', 'register', { name: '甲' })
    await seedApproval('o2', 'register', { name: '乙' })
    await pool.query(`update aftersales.employee_approval set status='approved' where org=$1 and open_id='o2'`, [ORG])
    await pool.query(
      `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
       values ($1,'别人的','register','{}'::jsonb)`,
      [OTHER_ORG],
    )

    const all = (await (await app().request('/employee-approvals')).json()) as { items: Array<{ openId: string }> }
    expect(all.items.map((i) => i.openId).sort()).toEqual(['o1', 'o2'])

    const pend = (await (await app().request('/employee-approvals?status=pending')).json()) as {
      items: Array<{ openId: string }>
    }
    expect(pend.items.map((i) => i.openId)).toEqual(['o1'])
  })
})

describe('POST /employee-approvals/:id/decide', () => {
  it('★ 通过 register ⇒ 建 employee 行（approved）+ 写 employee_store 关联 + 记 decided_by', async () => {
    const [s1] = await seedStores()
    const id = await seedApproval('o1', 'register', { name: '张三', phone: '138', storeIds: [s1] })

    expect((await decide(id, 'approve')).status).toBe(200)

    const emp = (
      await pool.query(`select name, phone, store_id, approve_status from aftersales.employee where org=$1 and open_id='o1'`, [ORG])
    ).rows[0] as { name: string; phone: string; store_id: string; approve_status: string }
    expect(emp.name).toBe('张三')
    expect(emp.phone).toBe('138')
    expect(emp.approve_status).toBe('approved')
    expect(Number(emp.store_id)).toBe(s1) // 主门店 = 归一后第一个

    const links = (
      await pool.query<{ store_id: string }>(`select store_id from aftersales.employee_store where org=$1 order by store_id`, [ORG])
    ).rows.map((r) => Number(r.store_id))
    expect(links).toEqual([s1])

    const ap = (await pool.query(`select status, decided_by, decided_at from aftersales.employee_approval where id=$1`, [id])).rows[0] as {
      status: string
      decided_by: string
      decided_at: string | null
    }
    expect(ap.status).toBe('approved')
    expect(ap.decided_by).toBe('管理员')
    expect(ap.decided_at).not.toBeNull()
  })

  it('★ 通过 change ⇒ 改 employee 行 + **重建** employee_store（旧关联被删）', async () => {
    const [s1, s2] = await seedStores()
    const emp = await pool.query<{ id: string }>(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status)
       values ($1,'张三','138','o1','approved') returning id`,
      [ORG],
    )
    await pool.query(`insert into aftersales.employee_store(org, employee_id, store_id) values ($1,$2,$3)`, [
      ORG,
      Number(emp.rows[0]!.id),
      s1,
    ])
    const id = await seedApproval('o1', 'change', { storeIds: [s2] })

    expect((await decide(id, 'approve')).status).toBe(200)

    const links = (
      await pool.query<{ store_id: string }>(`select store_id from aftersales.employee_store where org=$1 order by store_id`, [ORG])
    ).rows.map((r) => Number(r.store_id))
    expect(links).toEqual([s2]) // s1 的关联被删掉（重建而不是追加）
    // 且没有多建一行 employee
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee where org=$1`, [ORG])).rows[0]!.n)).toBe(1)
  })

  it('★ 变更只换了手机号（new_info 无 storeIds）⇒ **不碰** employee_store', async () => {
    const [s1] = await seedStores()
    const emp = await pool.query<{ id: string }>(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status)
       values ($1,'张三','138','o1','approved') returning id`,
      [ORG],
    )
    await pool.query(`insert into aftersales.employee_store(org, employee_id, store_id) values ($1,$2,$3)`, [
      ORG,
      Number(emp.rows[0]!.id),
      s1,
    ])
    const id = await seedApproval('o1', 'change', { phone: '139' })

    expect((await decide(id, 'approve')).status).toBe(200)

    expect(
      Number((await pool.query(`select count(*)::int n from aftersales.employee_store where org=$1`, [ORG])).rows[0]!.n),
    ).toBe(1)
    expect(((await pool.query(`select phone from aftersales.employee where org=$1 and open_id='o1'`, [ORG])).rows[0] as { phone: string }).phone).toBe('139')
  })

  it('驳回 ⇒ 只改申请状态，**不碰 employee**', async () => {
    const id = await seedApproval('o1', 'register', { name: '张三' })
    expect((await decide(id, 'reject')).status).toBe(200)
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee where org=$1`, [ORG])).rows[0]!.n)).toBe(0)
    expect(((await pool.query(`select status from aftersales.employee_approval where id=$1`, [id])).rows[0] as { status: string }).status).toBe('rejected')
  })

  it('★ 已决的申请再决 ⇒ 409 ALREADY_DECIDED（状态机条件更新，不是先查后改）', async () => {
    const [s1] = await seedStores()
    const id = await seedApproval('o1', 'register', { name: '张三', storeIds: [s1] })
    expect((await decide(id, 'approve')).status).toBe(200)
    const again = await decide(id, 'approve')
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toBe('ALREADY_DECIDED')
    // 且没有重复建 employee
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee where org=$1`, [ORG])).rows[0]!.n)).toBe(1)
  })

  it('不存在的 id ⇒ 404；非规范 id（1e5）也 ⇒ 404（parseIdParam 口径）', async () => {
    expect((await decide(999999, 'approve')).status).toBe(404)
    const bad = await app().request('/employee-approvals/1e5/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(bad.status).toBe(404)
  })

  it('decision 不是 approve/reject ⇒ 400', async () => {
    const id = await seedApproval('o1', 'register', { name: '张三' })
    expect((await decide(id, 'maybe')).status).toBe(400)
  })

  it('★ 租户隔离：另一个 org 的申请决不了（**404 不是 403**，不泄露存在性）', async () => {
    const ins = await pool.query<{ id: string }>(
      `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
       values ($1,'o1','register','{}'::jsonb) returning id`,
      [OTHER_ORG],
    )
    expect((await decide(Number(ins.rows[0]!.id), 'approve')).status).toBe(404)
    // 且它仍是 pending（没被跨租户改掉）
    expect(
      ((await pool.query(`select status from aftersales.employee_approval where id=$1`, [Number(ins.rows[0]!.id)])).rows[0] as { status: string }).status,
    ).toBe('pending')
  })
})
