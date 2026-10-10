// routes/registration-guest.test.ts — 访客面登记端点（真 PG，与既有 routes/*.test.ts 同栈）
import { Hono } from 'hono'
import { Pool } from 'pg'
import type { Identity, IdentityLinkView, IdentityLinks } from '@platform/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, ensureDimTables } from '../test-util'
import { registerRegistrationGuest } from './registration-guest'

const ORG = 'test-m3b1-guest'
const OTHER_ORG = 'test-m3b1-other'
const OPENID = 'openid-guest-1'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

function app(openid = OPENID, identityLinks?: IdentityLinks, boundExternalIds?: string[]) {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    c.set('identity', {
      userId: openid, orgId: ORG, displayName: openid, scopes: [], hasScope: () => true, boundExternalIds,
    })
    await next()
  })
  registerRegistrationGuest(r, { pool, identityLinks })
  return r
}

/** IdentityLinks 全方法替身（#11：替身形状收严到 SDK 接口本身）；Task 9 起也用到
 *  describeOwn / dispute，按用例经 `over` 覆写对应方法。 */
function identityLinksStub(
  match: IdentityLinks['matchOnApplication'],
  over: Partial<IdentityLinks> = {},
): IdentityLinks {
  return {
    matchOnApplication: match,
    describeOwn: async () => null,
    listForOrg: async () => [],
    confirm: async () => {},
    rebind: async () => {},
    revoke: async () => {},
    dispute: async () => false,
    ...over,
  }
}

/** 两个 org 都要清：租户隔离用例会往 OTHER_ORG 插行，只清 ORG 会让残留跨轮累积。 */
const ORGS = [ORG, OTHER_ORG]

async function cleanup() {
  await pool.query(`delete from aftersales.employee_approval where org = any($1::text[])`, [ORGS])
  await pool.query(`delete from aftersales.employee_store where org = any($1::text[])`, [ORGS])
  await pool.query(`delete from aftersales.employee where org = any($1::text[])`, [ORGS])
  // #476：门店/商品清单的消费源 = `data.dim_*`（发布快照）——夹具种它、清理清它（org 键隔离）
  await pool.query(`delete from data.dim_branch where org = any($1::text[])`, [ORGS])
  await pool.query(`delete from data.dim_item where org = any($1::text[])`, [ORGS])
}

// 自带迁移（评审 N3）：本文件必须**自足**，不能依赖别的包先迁完 aftersales schema。
// `pnpm -r` 的包间执行顺序不保证 —— 靠 apps/server「顺带」迁移就是「本地红、CI 绿」的时序红
// （#84 里那 3 个 `relation "aftersales.employee_approval" does not exist` 正是这么来的）。
// 放在 cleanup **之前**：cleanup 自己就查 aftersales.* 的表，表还不存在它先挂。
beforeAll(async () => {
  await applyMigrations(pool)
  await ensureDimTables(pool)
  await cleanup()
})
beforeEach(async () => {
  await cleanup()
  // ⚠️ 门店必须建在 cleanup **之后**：写在 beforeAll 里会被第一个 beforeEach 的 cleanup 删掉，
  //    后续用例拿到空的门店列表 ⇒ 提交侧引用不存在的 code ⇒ 校验失败（报错点离真因很远）。
  // #476：夹具 = `data.dim_branch` 发布快照（code 自然键 '101'/'102'，不再是本地 bigint id）。
  await pool.query(
    `insert into data.dim_branch(org, code, name, enable, address, phone, source_book, snapshot)
     values ($1,'101','店A',true,'','','3120',current_date), ($1,'102','店B',true,'','','3120',current_date)`,
    [ORG],
  )
})
afterAll(async () => {
  await cleanup()
  await pool.end()
})

const storeCodes = async (): Promise<string[]> =>
  (await pool.query<{ code: string }>(`select code from data.dim_branch where org=$1 order by code`, [ORG])).rows.map(
    (r) => r.code,
  )

