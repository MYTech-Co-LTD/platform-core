// routes/registration-guest.test.ts — 访客面登记端点（真 PG，与既有 routes/*.test.ts 同栈）
import { Hono } from 'hono'
import { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerRegistrationGuest } from './registration-guest'

const ORG = 'test-m3b1-guest'
const OTHER_ORG = 'test-m3b1-other'
const OPENID = 'openid-guest-1'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

function app(openid = OPENID) {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    c.set('identity', { userId: openid, orgId: ORG, displayName: openid, scopes: [], hasScope: () => true })
    await next()
  })
  registerRegistrationGuest(r, { pool, storage: null })
  return r
}

async function cleanup() {
  await pool.query(`delete from aftersales.employee_approval where org = any($1::text[])`, [[ORG, OTHER_ORG]])
  await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
  await pool.query(`delete from aftersales.store where org = $1`, [ORG])
  await pool.query(`delete from aftersales.product where org = $1`, [ORG])
}

beforeAll(cleanup)
beforeEach(async () => {
  await cleanup()
  // ⚠️ 门店必须建在 cleanup **之后**：写在 beforeAll 里会被第一个 beforeEach 的 cleanup 删掉，
  //    后续用例拿到空的门店 id 列表 ⇒ `storeIds()` 解构出 undefined ⇒ employee_store 的
  //    store_id not-null 报错（而报错点离真因很远）。
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

/** 给「我」建一条已审批的档案（readMySnapshot 只看 approved） */
async function seedMe(storeIdsToLink: number[] = []): Promise<void> {
  const emp = await pool.query<{ id: string }>(
    `insert into aftersales.employee(org, name, phone, open_id, approve_status)
     values ($1, '张三', '138', $2, 'approved') returning id`,
    [ORG, OPENID],
  )
  for (const sid of storeIdsToLink) {
    await pool.query(`insert into aftersales.employee_store(org, employee_id, store_id) values ($1,$2,$3)`, [
      ORG,
      Number(emp.rows[0]!.id),
      sid,
    ])
  }
}

const submit = (a: Hono, body: unknown) =>
  a.request('/guest/employee-approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('GET /guest/me/registration', () => {
  it('未登记 ⇒ registration 为 null、hasPendingApproval 为 false', async () => {
    const res = await app().request('/guest/me/registration')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ registration: null, hasPendingApproval: false })
  })

  it('已登记 ⇒ 回档案 + 我的门店（多门店）', async () => {
    const [s1, s2] = await storeIds()
    await seedMe([s1!, s2!])
    const body = (await (await app().request('/guest/me/registration')).json()) as {
      registration: { name: string; phone: string; storeIds: number[] }
      hasPendingApproval: boolean
    }
    expect(body.registration).toEqual({ name: '张三', phone: '138', storeIds: [s1, s2] })
    expect(body.hasPendingApproval).toBe(false)
  })

  it('★ 只回**自己的**（org + open_id 双向收窄）—— 别人的登记看不见', async () => {
    await pool.query(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status)
       values ($1,'别人','','other-openid','approved')`,
      [ORG],
    )
    const body = (await (await app().request('/guest/me/registration')).json()) as { registration: unknown }
    expect(body.registration).toBeNull()
  })

  it('有待审申请 ⇒ hasPendingApproval 为 true', async () => {
    const [s1] = await storeIds()
    await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })
    const body = (await (await app().request('/guest/me/registration')).json()) as { hasPendingApproval: boolean }
    expect(body.hasPendingApproval).toBe(true)
  })
})

describe('POST /guest/employee-approvals', () => {
  it('首次提交 ⇒ 建 register 申请，old 空、new 是目标值', async () => {
    const [s1] = await storeIds()
    const res = await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })
    expect(res.status).toBe(201)
    const row = (
      await pool.query(
        `select approve_type, status, old_info, new_info from aftersales.employee_approval where org=$1`,
        [ORG],
      )
    ).rows[0] as { approve_type: string; status: string; old_info: unknown; new_info: unknown }
    expect(row.approve_type).toBe('register')
    expect(row.status).toBe('pending')
    expect(row.old_info).toEqual({})
    expect(row.new_info).toEqual({ name: '张三', phone: '138', storeIds: [s1] })
  })

  it('★ 已有待审 ⇒ 409（由**库**的部分唯一索引保证，不是先查后插）', async () => {
    const [s1] = await storeIds()
    expect((await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })).status).toBe(201)
    const second = await submit(app(), { name: '张三', phone: '139', storeIds: [s1] })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'APPROVAL_PENDING' })
    // 且确实只落了一条
    const n = Number(
      (await pool.query(`select count(*)::int n from aftersales.employee_approval where org=$1`, [ORG])).rows[0]!.n,
    )
    expect(n).toBe(1)
  })

  it('体不合法 ⇒ 400 INVALID_BODY', async () => {
    expect((await submit(app(), { name: '', phone: '138', storeIds: [] })).status).toBe(400)
    expect((await submit(app(), { name: '张三', phone: '138', storeIds: [-1] })).status).toBe(400)
    // 超大整数：bigint 列一律 .safe()（M2a I-1 的教训）
    expect((await submit(app(), { name: '张三', phone: '138', storeIds: [1e30] })).status).toBe(400)
  })

  it('★ 变更：old/new 只含变了的字段', async () => {
    const [s1] = await storeIds()
    await seedMe([s1!])
    const res = await submit(app(), { name: '张三', phone: '139', storeIds: [s1] })
    expect(res.status).toBe(201)
    const row = (
      await pool.query(`select approve_type, old_info, new_info from aftersales.employee_approval where org=$1`, [ORG])
    ).rows[0] as { approve_type: string; old_info: unknown; new_info: unknown }
    expect(row.approve_type).toBe('change')
    expect(row.old_info).toEqual({ phone: '138' })
    expect(row.new_info).toEqual({ phone: '139' })
  })

  it('★ 变更但什么都没改 ⇒ 400 且 message 是「没有修改」', async () => {
    const [s1] = await storeIds()
    await seedMe([s1!])
    const res = await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message?: string }).message).toContain('没有修改')
  })

  it('★ 防重索引**按 org 分桶**：别的 org 的同名 openid 的 pending 不会挡住我', async () => {
    const [s1] = await storeIds()
    // 先在**别的 org** 放一条同 openid 的 pending —— 若唯一索引漏了 org 列，下面这次提交会撞 409
    await pool.query(
      `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
       values ($1, $2, 'register', '{}'::jsonb)`,
      [OTHER_ORG, OPENID],
    )
    expect((await submit(app(), { name: '张三', phone: '138', storeIds: [s1] })).status).toBe(201)
  })
})

describe('GET /guest/products', () => {
  it('搜索 + 分页；只回本 org 的', async () => {
    await pool.query(
      `insert into aftersales.product(org, name, basic_quantity, basic_unit_price_minor)
       values ($1,'苹果',1,100),($1,'香蕉',1,200),($2,'别人的',1,300)`,
      [ORG, OTHER_ORG],
    )
    const body = (await (await app().request('/guest/products?page=1&size=20&q=苹')).json()) as {
      items: Array<{ name: string }>
      total: number
    }
    expect(body.items.map((i) => i.name)).toEqual(['苹果'])
    expect(body.total).toBe(1)
  })
})

// ── GET /guest/stores（M3b-2 增补；spec §3.2）───────────────────────────────
describe('GET /guest/stores', () => {
  it('无参数：回本 org 的门店，形状是 camelCase 的 StoreItem', async () => {
    const res = await app().request('/guest/stores')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['店A', '店B'])
    // 形状与 console 共用一份类型（api-types.ts）——field 名错了 console 侧也会错
    expect(Object.keys(body.items[0]).sort()).toEqual(['address', 'id', 'name', 'phone', 'regionId'])
  })

  it('q：按名称模糊搜索（ILIKE），且 % 被转义（不是通配全表）', async () => {
    const hit = await (await app().request('/guest/stores?q=店A')).json()
    expect(hit.items.map((s: { name: string }) => s.name)).toEqual(['店A'])
    // `%` 不转义就是「匹配所有」——这正是 escapeLike 存在的理由
    const all = await (await app().request('/guest/stores?q=%25')).json()
    expect(all.items).toEqual([])
  })

  it('ids：只回指定的那几个（提交页「我的门店」走这条）', async () => {
    const ids = await storeIds()
    const res = await app().request(`/guest/stores?ids=${ids[1]}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((s: { id: number }) => s.id)).toEqual([ids[1]])
  })

  it('ids= 空串：合法的空集（不是「不过滤」）——否则会把全量门店回给访客', async () => {
    const res = await app().request('/guest/stores?ids=')
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })

  it('ids 含非法段：400 INVALID_IDS（不静默丢坏值）', async () => {
    for (const bad of ['1,abc', '1,-2', '1,1.5', '1,1e3']) {
      const res = await app().request(`/guest/stores?ids=${encodeURIComponent(bad)}`)
      expect(res.status, `ids=${bad}`).toBe(400)
      expect((await res.json()).error).toBe('INVALID_IDS')
    }
  })

  it('租户隔离：别的 org 的门店看不见', async () => {
    await pool.query(`insert into aftersales.store(org, name, address, phone) values ($1,'别家店','','')`, [OTHER_ORG])
    const body = await (await app().request('/guest/stores')).json()
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['店A', '店B'])
  })

  it('分页：非法 size 回落默认值、超上界夹住（与 /guest/products 同一口径）', async () => {
    const body = await (await app().request('/guest/stores?page=1&size=99999')).json()
    expect(body.size).toBe(100) // MAX_PAGE_SIZE，不是 99999
  })
})
