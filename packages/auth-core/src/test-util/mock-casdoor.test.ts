// mock 的 owner= 隔离是「门禁对 multi 权限失明」的根因（issue #3 第二节成因①）：
// mock 自陈"单 org、忽略 owner=" ⇒ 真实的写读分叉在冒烟里看不见。
// 测试替身自己的语义也要有测试——否则它给出的"全绿"没有任何证据价值。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from './mock-casdoor'

let m: MockCasdoor
beforeAll(async () => {
  m = new MockCasdoor({
    // owner 是真机语义的一部分：get-user?id=<org>/<name> 只命中属于该 org 的用户
    // （真机实测 shanhai/admin ⇒ ok+null，尽管 built-in/admin 存在）。不标 owner 的
    // 种子落进 MOCK_ORG，`id=acme/admin1` 就不该命中——那正是下面那条负例要钉的。
    users: [{ name: 'admin1', password: 'pw', owner: 'acme' }],
    perms: [{ owner: 'acme', name: 'demo:view', users: ['admin1'], resources: ['demo:view'] }],
  })
  await m.start()
})
afterAll(async () => { await m.stop() })

/** 原生 admin 登录拿会话 cookie（管理端点门禁；凭据走 JSON body） */
async function adminCookie(): Promise<string> {
  const r = await fetch(`${m.origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'pw' }),
  })
  const hit = /casdoor_session_id=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')
  return hit ? `casdoor_session_id=${hit[1]}` : ''
}

/** 读权限列表；owner 省略 = 不带形参（用于钉「缺失 owner 必须报错」） */
async function getPerms(owner?: string): Promise<Record<string, unknown>> {
  const qs = owner === undefined ? '' : `?owner=${encodeURIComponent(owner)}`
  const r = await fetch(`${m.origin}/api/get-permissions${qs}`, {
    headers: { Cookie: await adminCookie() },
  })
  return (await r.json()) as Record<string, unknown>
}

/** 建码（add-permission） */
async function addPerm(owner: string, name: string, users: string[] = []): Promise<Record<string, unknown>> {
  const r = await fetch(`${m.origin}/api/add-permission`, {
    method: 'POST',
    headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, name, displayName: name, resources: [name], users }),
  })
  return (await r.json()) as Record<string, unknown>
}

describe('MockCasdoor：权限按 org 分桶（owner= 生效）', () => {
  it('★ 负例：owner=beta 不回 acme 桶的权限码', async () => {
    const j = await getPerms('beta')
    expect(j.status).toBe('ok')
    expect(j.data).toEqual([])
  })

  it('owner=acme 回 acme 桶', async () => {
    const j = await getPerms('acme')
    expect((j.data as Array<{ name: string }>).map((p) => p.name)).toEqual(['demo:view'])
  })

  it('owner 缺失 → status error（绝不"忽略形参回全部"——那正是失明的形状）', async () => {
    const j = await getPerms()
    expect(j.status).toBe('error')
    expect(String(j.msg)).toMatch(/owner/)
  })

  it('add-permission 按 body.owner 归桶，并记入调用记录', async () => {
    expect((await addPerm('beta', 'demo:note')).status).toBe('ok')
    expect(m.permissionsIn('beta').map((p) => p.name)).toEqual(['demo:note'])
    expect(m.permissionsIn('acme').map((p) => p.name)).toEqual(['demo:view'])
    expect(m.addPermissionCalls).toEqual([{ owner: 'beta', name: 'demo:note' }])
  })

  it('add-permission 缺 owner → status error', async () => {
    const r = await fetch(`${m.origin}/api/add-permission`, {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-owner', resources: ['no-owner'] }),
    })
    const j = (await r.json()) as Record<string, unknown>
    expect(j.status).toBe('error')
    expect(String(j.msg)).toMatch(/owner/)
  })

  it('★ 负例：未知用户 ⇒ ok + data:null（真机形状；旧 mock 回 status:error 与真机不符）', async () => {
    const j = await (await fetch(`${m.origin}/api/get-user?id=acme/nobody`, {
      headers: { Cookie: await adminCookie() },
    })).json() as { status: string; data: unknown }
    expect(j.status).toBe('ok')
    expect(j.data).toBeNull()
  })

  // ---- S3：org 段被真机采信，被旧 mock 忽略 ----
  //
  // 真机实测（sso.hookflow.cn）：`get-user?id=shanhai/admin` ⇒ 200 {status:'ok',data:null}，
  // 尽管 `built-in/admin` 明明存在 ⇒ **org 段是命中条件的一部分**。旧 mock 只按 name 命中，
  // 于是"跨 org 同名用户被误命中"这类缺陷在门禁里结构性看不见。

  it('★ 负例：get-user 按 (org,name) 命中 —— 别的 org 下的同名用户不命中', async () => {
    const j = await (await fetch(`${m.origin}/api/get-user?id=beta/admin1`, {
      headers: { Cookie: await adminCookie() },
    })).json() as { status: string; data: unknown }
    expect(j.status).toBe('ok')
    expect(j.data).toBeNull() // admin1 属于 acme，不属于 beta
  })

  it('本 org 下的同名用户照常命中（org 段是收紧命中，不是把命中关掉）', async () => {
    const j = await (await fetch(`${m.origin}/api/get-user?id=acme/admin1`, {
      headers: { Cookie: await adminCookie() },
    })).json() as { status: string; data: { name: string; owner: string } | null }
    expect(j.status).toBe('ok')
    expect(j.data?.name).toBe('admin1')
    expect(j.data?.owner).toBe('acme')
  })

  // ---- 评审 S1：真机**先查用户、后判会话** ----
  //
  // 真机实测（sso.hookflow.cn，无凭据 / bogus cookie）：
  //   `id=built-in/admin`（用户存在）                              → 200 {status:'error',msg:'Please login first'}
  //   `id=built-in/nosuchuser`／`id=shanhai/*`／`id=woke/*`／`id=customerb/*`（查无此人）
  //                                                                → 200 {status:'ok',data:null}
  // ⇒ 命中判定排在会话门禁**之前**：查无此人根本走不到会话检查那一步。
  // 旧 mock 先判会话 ⇒ "admin 会话死掉 + 用户已删"这个组合（真机：清 cookie 后照回 ok+null）
  // 在门禁里只降级、看不出与真机的分歧。

  it('★ 负例：会话已失效 + 用户不存在 ⇒ ok+null（真机先查用户、后判会话）', async () => {
    const r = await fetch(`${m.origin}/api/get-user?id=acme/nosuchuser`, {
      headers: { Cookie: 'casdoor_session_id=deadbeef' }, // 会话已死
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { status: string; data: unknown }
    expect(j.status).toBe('ok') // ← 先判会话的旧序在这里回 error，本行必红
    expect(j.data).toBeNull()
  })

  it('会话已失效 + 用户存在 ⇒ status:error（会话门仍在：查得到用户才拦）', async () => {
    const r = await fetch(`${m.origin}/api/get-user?id=acme/admin1`, {
      headers: { Cookie: 'casdoor_session_id=deadbeef' },
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { status: string }).status).toBe('error')
  })

  // ---- 评审 must-fix 2：默认的"会话失效"形状必须与真机一致（HTTP 200，不是 401） ----
  //
  // 真机实测（本机 curl，无凭据）：get-user / get-permissions 一律 **HTTP 200** +
  // {status:'error',...}，没有一条 401。旧 mock 的 #unauthorized 回 401 ⇒ 客户端
  // "#adminRequest 的 401 重试"在门禁里看着是活的、在真机上却是死码。

  it('★ 负例：默认会话失效形状 = HTTP 200 + status:error（真机从不回 401）', async () => {
    const r = await fetch(`${m.origin}/api/get-permissions?owner=acme`, {
      headers: { Cookie: 'casdoor_session_id=deadbeef' },
    })
    expect(r.status).toBe(200) // ← 锁住旧 mock 的 401 会让本行红
    expect(((await r.json()) as { status: string }).status).toBe('error')
  })

  // R4 Task 4 Step 3：真机未授权文案**按端点区分**——get-user 回 'Please login first'，
  // get-permissions 等回 'Unauthorized operation'。mock 旧实现两处共用一句，与真机不一致
  //（客户端不按文案分支，这里纯为保真；R3 终审建议改）。
  it('★ 负例：未授权文案按端点区分（get-user ⇒ Please login first；get-permissions ⇒ Unauthorized operation）', async () => {
    const dead = { Cookie: 'casdoor_session_id=deadbeef' }
    const u = await fetch(`${m.origin}/api/get-user?id=acme/admin1`, { headers: dead })
    expect(((await u.json()) as { msg?: string }).msg).toBe('Please login first')
    const p = await fetch(`${m.origin}/api/get-permissions?owner=acme`, { headers: dead })
    expect(((await p.json()) as { msg?: string }).msg).toBe('Unauthorized operation')
  })

  it('显式注入 HTTP 401：那是真机不产生的形状，只能显式注入来钉客户端的防御契约', async () => {
    m.setHttpFault('unauthorized401')
    try {
      const r = await fetch(`${m.origin}/api/get-permissions?owner=acme`, {
        headers: { Cookie: 'casdoor_session_id=deadbeef' },
      })
      expect(r.status).toBe(401)
    } finally {
      m.setHttpFault('off')
    }
  })

  it('update-permission 按 (owner,name) 定位：跨 org 同名互不影响', async () => {
    expect((await addPerm('acme', 'shared:code')).status).toBe('ok')
    expect((await addPerm('gamma', 'shared:code')).status).toBe('ok')

    const upd = await fetch(
      `${m.origin}/api/update-permission?id=${encodeURIComponent('gamma/shared:code')}`,
      {
        method: 'POST',
        headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: ['admin1'] }),
      },
    )
    expect(((await upd.json()) as Record<string, unknown>).status).toBe('ok')

    expect(m.permissionsIn('gamma').find((p) => p.name === 'shared:code')?.users).toEqual(['admin1'])
    expect(m.permissionsIn('acme').find((p) => p.name === 'shared:code')?.users).toEqual([])
  })
})

// ---- R4 Task 4 Step 1：get-user 的 id 段数校验对齐真机 ----
//
// R3 终审 + R4 评审真机实测（sso.hookflow.cn）：`id=/admin`、`id=built-in/`、`id=/` 全回
// 200 {status:'ok',data:null}——两段（哪怕含空段）一律进查找，查不到就 ok+null；
// **空 id 同样是 ok+null**（R4 评审探针：`?id=`、完全不带 id 形参、裸 `?id=` 三态都回
// 200 ok+null ⇒ 真机把"空 id"当**查不到人**，不是在形参校验那步报错）；
// 只有**段数≠2**（`noSlashId`、`built-in/admin/extra`）才回 wrong token count
// （上游 `GetOwnerAndNameFromId` 就是 `strings.Split(id,"/")` 后判 len!=2）。
// 旧 mock 的 `!parts[0] || !parts[1]` 把含空段的两段也判非法 ⇒ 方向与真机相反；
// 而"空 id 走 split 后 length!==2 ⇒ 报错"这一步**旧实现本来就是这个方向**，只是恰好也是错的
// ——修 Step 1 时若只动 `!parts[0] || !parts[1]`，空 id 这一格仍是错方向（R4 评审 must-fix 1）。
describe('MockCasdoor get-user：id 段数校验对齐真机', () => {
  async function getUser(id: string): Promise<{ status: string; msg?: string; data?: unknown }> {
    const r = await fetch(`${m.origin}/api/get-user?id=${encodeURIComponent(id)}`, {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    return (await r.json()) as { status: string; msg?: string; data?: unknown }
  }

  it('★ 负例：含空段的两段 id 不再判非法（/admin ⇒ ok+null，不是 wrong token count）', async () => {
    const j = await getUser('/admin')
    expect(j.status).toBe('ok') // ← 旧 mock 在此回 error，本行必红
    expect(j.data).toBeNull()
  })

  it('两段含空段一律进查找：built-in/ 与 / 同样 ok+null', async () => {
    expect((await getUser('built-in/')).status).toBe('ok')
    expect((await getUser('built-in/')).data).toBeNull()
    expect((await getUser('/')).status).toBe('ok')
    expect((await getUser('/')).data).toBeNull()
  })

  it('段数≠2 仍报 wrong token count（built-in/admin/extra）——归一不得变成"放行一切"', async () => {
    const j = await getUser('built-in/admin/extra')
    expect(j.status).toBe('error')
    expect(String(j.msg)).toMatch(/wrong token count/)
  })

  it('★ 负例：空 id ⇒ ok+null（**不是** wrong token count）——真机把"空 id"当查不到人', async () => {
    // R4 评审真机探针（sso.hookflow.cn）：
    //   curl -sS -G …/api/get-user --data-urlencode "id="      ⇒ {"status":"ok",…,"data":null}
    //   curl -sS -G …/api/get-user                            ⇒ 同 200 ok+null
    //   curl -sS -G …/api/get-user --data-urlencode "id=" (裸 ?id=) ⇒ 同 200 ok+null
    // 旧断言（本用例的前身）声称"真机空串只 split 出 1 段 ⇒ 报 wrong token count"——**该陈述
    // 经探针证伪**：方向与真机相反，且它会让正解变红，把分歧焊死进闸门（R3 must-fix 2 的
    // "替身锁住旧形状"同族）。翻它是 must-fix 1 的**要求**，不是为了让测试变绿。
    const j = await getUser('')
    expect(j.status).toBe('ok')
    expect(j.data).toBeNull()
  })

  it('裸 query 通道（完全不带 id 形参）同样 ok+null——空 id 与"没传 id"在真机不可区分', async () => {
    const r = await fetch(`${m.origin}/api/get-user`, { headers: { Cookie: await adminCookie() } })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { status: string; data?: unknown }
    expect(j.status).toBe('ok')
    expect(j.data).toBeNull()
  })
})

// ── #117：org/application 域（真机形状复刻——add-organization 缺 owner 的畸形 org、
//    GetOrganization 按 (owner,name) 单查失明、add-user 的两个 org 前置）──
// 状态有增删，逐用例独立起 mock（不复用顶部的共享实例）。
describe('MockCasdoor org/application 域（#117）', () => {
  const cookieOf = async (mock: MockCasdoor): Promise<string> => {
    const r = await fetch(`${mock.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw' }),
    })
    const hit = /casdoor_session_id=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')
    return hit ? `casdoor_session_id=${hit[1]}` : ''
  }
  const post = async (mock: MockCasdoor, path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (await fetch(`${mock.origin}/api/${path}`, {
      method: 'POST',
      headers: { Cookie: await cookieOf(mock), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).json()) as Record<string, unknown>
  const get = async (mock: MockCasdoor, path: string): Promise<Record<string, unknown>> =>
    (await (await fetch(`${mock.origin}/api/${path}`, { headers: { Cookie: await cookieOf(mock) } }))
      .json()) as Record<string, unknown>

  it('★ 负例：add-organization 缺 owner ⇒ 建出 owner="" 的畸形 org——列表可见、单查失明（真机陷阱复刻）', async () => {
    const m = new MockCasdoor({ users: [] })
    await m.start()
    try {
      const j = await post(m, 'add-organization', { name: 'broken', displayName: 'broken', isEnabled: true })
      expect(j.status).toBe('ok') // 真机不报错——畸形是静默的，这正是陷阱
      const list = (await get(m, 'get-organizations')) as { data: Array<{ owner: string; name: string }> }
      expect(list.data.map((g) => g.name)).toContain('broken') // 列表可见
      const single = (await get(m, `get-organization?id=${encodeURIComponent('admin/broken')}`)) as { status: string; data: unknown }
      expect(single.status).toBe('ok')
      expect(single.data).toBeNull() // 单查失明（GetOrganization 按 (admin,name) 查）
    } finally {
      await m.stop()
    }
  })

  it('add-organization 带 owner/passwordType ⇒ 单查命中且字段落库；同名拒绝', async () => {
    const m = new MockCasdoor({ users: [] })
    await m.start()
    try {
      await post(m, 'add-organization', { owner: 'admin', name: 'ok-org', passwordType: 'bcrypt', displayName: 'ok-org' })
      const single = (await get(m, `get-organization?id=${encodeURIComponent('admin/ok-org')}`)) as { data: { owner: string; name: string; passwordType: string } }
      expect(single.data).toMatchObject({ owner: 'admin', name: 'ok-org', passwordType: 'bcrypt' })
      const dup = await post(m, 'add-organization', { owner: 'admin', name: 'ok-org' })
      expect(dup.status).toBe('error')
    } finally {
      await m.stop()
    }
  })

  it('★ add-user 的两个 org 前置：org 不存在 / org 零 application ⇒ 200+status:error（真机实测文案族）', async () => {
    const m = new MockCasdoor({ orgs: [{ name: 'neworg', applications: [] }] })
    await m.start()
    try {
      const noOrg = await post(m, 'add-user', { owner: 'nowhere', name: 'u1', type: 'normal-user' })
      expect(noOrg.status).toBe('error')
      const noApp = await post(m, 'add-user', { owner: 'neworg', name: 'u1', type: 'normal-user' })
      expect(noApp.status).toBe('error')
      expect(m.userIn('neworg', 'u1')).toBeUndefined() // 前置不满足 ⇒ 不留半建用户
    } finally {
      await m.stop()
    }
  })

  it('add-application 挂到 org 后 add-user 放行（共享 Casdoor 正典：先建 application 再建用户）', async () => {
    const m = new MockCasdoor({ orgs: [{ name: 'neworg', applications: [] }] })
    await m.start()
    try {
      const j = await post(m, 'add-application', { owner: 'admin', name: 'cust-app', organization: 'neworg' })
      expect(j.status).toBe('ok')
      expect(m.addApplicationCalls).toHaveLength(1)
      const add = await post(m, 'add-user', { owner: 'neworg', name: 'u1', type: 'normal-user', signupApplication: 'cust-app' })
      expect(add.status).toBe('ok')
      expect(m.userIn('neworg', 'u1')).toMatchObject({ signupApplication: 'cust-app' })
    } finally {
      await m.stop()
    }
  })

  it('种子用户/权限出现过的 org 自动补录成正常形状（含 application）——built-in 恒在', async () => {
    const m = new MockCasdoor({ users: [{ name: 'a', password: 'p', owner: 'acme' }] })
    await m.start()
    try {
      expect(m.organizationIn('admin', 'acme')).toMatchObject({ owner: 'admin', passwordType: 'bcrypt', applications: ['app-built-in'] })
      expect(m.organizationIn('admin', 'built-in')).toMatchObject({ applications: ['app-built-in'] })
      const add = await post(m, 'add-user', { owner: 'acme', name: 'late', type: 'normal-user' })
      expect(add.status).toBe('ok')
    } finally {
      await m.stop()
    }
  })
})