/** 给「我」建一条已审批的档案（readMySnapshot 只看 approved） */
async function seedMe(storeCodesToLink: string[] = []): Promise<void> {
  const emp = await pool.query<{ id: string }>(
    `insert into aftersales.employee(org, name, phone, open_id, approve_status)
     values ($1, '张三', '138', $2, 'approved') returning id`,
    [ORG, OPENID],
  )
  for (const sc of storeCodesToLink) {
    await pool.query(`insert into aftersales.employee_store(org, employee_id, store_code) values ($1,$2,$3)`, [
      ORG,
      Number(emp.rows[0]!.id),
      sc,
    ])
  }
}

// 形参用 `ReturnType<typeof app>`（推导）而不是裸 `Hono`：裸 `Hono` = `Hono<BlankEnv>`，
// 而 `app()` 造的是带 `{ identity }` 变量表的 app —— Hono 的 Env 不变，两者 TS2345
// （issue #68 Step 3 的 10 条）。推导写法还顺带保证「以后 app() 换了 Env，这里跟着走」。
const submit = (a: ReturnType<typeof app>, body: unknown) =>
  a.request('/guest/employee-approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('GET /guest/me/registration', () => {
  it('未登记 ⇒ registration 为 null、hasPendingApproval 为 false、identity 为 null', async () => {
    const res = await app().request('/guest/me/registration')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ registration: null, hasPendingApproval: false, identity: null })
  })

  it('已登记 ⇒ 回档案 + 我的门店（多门店）', async () => {
    const [c1, c2] = await storeCodes()
    await seedMe([c1!, c2!])
    const body = (await (await app().request('/guest/me/registration')).json()) as {
      registration: { name: string; phone: string; storeCodes: string[] }
      hasPendingApproval: boolean
    }
    expect(body.registration).toEqual({ name: '张三', phone: '138', storeCodes: [c1, c2] })
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
    const [c1] = await storeCodes()
    await submit(app(), { name: '张三', phone: '138', storeCodes: [c1] })
    const body = (await (await app().request('/guest/me/registration')).json()) as { hasPendingApproval: boolean }
    expect(body.hasPendingApproval).toBe(true)
  })
})

