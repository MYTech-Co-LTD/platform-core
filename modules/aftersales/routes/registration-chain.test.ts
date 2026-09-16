// routes/registration-chain.test.ts — M3b-1 的**端到端链路**（真 PG）。
//
// 为什么单独一个文件：其它两个测试文件各自只验**一面**（访客面 / 管理面），而这条链的
// 价值在**跨面**——「访客提交 → 管理端看到 → 通过 → **访客侧读回写回后的档案**」。
// 这正是 M3b-2 的移动端要走的路，也是「登记闸门」能成立的前提。
import { Hono } from 'hono'
import { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerRegistrationGuest } from './registration-guest'
import { registerRegistrationManage } from './registration-manage'

const ORG = 'test-m3b1-chain'
const OPENID = 'openid-chain'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

/** 建一个只注入给定 identity 的 app；「两面」在真实模块里挂在同一个 router 上 */
function asIdentity(identity: Partial<Identity>) {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    c.set('identity', {
      userId: 'x', orgId: ORG, displayName: 'x', scopes: [], hasScope: () => true, ...identity,
    } as Identity)
    await next()
  })
  registerRegistrationGuest(r, { pool, storage: null })
  registerRegistrationManage(r, { pool, storage: null })
  return r
}
const guest = () => asIdentity({ userId: OPENID, displayName: OPENID })
const admin = () => asIdentity({ userId: 'admin1', displayName: '管理员' })

async function cleanup() {
  await pool.query(`delete from aftersales.employee_approval where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
  await pool.query(`delete from aftersales.store where org = $1`, [ORG])
}
beforeAll(cleanup)
beforeEach(async () => {
  await cleanup()
  await pool.query(
    `insert into aftersales.store(org, name, address, phone) values ($1,'店A','',''), ($1,'店B','','')`,
    [ORG],
  )
})
afterAll(async () => {
  await cleanup()
  await pool.end()
})

const storeIds = async (): Promise<number[]> =>
  (await pool.query<{ id: string }>(`select id from aftersales.store where org=$1 order by id`, [ORG])).rows.map((r) =>
    Number(r.id),
  )

describe('M3b-1 端到端：登记 → 审批 → 写回', () => {
  it('★ 完整链路', async () => {
    const [s1, s2] = await storeIds()

    // ① 访客：提交登记
    const submitted = await guest().request('/guest/employee-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '加盟商甲', phone: '13800000000', storeIds: [s1, s2] }),
    })
    expect(submitted.status).toBe(201)

    // ② 此时「我的登记」仍为空（**申请还没批** ⇒ 登记闸门不放行），但有待审标记
    const before = (await (await guest().request('/guest/me/registration')).json()) as {
      registration: unknown
      hasPendingApproval: boolean
    }
    expect(before.registration).toBeNull()
    expect(before.hasPendingApproval).toBe(true)

    // ③ 访客：重复提交 ⇒ 409（库的部分唯一索引拦的）
    const dup = await guest().request('/guest/employee-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '加盟商甲', phone: '13900000000', storeIds: [s1] }),
    })
    expect(dup.status).toBe(409)

    // ④ 管理端：列表里看得到这条
    const list = (await (await admin().request('/employee-approvals')).json()) as {
      items: Array<{ id: number; openId: string; status: string }>
    }
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.openId).toBe(OPENID)
    expect(list.items[0]!.status).toBe('pending')
    const approvalId = list.items[0]!.id

    // ⑤ 管理端：通过 ⇒ 单事务写回
    const decided = await admin().request(`/employee-approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(decided.status).toBe(200)

    // ⑥ 访客：**读回写回后的档案**（这正是 M3b-2 移动端的闸门判据）
    const after = (await (await guest().request('/guest/me/registration')).json()) as {
      registration: { name: string; phone: string; storeIds: number[] }
      hasPendingApproval: boolean
    }
    expect(after.registration).toEqual({ name: '加盟商甲', phone: '13800000000', storeIds: [s1, s2] })
    expect(after.hasPendingApproval).toBe(false)

    // ⑦ 管理端：再决一次 ⇒ 409
    const again = await admin().request(`/employee-approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(again.status).toBe(409)

    // ⑧ 且没有重复建档案
    expect(Number((await pool.query(`select count(*)::int n from aftersales.employee where org=$1`, [ORG])).rows[0]!.n)).toBe(1)
  })

  it('★ 驳回后可以重新提交（pending 释放 ⇒ 唯一索引不再挡）', async () => {
    const [s1] = await storeIds()
    const submit = () =>
      guest().request('/guest/employee-approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '加盟商甲', phone: '138', storeIds: [s1] }),
      })
    await submit()
    const list = (await (await admin().request('/employee-approvals')).json()) as { items: Array<{ id: number }> }
    await admin().request(`/employee-approvals/${list.items[0]!.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    })
    // 被驳回后 pending 已释放 ⇒ 可以再提交
    expect((await submit()).status).toBe(201)
  })

  it('★ 变更链路：已登记的人提交变更 → 审批 → 门店被重建', async () => {
    const [s1, s2] = await storeIds()
    // 先走一遍注册并审批
    await guest().request('/guest/employee-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '加盟商甲', phone: '138', storeIds: [s1] }),
    })
    const l1 = (await (await admin().request('/employee-approvals')).json()) as { items: Array<{ id: number }> }
    await admin().request(`/employee-approvals/${l1.items[0]!.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })

    // 提交变更：把门店从 [s1] 改成 [s2]
    const changed = await guest().request('/guest/employee-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '加盟商甲', phone: '138', storeIds: [s2] }),
    })
    expect(changed.status).toBe(201)
    expect(((await changed.json()) as { approveType: string }).approveType).toBe('change')

    const l2 = (await (await admin().request('/employee-approvals?status=pending')).json()) as {
      items: Array<{ id: number }>
    }
    await admin().request(`/employee-approvals/${l2.items[0]!.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })

    const after = (await (await guest().request('/guest/me/registration')).json()) as {
      registration: { storeIds: number[] }
    }
    expect(after.registration.storeIds).toEqual([s2]) // 重建：s1 的关联已被删
  })

  it('★ 什么都没改的变更 ⇒ 400（源侧「您没有修改任何信息」）', async () => {
    const [s1] = await storeIds()
    await guest().request('/guest/employee-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '加盟商甲', phone: '138', storeIds: [s1] }),
    })
    const l = (await (await admin().request('/employee-approvals')).json()) as { items: Array<{ id: number }> }
    await admin().request(`/employee-approvals/${l.items[0]!.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    const same = await guest().request('/guest/employee-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '加盟商甲', phone: '138', storeIds: [s1] }),
    })
    expect(same.status).toBe(400)
    expect(((await same.json()) as { message?: string }).message).toContain('没有修改')
  })
})