describe('POST /guest/employee-approvals', () => {
  it('首次提交 ⇒ 建 register 申请，old 空、new 是目标值', async () => {
    const [c1] = await storeCodes()
    const res = await submit(app(), { name: '张三', phone: '138', storeCodes: [c1] })
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
    expect(row.new_info).toEqual({ name: '张三', phone: '138', storeCodes: [c1] })
  })

  it('★ 已有待审 ⇒ 409（由**库**的部分唯一索引保证，不是先查后插）', async () => {
    const [c1] = await storeCodes()
    expect((await submit(app(), { name: '张三', phone: '138', storeCodes: [c1] })).status).toBe(201)
    const second = await submit(app(), { name: '张三', phone: '139', storeCodes: [c1] })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: 'APPROVAL_PENDING' })
    // 且确实只落了一条
    const n = Number(
      (await pool.query(`select count(*)::int n from aftersales.employee_approval where org=$1`, [ORG])).rows[0]!.n,
    )
    expect(n).toBe(1)
  })

  it('体不合法 ⇒ 400 INVALID_BODY', async () => {
    expect((await submit(app(), { name: '', phone: '138', storeCodes: [] })).status).toBe(400)
    // 超长 code：dim_branch.code 的发布契约 ≤64 ⇒ zod 拒（#476 后不再有「越界数字」形态）
    expect((await submit(app(), { name: '张三', phone: '138', storeCodes: ['x'.repeat(65)] })).status).toBe(400)
  })

  it('★ 变更：old/new 只含变了的字段', async () => {
    const [c1] = await storeCodes()
    await seedMe([c1!])
    const res = await submit(app(), { name: '张三', phone: '139', storeCodes: [c1] })
    expect(res.status).toBe(201)
    const row = (
      await pool.query(`select approve_type, old_info, new_info from aftersales.employee_approval where org=$1`, [ORG])
    ).rows[0] as { approve_type: string; old_info: unknown; new_info: unknown }
    expect(row.approve_type).toBe('change')
    expect(row.old_info).toEqual({ phone: '138' })
    expect(row.new_info).toEqual({ phone: '139' })
  })

  it('★ 变更但什么都没改 ⇒ 400 且 message 是「没有修改」', async () => {
    const [c1] = await storeCodes()
    await seedMe([c1!])
    const res = await submit(app(), { name: '张三', phone: '138', storeCodes: [c1] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message?: string }).message).toContain('没有修改')
  })

  it('★ 防重索引**按 org 分桶**：别的 org 的同名 openid 的 pending 不会挡住我', async () => {
    const [c1] = await storeCodes()
    // 先在**别的 org** 放一条同 openid 的 pending —— 若唯一索引漏了 org 列，下面这次提交会撞 409
    await pool.query(
      `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
       values ($1, $2, 'register', '{}'::jsonb)`,
      [OTHER_ORG, OPENID],
    )
    expect((await submit(app(), { name: '张三', phone: '138', storeCodes: [c1] })).status).toBe(201)
  })

  // ── Task 7：申请提交即触发 identityLinks.matchOnApplication（账户统一 §2）──────
  it('★ 提交申请后调 matchOnApplication：org/provider/externalId/phone 原样透传、approvalId 带回插入的 id', async () => {
    const [c1] = await storeCodes()
    const calls: Parameters<IdentityLinks['matchOnApplication']>[0][] = []
    const links = identityLinksStub(async (input) => {
      calls.push(input)
      return { state: 'draft' }
    })
    const res = await submit(app(OPENID, links), { name: '张三', phone: '13800138000', storeCodes: [c1] })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    expect(calls).toHaveLength(1) // 钩子真的被调了，不是 201 蒙混
    expect(calls[0]).toEqual({
      org: ORG,
      provider: 'wechat-oa',
      externalId: OPENID,
      phone: '13800138000',
      approvalId: id,
    })
    // approvalId 指向**库里刚插入的那条**申请，不只是响应自说自话
    const row = (
      await pool.query(`select id::int as id from aftersales.employee_approval where org=$1`, [ORG])
    ).rows[0] as { id: number }
    expect(row.id).toBe(id)
  })

  it('identityLinks 缺省（undefined）⇒ 照旧 201，不抛（向后兼容旧宿主/单测）', async () => {
    const [c1] = await storeCodes()
    const res = await submit(app(), { name: '张三', phone: '138', storeCodes: [c1] })
    expect(res.status).toBe(201)
  })

  it('★ matchOnApplication 抛错 ⇒ 500 且申请已落库（匹配失败不回滚申请）', async () => {
    const [c1] = await storeCodes()
    const links = identityLinksStub(async () => {
      throw new Error('match exploded')
    })
    const res = await submit(app(OPENID, links), { name: '张三', phone: '138', storeCodes: [c1] })
    expect(res.status).toBe(500)
    // 申请仍在：管理员可从 pending 队列补绑——这是「500 裸露」取舍的立论（不回滚）
    const n = Number(
      (await pool.query(`select count(*)::int n from aftersales.employee_approval where org=$1`, [ORG])).rows[0]!.n,
    )
    expect(n).toBe(1)
  })
})

describe('GET /guest/products', () => {
  it('搜索 + 分页；只回本 org 的', async () => {
    await pool.query(
      `insert into data.dim_item(org, item_code, name, unit_name, source_book, snapshot)
       values ($1,'3001','苹果','箱','3120',current_date),($1,'3002','香蕉','kg','3120',current_date),
              ($2,'9001','别人的','个','3120',current_date)`,
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
  it('无参数：回本 org 的门店，形状是 camelCase 的 StoreItem（#476：code/enable，无 id）', async () => {
    const res = await app().request('/guest/stores')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['店A', '店B'])
    // 形状与 console 共用一份类型（api-types.ts）——field 名错了 console 侧也会错
    expect(Object.keys(body.items[0]).sort()).toEqual(['address', 'code', 'enable', 'name', 'phone'])
  })

  it('q：按名称模糊搜索（ILIKE），且 % 被转义（不是通配全表）', async () => {
    const hit = await (await app().request('/guest/stores?q=店A')).json()
    expect(hit.items.map((s: { name: string }) => s.name)).toEqual(['店A'])
    // `%` 不转义就是「匹配所有」——这正是 escapeLike 存在的理由
    const all = await (await app().request('/guest/stores?q=%25')).json()
    expect(all.items).toEqual([])
  })

  it('codes：只回指定的那几个（提交页「我的门店」走这条）', async () => {
    const codes = await storeCodes()
    const res = await app().request(`/guest/stores?codes=${codes[1]}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((s: { code: string }) => s.code)).toEqual([codes[1]])
  })

  it('codes= 空串：合法的空集（不是「不过滤」）——否则会把全量门店回给访客', async () => {
    const res = await app().request('/guest/stores?codes=')
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })

  it('codes 含非法段：400 INVALID_CODES（不静默丢坏值）', async () => {
    for (const bad of ['101,x;drop', '101,超长' + 'x'.repeat(80)]) {
      const res = await app().request(`/guest/stores?codes=${encodeURIComponent(bad)}`)
      expect(res.status, `codes=${bad.slice(0, 20)}…`).toBe(400)
      expect((await res.json()).error).toBe('INVALID_CODES')
    }
  })

  it('租户隔离：别的 org 的门店看不见', async () => {
    await pool.query(
      `insert into data.dim_branch(org, code, name, source_book, snapshot) values ($1,'999','别家店','3120',current_date)`,
      [OTHER_ORG],
    )
    const body = await (await app().request('/guest/stores')).json()
    expect(body.items.map((s: { name: string }) => s.name)).toEqual(['店A', '店B'])
  })

  it('分页：非法 size 回落默认值、超上界夹住（与 /guest/products 同一口径）', async () => {
    const body = await (await app().request('/guest/stores?page=1&size=99999')).json()
    expect(body.size).toBe(100) // MAX_PAGE_SIZE，不是 99999
  })
})

// ── 账户统一 Task 10：多绑读侧收窄（registration 面） ──
// 正式态会话带 boundExternalIds（SDK Identity §4.3）：读侧（档案快照 / pending 检查）
// 按「∈ 绑定集合」收窄；写侧（employee_approval.open_id 落值）仍 = identity.userId——红线。
describe('账户统一 Task 10：多绑读侧收窄', () => {
  const OTHER_OPENID = 'openid-guest-2' // 集合内的另一个渠道 openid
  const STRANGER = 'openid-guest-stranger' // 集合外
  /** 多绑会话：登录 openid-guest-1，绑定集合 = [guest-1, guest-2] */
  const multiApp = () => app(OPENID, undefined, [OPENID, OTHER_OPENID])

  it('【多绑】GET /guest/me/registration：集合内 openid 的已审批档案可见', async () => {
    // 档案挂在集合内的另一个渠道 openid 上（在 guest-2 渠道登记过）
    await pool.query(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status)
       values ($1, '李四', '139', $2, 'approved')`,
      [ORG, OTHER_OPENID],
    )
    const body = (await (await multiApp().request('/guest/me/registration')).json()) as {
      registration: { name: string } | null
    }
    expect(body.registration).not.toBeNull()
    expect(body.registration!.name).toBe('李四')
  })

  it('【多绑·对照】集合外 openid 的档案仍不可见（多绑 ≠ 全租户可见）', async () => {
    await pool.query(
      `insert into aftersales.employee(org, name, phone, open_id, approve_status)
       values ($1, '路人', '140', $2, 'approved')`,
      [ORG, STRANGER],
    )
    const body = (await (await multiApp().request('/guest/me/registration')).json()) as {
      registration: unknown
    }
    expect(body.registration).toBeNull()
  })

  it('【多绑】hasPendingApproval：集合内 openid 的待审申请可见（防同一人从别的渠道重复申请）', async () => {
    // 待审申请挂在 guest-2 渠道（中间态时提交的），现在以多绑会话查得到
    await pool.query(
      `insert into aftersales.employee_approval(org, open_id, approve_type, new_info)
       values ($1, $2, 'register', $3::jsonb)`,
      [ORG, OTHER_OPENID, JSON.stringify({ name: '李四', phone: '139', storeCodes: [] })],
    )
    const body = (await (await multiApp().request('/guest/me/registration')).json()) as {
      hasPendingApproval: boolean
    }
    expect(body.hasPendingApproval).toBe(true)
  })

  it('【多绑·红线】写路径不变：提交申请 ⇒ employee_approval.open_id 仍落 identity.userId（登录 openid）', async () => {
    const [c1] = await storeCodes()
    const res = await submit(multiApp(), { name: '张三', phone: '138', storeCodes: [c1] })
    expect(res.status).toBe(201)
    const rows = await pool.query<{ open_id: string }>(
      `select open_id from aftersales.employee_approval where org = $1`,
      [ORG],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].open_id).toBe(OPENID)
  })
})

// ── 账户统一 Task 9：绑定身份可见与异议（设计稿 §2「userApp 内展示当前绑定身份 + 异议入口」）──
describe('账户统一 Task 9：绑定身份可见与异议', () => {
  /** IdentityLinkView 夹具：phoneMasked 用真掩码形状（前3后2，全局约束「不打印完整手机号」） */
  const linkView = (over: Partial<IdentityLinkView> = {}): IdentityLinkView => ({
    id: 1,
    provider: 'wechat-oa',
    externalId: OPENID,
    casdoorName: 'casdoor-acct-1',
    status: 'active',
    phoneMasked: '138****00',
    boundVia: 'auto',
    createdAt: '2026-10-10T00:00:00.000Z',
    ...over,
  })

  const getRegistration = async (a: ReturnType<typeof app>) =>
    (await (await a.request('/guest/me/registration')).json()) as { identity: unknown }

  it('★ active 绑定 ⇒ identity.bound=true、status/boundVia 透传、accountMasked=服务端掩码', async () => {
    const links = identityLinksStub(async () => ({ state: 'draft' }), {
      describeOwn: async () => linkView({ boundVia: 'auto' }),
    })
    const body = await getRegistration(app(OPENID, links))
    expect(body.identity).toEqual({
      bound: true,
      status: 'active',
      boundVia: 'auto',
      accountMasked: '138****00',
    })
  })

  it('★ disputed 行 ⇒ bound=false、boundVia 收 null（绑定已不在效，「怎么绑的」不再有意义）', async () => {
    const links = identityLinksStub(async () => ({ state: 'draft' }), {
      describeOwn: async () => linkView({ status: 'disputed', boundVia: 'manual' }),
    })
    const body = await getRegistration(app(OPENID, links))
    expect(body.identity).toEqual({
      bound: false,
      status: 'disputed',
      boundVia: null,
      accountMasked: '138****00',
    })
  })

  it('pending/revoked 行不外露 ⇒ identity 为 null（响应声明的 status 只有 active|disputed 两态）', async () => {
    for (const status of ['pending', 'revoked'] as const) {
      const links = identityLinksStub(async () => ({ state: 'draft' }), {
        describeOwn: async () => linkView({ status }),
      })
      const body = await getRegistration(app(OPENID, links))
      expect(body.identity, `status=${status}`).toBeNull()
    }
  })

  it('服务在但查无绑定 ⇒ identity 为 null', async () => {
    const body = await getRegistration(app(OPENID, identityLinksStub(async () => ({ state: 'draft' }))))
    expect(body.identity).toBeNull()
  })

  it('★ 服务缺省（undefined）⇒ identity 为 null（旧宿主/单测兼容，同 matchOnApplication 容缺省口径）', async () => {
    const body = await getRegistration(app())
    expect(body.identity).toBeNull()
  })

  it('★ POST /guest/me/identity/dispute 生效 ⇒ 200 {disputed:true}，org/登录 openid 透传给服务', async () => {
    const calls: Array<Parameters<IdentityLinks['dispute']>> = []
    const links = identityLinksStub(async () => ({ state: 'draft' }), {
      dispute: async (org, externalId) => {
        calls.push([org, externalId])
        return true
      },
    })
    const res = await app(OPENID, links).request('/guest/me/identity/dispute', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disputed: true })
    expect(calls).toEqual([[ORG, OPENID]])
  })

  it('无绑定（服务回 false）⇒ 200 {disputed:false}，不是 404——不向外泄露绑定存在性', async () => {
    const links = identityLinksStub(async () => ({ state: 'draft' }), { dispute: async () => false })
    const res = await app(OPENID, links).request('/guest/me/identity/dispute', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disputed: false })
  })

  it('服务缺省 ⇒ 200 {disputed:false}（与 GET 侧 identity:null 同一条容缺省口径）', async () => {
    const res = await app().request('/guest/me/identity/dispute', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disputed: false })
  })
})
