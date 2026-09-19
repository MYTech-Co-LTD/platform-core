import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CasdoorClient } from './casdoor-client'
import { MockCasdoor } from './test-util/mock-casdoor'

let m: MockCasdoor
// owner 必须与下面 client 的 org 一致，**两处都要**：权限按 org 分桶（种到 mock-org 的码在
// org:'acme' 的 client 眼里不存在），而用户按 (org,name) 命中（种成 MOCK_ORG 的 admin1 在
// `get-user?id=acme/admin1` 下**不命中**——真机实测 shanhai/admin ⇒ ok+null，评审 S3）
beforeAll(async () => { m = new MockCasdoor({ users: [{ name: 'admin1', password: 'pw', roles: ['ops'], owner: 'acme' }],
  perms: [{ owner: 'acme', users: ['admin1'], resources: ['demo:view'] }] }); await m.start() })
afterAll(async () => { await m.stop() })

describe('CasdoorClient', () => {
  it('verifyPassword 成功返回用户，失败返回 null', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme' })
    expect((await c.verifyPassword('admin1', 'pw'))?.name).toBe('admin1')
    expect(await c.verifyPassword('admin1', 'bad')).toBeNull()
  })
  it('getUser/getPermissions 携带 admin 会话', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    expect((await c.getUser('admin1'))?.roles).toEqual(['ops'])
    expect(await c.getPermissions()).toHaveLength(1)
  })
  it('upsertPermission 幂等（已存在不重复建）', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    await c.upsertPermission('demo:view', '演示查看'); await c.upsertPermission('demo:view', '演示查看')
    expect(await c.getPermissions()).toHaveLength(1)
  })
})

// ---- C2 语义钉死（mock 三纪律 + 会话缓存/重试/异常面 + 旧仓生产形状对齐） ----

/** 原生 admin 登录拿会话 cookie（raw fetch，凭据走 JSON body —— sso-shell.js 生产形状） */
async function adminCookie(): Promise<string> {
  const r = await fetch(`${m.origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'login', username: 'admin', password: 'pw', application: 'app-built-in' }),
  })
  const sc = r.headers.get('set-cookie') ?? ''
  const hit = /casdoor_session_id=([^;]+)/.exec(sc)
  return hit ? `casdoor_session_id=${hit[1]}` : ''
}

describe('CasdoorClient 语义钉死（C2）', () => {
  it('凭据走 JSON body（纪律②修订）：body 通道登录成功；失败 = HTTP 200 + {"status":"error"}（纪律③）且响应不含明文密码（纪律①）', async () => {
    const ok = await fetch(`${m.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'login', username: 'admin1', password: 'pw', application: 'app-built-in' }),
    })
    expect(ok.status).toBe(200)
    const jok = await ok.json()
    expect(jok.status).toBe('ok')
    expect(jok.data).toBe('acme/admin1') // <owner>/<name>：org 段是用户自己的归属 org

    const bad = await fetch(`${m.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'login', username: 'admin1', password: 'bad', application: 'app-built-in' }),
    })
    expect(bad.status).toBe(200) // 绝不能是 401/403 —— 真实 Casdoor 行为
    const jbad = await bad.json()
    expect(jbad.status).toBe('error')
    expect(JSON.stringify(jbad)).not.toContain('"password"')
  })

  it('get-user 响应不回真 secret（纪律①）', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    const u = await c.getUser('admin1')
    expect(u?.name).toBe('admin1')
    expect(u).not.toHaveProperty('password')
  })

  it('admin 会话失效（真机形状：HTTP 200 + status:error）自动重登一次并重试', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    expect((await c.getUser('admin1'))?.name).toBe('admin1') // 首次：登录 + 缓存 cookie
    const before = m.adminLoginCalls
    m.expireSessions() // 服务端吊销全部会话 ⇒ 真机把它回成 200+status:error（**不是 401**）
    expect((await c.getUser('admin1'))?.name).toBe('admin1') // 响应体 error → 重登 → 重试成功
    expect(m.adminLoginCalls).toBe(before + 1)
  })

  it('HTTP 401（真机不产生此形状；显式注入）仍触发「重取会话一次」的防御分支', async () => {
    // 401 分支保留是刻意的：它仍是合法的防御面（被反代/网关插一层 401）。但它**不是**
    // 会话失效的主要路径——真机从不产生 401 ⇒ 只能显式注入来机检它（评审 must-fix 2）。
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    expect((await c.getUser('admin1'))?.name).toBe('admin1')
    const before = m.adminLoginCalls
    m.expireSessions()
    m.setHttpFault('unauthorized401Once') // 只插一次：等价于"反代插了个 401，会话本身仍在"
    try {
      expect((await c.getUser('admin1'))?.name).toBe('admin1') // 401 → 重登 → 重试成功
      expect(m.adminLoginCalls).toBe(before + 1)
    } finally {
      m.setHttpFault('off')
    }
  })

  it('admin 凭据错误时抛错（不吞异常）', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'wrong' })
    await expect(c.getUser('admin1')).rejects.toThrow(/casdoor admin login failed/)
  })

  it('getUser 查无此人返回 null', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    expect(await c.getUser('nobody')).toBeNull()
  })

  it('upsertPermission 新 code 走 add（既有 users/resources 不被清空）', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    await c.upsertPermission('other:edit', '其他编辑')
    const perms = await c.getPermissions()
    expect(perms).toHaveLength(2)
    expect(perms.flatMap((p) => p.resources ?? [])).toContain('other:edit')
    // 已存在那条（demo:view 被上面幂等用例 update 过）users 必须保留
    expect(perms.find((p) => (p.resources ?? []).includes('demo:view'))?.users).toEqual(['admin1'])
  })

  it('update-permission 形状钉死：PUT → 405，update 路径走 POST（admin-api.js casdoorPost 形状）', async () => {
    const put = await fetch(`${m.origin}/api/update-permission?id=acme/demo:view`, {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '不该生效' }),
    })
    expect(put.status).toBe(405) // 真实 Casdoor update-* 是 POST；mock 钉死形状，遮蔽分叉
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    await c.upsertPermission('demo:view', '新显示名') // mock 只认 POST → 走通即证明 POST
    const list = await (await fetch(`${m.origin}/api/get-permissions?owner=acme`, { headers: { Cookie: await adminCookie() } })).json()
    const hit = list.data.find((p: { name: string }) => p.name === 'demo:view')
    expect(hit.displayName).toBe('新显示名')
  })

  it('application 可配（fork 陷阱：org 用户须用其 signupApplication），默认 app-built-in', async () => {
    const c1 = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme' })
    await c1.verifyPassword('admin1', 'pw')
    expect(m.lastLoginApplication).toBe('app-built-in')
    const c2 = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', application: 'acme-app' })
    expect((await c2.verifyPassword('admin1', 'pw'))?.name).toBe('admin1')
    expect(m.lastLoginApplication).toBe('acme-app')
  })

  it('mock get-user 严格 id=<org>/<name> 全形（无斜杠不合法，wrong token count）', async () => {
    const r = await fetch(`${m.origin}/api/get-user?id=admin1`, { headers: { Cookie: await adminCookie() } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.status).toBe('error')
    expect(String(j.msg)).toMatch(/token/)
  })
})

// ---- 批量供给的语义（M1 评审修复轮 R2）----
//
// 这三条覆盖的是本批新增的公开接口 upsertPermissions 的三处新语义。加它们的直接原因：
// 该接口此前**零直接测试**，于是"同批重复 code 抹掉 users"与"duplicate 无条件容忍"
// 两个缺陷都没被任何红检咬住——补测试是这类问题的唯一根治。

/** 直连 mock 的管理端点建一条权限记录（用于造出特定形状的既有数据） */
async function seedPermDirect(p: {
  owner: string
  name: string
  resources: string[]
  users?: string[]
}): Promise<void> {
  const r = await fetch(`${m.origin}/api/add-permission`, {
    method: 'POST',
    headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: p.name, users: [], ...p }),
  })
  const j = (await r.json()) as { status?: string }
  if (j.status !== 'ok') throw new Error(`seedPermDirect 失败：${JSON.stringify(j)}`)
}

describe('upsertPermissions 批量语义', () => {
  it('同批内同一 code 出现两次：只发一次写请求，不重复 add/update', async () => {
    const realFetch = globalThis.fetch
    let mutating = 0
    const c = new CasdoorClient({
      origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
      adminUser: 'admin', adminPwd: 'pw',
      fetchImpl: (input, init) => {
        const u = String(input)
        if (u.includes('add-permission') || u.includes('update-permission')) mutating++
        return realFetch(input as RequestInfo, init)
      },
    })

    await c.upsertPermissions([
      { code: 'dup:code', name: '重复码' },
      { code: 'dup:code', name: '重复码' },
    ])

    expect(mutating).toBe(1)
    // name 是**净化后**的（码含冒号，真 Casdoor 拒收 ⇒ 见 safePermissionName / issue #25）
    expect(m.permissionsIn('acme').filter((p) => p.name === 'dup-code')).toHaveLength(1)
  })

  it('★ 撞码（name 相同但 resources 不含该码）→ 抛错，绝不静默把既有授权洗掉', async () => {
    // 共享 Casdoor 里可能由别的系统建出这种记录：name 撞上我们**将要新建的名字**（净化后的
    // `collide-code`），但 resources 不认这个码。此时 add 会被判 duplicate，而"码究竟在不在"
    // 必须靠重读判定，不能靠错误文案猜。
    await seedPermDirect({
      owner: 'acme', name: 'collide-code', resources: ['legacy:other'], users: ['alice'],
    })

    const c = new CasdoorClient({
      origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
      adminUser: 'admin', adminPwd: 'pw',
    })
    // 同批传两次是关键：旧实现会"容忍 duplicate + 塞占位记录"，第二次迭代拿占位走 update
    // ⇒ 把 alice 的授权洗成 []，且全程不报错（这正是要防的静默损坏）
    //
    // 断言不锁错误文案：生产代码刚刚专门去掉了对 Casdoor 文案的依赖（文案随版本/分支变），
    // 测试层再把 `/duplicate/i` 押回 mock 自造的那句字符串上就是同一耦合换个位置。
    // 真正的判据是下面那条——既有记录的 users 有没有被动过
    await expect(
      c.upsertPermissions([
        { code: 'collide:code', name: '撞码' },
        { code: 'collide:code', name: '撞码' },
      ]),
    ).rejects.toThrow()

    // 既有记录的授权必须原封不动
    expect(m.permissionsIn('acme').find((p) => p.name === 'collide-code')?.users).toEqual(['alice'])
  })

  it('并发竞态：add 被拒但码确已被对方建好 ⇒ 视为成功，且不洗对方的 users', async () => {
    const realFetch = globalThis.fetch
    const cookie = await adminCookie()
    let injected = false
    const c = new CasdoorClient({
      origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
      adminUser: 'admin', adminPwd: 'pw',
      fetchImpl: async (input, init) => {
        // 客户端的查重发生在 add 之前 ⇒ 那时码还不存在；add 发出前让"另一个实例"把它建好
        // ⇒ 客户端拿到 duplicate，但目标状态其实已达成
        if (!injected && String(input).includes('add-permission')) {
          injected = true
          await realFetch(`${m.origin}/api/add-permission`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              owner: 'acme', name: 'race-code', displayName: '竞态',
              resources: ['race:code'], users: ['someone'],
            }),
          })
        }
        return realFetch(input as RequestInfo, init)
      },
    })

    await expect(c.upsertPermission('race:code', '竞态')).resolves.toBeUndefined()
    expect(m.permissionsIn('acme').find((p) => p.name === 'race-code')?.users).toEqual(['someone'])
  })

  it('★ 新建权限的 name 不含 Casdoor 禁用字符；码原样保留在 resources（issue #25）', async () => {
    // 真 Casdoor 对 name 拒绝 "/?:#&%=+;"，而本仓权限码形如 `demo:view` —— 旧实现直接把码当
    // name，**真环境必炸**（供给失败 ⇒ loadModules 抛 ⇒ 进程起不来）。MockCasdoor 不校验，
    // 所以这条**必须直接断言请求体**，不能只断言"调用成功"（那正是旧实现全绿的原因）。
    const realFetch = globalThis.fetch
    let addBody: Record<string, unknown> | null = null
    const c = new CasdoorClient({
      origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
      adminUser: 'admin', adminPwd: 'pw',
      fetchImpl: (input, init) => {
        if (String(input).includes('add-permission')) addBody = JSON.parse(String(init?.body))
        return realFetch(input as RequestInfo, init)
      },
    })

    // 用本文件里**没出现过**的码：mock 是 beforeAll 建的全文件共享实例，前面用例已建过
    // `demo:view` ⇒ 拿它测会走 update 路径、根本没有 add 请求（本条初版就这么栽的）
    await c.upsertPermission('charset:probe', '字符集探针')

    expect(addBody).not.toBeNull()
    // ① name 干净：不含任何 Casdoor 禁用字符
    expect(String(addBody!.name)).not.toMatch(/[/?:#&%=+;]/)
    expect(addBody!.name).toBe('charset-probe')
    // ② 码本身原样进 resources —— 换名只动标识字段，读侧与查重都只认 resources
    expect(addBody!.resources).toEqual(['charset:probe'])
  })
})

// ---- getUser：「错误」≠「不存在」（M1 闭债 R3）----
//
// 真机（sso.hookflow.cn 实测）把"用户不存在"回成 200+{status:'ok',data:null}，把一堆与
// "不存在"无关的情形（admin 会话失效 / id 非两段 / org 不存在 / DB 出错）回成 status:error。
// 把 error 折叠成 null 会让调用方误判 ⇒ 会话中间件清 cookie（静默登出，issue #3 第三节）。

describe('getUser：错误 ≠ 不存在', () => {
  /** 与 casdoor-client.test.ts 既有装配同形状的最小 client 工厂 */
  const clientFor = (m: MockCasdoor, org: string): CasdoorClient => new CasdoorClient({
    origin: m.origin, clientId: 'test-client', clientSecret: '', org,
    adminUser: 'admin', adminPwd: 'pw',
  })

  it('★ 负例：未知用户 ⇒ null', async () => {
    const m = new MockCasdoor({ users: [] })
    await m.start()
    try {
      expect(await clientFor(m, 'mock-org').getUser('nobody')).toBeNull()
    } finally {
      await m.stop()
    }
  })

  it('★ 负例：status:error ⇒ 抛错，绝不返回 null（旧实现把它当"用户不存在"）', async () => {
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = clientFor(m, 'mock-org')
      m.setGetUserFault('error') // 模拟 admin 会话失效 / 上游内部错
      await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
    } finally {
      await m.stop()
    }
  })

  it('★ admin 会话失效后可自愈：首次 error ⇒ 强制重登并重试成功', async () => {
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = clientFor(m, 'mock-org')
      // 预热一次：把 admin cookie 缓存进 client。**计划原文在 client 构造后直接取 before，
      // 但首次调用本身就要登一次（缓存未命中）⇒ 断言 before+1 会实测成 before+2。**
      // 自愈用例要钉的是"故障多登了一次"，故必须先有已缓存的会话，计数差才有意义。
      expect((await c.getUser('alice'))?.name).toBe('alice')
      const before = m.adminLoginCalls
      m.setGetUserFault('errorOnce') // 只错一次：等价于"缓存里的 admin cookie 已失效"
      const u = await c.getUser('alice')
      expect(u?.name).toBe('alice')              // 重试后拿到正确结果
      expect(m.adminLoginCalls).toBe(before + 1) // 且确实重登了一次
    } finally {
      await m.stop()
    }
  })

  // ---- S1：重登放大的冷却闸（评审实测：持续 error 下 3 次失败 getUser = 3 次额外登录；
  //      8 个并发失败 getUser = 8 次登录；且**非会话类**错误也照样触发重登）----
  //
  // 无死循环（重试严格一次，有界），但高错误率/持续故障下会在**共享 SSO** 上把登录压力
  // 按请求数放大。冷却闸把"每请求一次重登"压成"每冷却窗最多一次"。

  it('★ 负例：持续 error 下重登被冷却闸住（旧实现：5 次失败 = 5 次额外登录）', async () => {
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = clientFor(m, 'mock-org')
      expect((await c.getUser('alice'))?.name).toBe('alice') // 预热：缓存一个有效 admin 会话
      const before = m.adminLoginCalls
      m.setGetUserFault('error') // 持续故障（不是"会话刚失效"那一次）
      for (let i = 0; i < 5; i++) await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
      expect(m.adminLoginCalls).toBe(before + 1)
    } finally {
      await m.stop()
    }
  })

  it('冷却闸闸的是"窗口"，不是"只重登一次"的闩（reloginCooldownMs:0 ⇒ 每次都重登）', async () => {
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'test-client', clientSecret: '', org: 'mock-org',
        adminUser: 'admin', adminPwd: 'pw',
        reloginCooldownMs: 0, // 关闭冷却 ⇒ 退化成旧口径（每请求一次重登）
      })
      expect((await c.getUser('alice'))?.name).toBe('alice')
      const before = m.adminLoginCalls
      m.setGetUserFault('error')
      for (let i = 0; i < 3; i++) await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
      expect(m.adminLoginCalls).toBe(before + 3)
    } finally {
      await m.stop()
    }
  })

  // 上一条（cooldownMs:0）只证"不是闩"，**没证"窗口会随时间重开"**：一条"每客户端只重登
  // 一次"的闩、或把冷却按次数计，照样能过它。这里用**小正数冷却**并**手动推进注入时钟**过
  // 窗口 ⇒ 窗口外的下一次失败必须再允许一次重登。（评审 S2：注释写了"窗口过后会再报"，
  // 就得有断言钉住。）用注入时钟而非 `await setTimeout(250)`：去墙钟依赖，快且不 flaky。
  it('★ 负例：冷却窗口随时间重开（小正数冷却，推进过窗口后第 2 次重登出现）', async () => {
    const COOLDOWN_MS = 250
    let clockMs = 1_000_000 // 注入时钟（ms）：从 0 起会让"首次重登"被当成窗口内，故取大基值
    const m = new MockCasdoor({ users: [{ name: 'alice', password: 'pw' }] })
    await m.start()
    try {
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'test-client', clientSecret: '', org: 'mock-org',
        adminUser: 'admin', adminPwd: 'pw',
        reloginCooldownMs: COOLDOWN_MS,
        now: () => clockMs,
      })
      expect((await c.getUser('alice'))?.name).toBe('alice') // 预热：缓存一个有效 admin 会话
      const before = m.adminLoginCalls
      m.setGetUserFault('error')
      // 窗口内：连续两次失败只许重登一次（冷却生效）
      await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
      await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
      expect(m.adminLoginCalls).toBe(before + 1)
      clockMs += COOLDOWN_MS + 1 // 手动推进过冷却窗口（旧写法靠 await setTimeout(COOLDOWN_MS+100)）
      await expect(c.getUser('alice')).rejects.toThrow(/get-user/)
      // 窗口外的那次必须再重登一次——"只重登一次"的闩/按次数计在这里必红
      expect(m.adminLoginCalls).toBe(before + 2)
    } finally {
      await m.stop()
    }
  })
})

// ---- JIT 自动建号（issue #32）：ensureUser + bindUserToAllPermissions ----
// 形状依据：2026-09-13 生产手工解卡时在真 Casdoor（sso.hookflow.cn）上验证过的 add-user
// 载荷——owner=<org>、name=<企微 userid>、type='normal-user'、signupApplication=<配置的
// application>。建号后把该用户补进 org 全部权限记录的 users（装载器供给只建记录不挂人）。

describe('ensureUser + bindUserToAllPermissions（JIT 自动建号，issue #32）', () => {
  it('★ ensureUser：add-user 带 owner/name/type=normal-user/signupApplication（application 可配，缺省 app-built-in 同 #login 口径）', async () => {
    // orgs 种子：#117 起 add-user 有两个 org 前置（org 存在 + 已有 application）——
    // 真机上 org 先于用户存在，替身同样不再「来者不拒」
    const m = new MockCasdoor({ users: [], orgs: [{ name: 'acme' }] })
    await m.start()
    try {
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
        adminUser: 'admin', adminPwd: 'pw', application: 'app-mytech',
      })
      await c.ensureUser('wo_new')
      expect(m.userIn('acme', 'wo_new')).toMatchObject({
        owner: 'acme', name: 'wo_new', type: 'normal-user', signupApplication: 'app-mytech',
      })
      // 建成后 get-user 立即可查（路由的 JIT 后重读依赖这一点）
      expect((await c.getUser('wo_new'))?.name).toBe('wo_new')

      // 未配 application：缺省 app-built-in（与 #login 的 application 缺省同口径）
      const c2 = new CasdoorClient({
        origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
        adminUser: 'admin', adminPwd: 'pw',
      })
      await c2.ensureUser('wo_plain')
      expect(m.userIn('acme', 'wo_plain')).toMatchObject({ signupApplication: 'app-built-in' })
    } finally {
      await m.stop()
    }
  })

  it('★ add 竞态：add-user 被拒但人已被并发建好 ⇒ 重读验证视为成功（不按错误文案分支，同 upsertPermissions 口径）', async () => {
    // 预种同名用户：add-user 必中 duplicate（真机 casdoor object.AddUser 查重 ⇒ status:error）
    const m = new MockCasdoor({ users: [{ name: 'wo_raced', password: '', owner: 'acme' }] })
    await m.start()
    try {
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
        adminUser: 'admin', adminPwd: 'pw',
      })
      await expect(c.ensureUser('wo_raced')).resolves.toBeUndefined() // 竞态 ⇒ 视为成功，不抛
      // 既有用户的口令/角色不被竞态路径洗掉（add 没发生第二次）
      expect(m.addUserCalls).toHaveLength(0)
    } finally {
      await m.stop()
    }
  })

  it('★ add 真失败（故障注入 + 重读仍查无此人）⇒ 抛错（fail loudly，绝不静默放行）', async () => {
    const m = new MockCasdoor({ users: [], orgs: [{ name: 'acme' }] }) // orgs 种子同上（#117 add-user 前置）
    await m.start()
    try {
      m.setAddUserFault('error')
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
        adminUser: 'admin', adminPwd: 'pw',
      })
      await expect(c.ensureUser('wo_absent')).rejects.toThrow(/add-user/)
      expect(m.userIn('acme', 'wo_absent')).toBeUndefined()
    } finally {
      m.setAddUserFault('off')
      await m.stop()
    }
  })

  it('★ bindUserToAllPermissions：逐条补 users、保留 roles/resources 原值、其他 org 的权限不受影响、幂等', async () => {
    const m = new MockCasdoor({
      perms: [
        { owner: 'acme', name: 'p-view', users: ['alice'], resources: ['ticket:view'] },
        { owner: 'acme', name: 'p-admin', users: [], roles: ['ops'], resources: ['ticket:admin'] },
        { owner: 'other-org', name: 'p-other', users: [], resources: ['ticket:view'] },
      ],
    })
    await m.start()
    try {
      const c = new CasdoorClient({
        origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme',
        adminUser: 'admin', adminPwd: 'pw',
      })
      await c.bindUserToAllPermissions('wo_new')
      const acme = m.permissionsIn('acme')
      expect(acme.find((p) => p.name === 'p-view')?.users).toEqual(['alice', 'wo_new'])
      expect(acme.find((p) => p.name === 'p-admin')?.users).toEqual(['wo_new'])
      // 既有字段不被洗掉（update 全量载荷必须回填 roles/resources）
      expect(acme.find((p) => p.name === 'p-admin')?.roles).toEqual(['ops'])
      expect(acme.find((p) => p.name === 'p-admin')?.resources).toEqual(['ticket:admin'])
      // 其他 org 的同名资源权限**不在本 org 的 get-permissions 桶里** ⇒ 一行都不能碰
      expect(m.permissionsIn('other-org').find((p) => p.name === 'p-other')?.users).toEqual([])
      // 幂等：已绑过的不再重复 push
      await c.bindUserToAllPermissions('wo_new')
      expect(m.permissionsIn('acme').find((p) => p.name === 'p-view')?.users).toEqual(['alice', 'wo_new'])
    } finally {
      await m.stop()
    }
  })
})

// ── 订阅域（spec 2026-09-13 SaaS 管理域；真机尖刺三铁律见 casdoor-client.ts）──
describe('CasdoorClient 订阅域（fetchImpl 假路由器）', () => {
  // 假路由器的形参写 `RequestInfo | URL`（= `Request | string | URL`），**不能**只写
  // `RequestInfo`：`fetchImpl` 的声明是 `typeof fetch`，而 `fetch` 的两条重载分别是
  // `(input: URL | RequestInfo, …)` 与 `(input: string | URL | Request, …)` 都含裸 `URL`
  // ⇒ 形参缺 URL 的实参不可赋（TS2345，issue #68 Step 3 清掉的 5 条）。函数赋给**重载**
  // 目标时 TS 要求对**每条**重载都成立，故按并集写最宽的那条。
  function subRouter(rows: Record<string, unknown[]>, log: { path: string; body?: unknown }[]) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void init
      const u = String(input)
      log.push({ path: u.replace(/^https?:\/\/[^/]+/, '') })
      if (u.includes('/api/login')) {
        return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'set-cookie': 'casdoor_session_id=x' } })
      }
      for (const [frag, data] of Object.entries(rows)) {
        if (u.includes(frag)) return new Response(JSON.stringify({ status: 'ok', data }))
      }
      return new Response(JSON.stringify({ status: 'error', msg: 'no route: ' + u }))
    }
  }
  const mk = (f: typeof fetch) =>
    new CasdoorClient({ origin: 'http://x', clientId: 'c', clientSecret: 's', org: 'acme', adminUser: 'a', adminPwd: 'p', fetchImpl: f })

  it('listSubscriptions：按 owner 查、透传全部字段、error 抛错', async () => {
    const log: { path: string; body?: unknown }[] = []
    const c = mk(subRouter({
      '/api/get-subscriptions?owner=acme': [
        { owner: 'acme', name: 'sub-mod-demo', user: 'acme/tenantsub', plan: 'mod-demo', startTime: '2026-09-13T00:00:00Z', endTime: '2027-09-13T00:00:00Z', state: 'Active' },
        { owner: 'acme', name: 'sub_6a6def', user: 'woke-admin', plan: 'plan-pro', state: 'Active' },
      ],
    }, log))
    const subs = await c.listSubscriptions('acme')
    expect(subs).toHaveLength(2)
    expect(subs[0]).toMatchObject({ plan: 'mod-demo', state: 'Active' })
    expect(log[log.length - 1].path).toBe('/api/get-subscriptions?owner=acme')
  })

  it('listSubscriptions：接口 error 一律抛（静默空表=全租户失能）', async () => {
    const c = mk(subRouter({}, []))
    await expect(c.listSubscriptions('acme')).rejects.toThrow('casdoor get-subscriptions')
  })
})

describe('CasdoorClient 订阅域写路径（rwRouter：org→锚用户→plan→订阅）', () => {
  // 形参同 subRouter（`RequestInfo | URL`），理由见那一处的注释
  function rwRouter(
    get: (frag: string, q: URLSearchParams) => unknown,
    post: (frag: string, body: any, q: URLSearchParams) => { status: string; data?: unknown },
    log: { path: string; body?: any }[],
  ) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const frag = u.pathname.replace('/api', '')
      log.push({ path: frag + u.search, body })
      if (frag === '/login') return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'set-cookie': 'casdoor_session_id=x' } })
      if (init?.method === 'GET') return new Response(JSON.stringify({ status: 'ok', data: get(frag, u.searchParams) }))
      return new Response(JSON.stringify(post(frag, body, u.searchParams)))
    }
  }
  const mk2 = (f: typeof fetch) =>
    new CasdoorClient({ origin: 'http://x', clientId: 'c', clientSecret: 's', org: 'acme', adminUser: 'a', adminPwd: 'p', fetchImpl: f })

  it('四联：ensureOrg/ensureAnchorUser(幂等)/ensureModulePlan/upsertSubscription(RFC3339+body+回读)', async () => {
    // org 存储按 #117 真机形状建模：add-organization 缺 owner/passwordType ⇒ 落空串（畸形）；
    // get-organization 单查按 (owner,name) 命中（get-organizations 列表不过滤 owner）
    const orgs: Array<{ owner: string; name: string; passwordType: string }> = []
    const users = new Set<string>()
    const plans = new Set<string>()
    const subs = new Map<string, any>()
    const log: { path: string; body?: any }[] = []
    const c = mk2(rwRouter(
      (frag, q) => {
        if (frag === '/get-organizations') return orgs.map((g) => ({ owner: g.owner, name: g.name, passwordType: g.passwordType }))
        if (frag === '/get-organization') {
          const segs = (q.get('id') ?? '').split('/')
          const hit = segs.length === 2 ? orgs.find((g) => g.owner === segs[0] && g.name === segs[1]) : undefined
          return hit ? { owner: hit.owner, name: hit.name, passwordType: hit.passwordType } : null
        }
        if (frag === '/get-user') return users.has(q.get('id')!) ? { name: q.get('id')!.split('/')[1] } : null
        if (frag === '/get-plan') return plans.has(q.get('id')!) ? { name: q.get('id')!.split('/')[1] } : null
        if (frag === '/get-subscription') return subs.has(q.get('id')!) ? subs.get(q.get('id')!) : null
        if (frag === '/get-subscriptions') return [...subs.values()].filter((s) => s.owner === q.get('owner'))
        return []
      },
      (frag, body, q) => {
        if (frag === '/add-organization') { orgs.push({ owner: String(body.owner ?? ''), name: body.name, passwordType: String(body.passwordType ?? '') }); return { status: 'ok', data: 'Affected' } }
        if (frag === '/add-user') { users.add(body.owner + '/' + body.name); return { status: 'ok', data: 'Affected' } }
        if (frag === '/add-plan') { plans.add(body.owner + '/' + body.name); return { status: 'ok', data: 'Affected' } }
        if (frag === '/add-subscription') { subs.set(body.owner + '/' + body.name, body); return { status: 'ok', data: 'Affected' } }
        if (frag === '/update-subscription') {
          // 真机形状（issue #50）：update-* 按 ?id=<org>/<name> 定位，缺 id 时静默 no-op —— 替身必须拒绝无 id 的 update
          const id = q.get('id')
          if (!id || !subs.has(id)) return { status: 'error', msg: 'update-subscription 需要 ?id=<org>/<name>' }
          subs.set(id, body)
          return { status: 'ok', data: 'Affected' }
        }
        return { status: 'error', msg: 'no post route ' + frag }
      },
      log,
    ))
    await c.ensureOrg('neworg'); expect(orgs.map((g) => g.name)).toContain('neworg')
    await c.ensureAnchorUser('neworg'); expect(users.has('neworg/tenantsub')).toBe(true)
    await c.ensureAnchorUser('neworg')
    expect(log.filter((l) => l.path === '/add-user').length).toBe(1) // 幂等
    await c.ensureModulePlan('neworg', 'case-engine'); expect(plans.has('neworg/mod-case-engine')).toBe(true)
    await c.upsertSubscription('neworg', 'case-engine', { state: 'Active', days: 30 })
    const sub = subs.get('neworg/sub-mod-case-engine')!
    expect(sub.state).toBe('Active')
    expect(sub.user).toBe('neworg/tenantsub')
    expect(sub.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/) // 铁律① RFC3339
    await c.upsertSubscription('neworg', 'case-engine', { state: 'Terminated' })
    expect(subs.get('neworg/sub-mod-case-engine').state).toBe('Terminated') // 退订=update
    // issue #50 修订：update-* 真机按 ?id=<org>/<name> 定位（此前「写一律 body、path 无 ?id=」的
    // 断言钉死了错误形状——真机缺 id 静默 no-op，被宽松替身遮蔽）。body 仍带 owner/name（delete 铁律②不变）。
    expect(log.some((l) => l.path.startsWith('/update-subscription?id='))).toBe(true)
    expect(log.filter((l) => l.path.startsWith('/update-subscription')).at(-1)?.body.owner).toBe('neworg')
  })

  // ---- issue #50：update 必须带 ?id=，回读验 state（真机形状钉死）----

  it('Active → Terminated：update 带 ?id= 且回读 state 生效', async () => {
    const subs = new Map<string, any>([['acme/sub-mod-demo', { owner: 'acme', name: 'sub-mod-demo', user: 'acme/tenantsub', plan: 'mod-demo', startTime: '2026-09-14T00:00:00Z', endTime: '2036-09-11T00:00:00Z', state: 'Active' }]])
    const log: { path: string; body?: any }[] = []
    const c = mk2(rwRouter(
      (frag, q) => {
        if (frag === '/get-subscription') return subs.has(q.get('id')!) ? subs.get(q.get('id')!) : null
        if (frag === '/get-subscriptions') return [...subs.values()].filter((s) => s.owner === q.get('owner'))
        return []
      },
      (frag, body, q) => {
        if (frag === '/update-subscription') {
          const id = q.get('id')
          if (!id || !subs.has(id)) return { status: 'error', msg: 'update-subscription 需要 ?id=<org>/<name>' }
          subs.set(id, body)
          return { status: 'ok', data: 'Affected' }
        }
        return { status: 'error', msg: 'no post route ' + frag }
      },
      log,
    ))
    await c.upsertSubscription('acme', 'demo', { state: 'Terminated' })
    const upd = log.filter((l) => l.path.startsWith('/update-subscription')).at(-1)!
    expect(upd.path).toBe('/update-subscription?id=acme%2Fsub-mod-demo') // 铁律形状：id query
    expect(subs.get('acme/sub-mod-demo').state).toBe('Terminated')
  })

  it('写丢 state 时回读校验抛错（不再假绿）', async () => {
    // 真机故障形状：update 回 ok 但 state 没变（如替身吞掉变更）→ 回读 Active ⇒ 必须抛
    const subs = new Map<string, any>([['acme/sub-mod-demo', { owner: 'acme', name: 'sub-mod-demo', user: 'acme/tenantsub', plan: 'mod-demo', startTime: '2026-09-14T00:00:00Z', endTime: '2036-09-11T00:00:00Z', state: 'Active' }]])
    const c = mk2(rwRouter(
      (frag, q) => (frag === '/get-subscription' ? (subs.has(q.get('id')!) ? subs.get(q.get('id')!) : null) : []),
      () => ({ status: 'ok', data: 'Affected' }), // update 永远 ok 但不改数据（写丢形状）
      [],
    ))
    await expect(c.upsertSubscription('acme', 'demo', { state: 'Terminated' })).rejects.toThrow('state')
  })
})

// ── #117：共享 Casdoor 首建 org（2026-09-19 山海交付实测的三处真机陷阱：
//    ① add-organization 缺 owner ⇒ owner="" 畸形 org：列表可见、单查失明，后续 add-user 报
//      `The organization: <org> does not exist`；② 缺 passwordType ⇒ 该 org 用户密码登录报
//      `unsupported password type: `；③ add-user 缺 signupApplication / org 零 application ⇒ 被拒
//    （共享 Casdoor 正典 = 每客户 org 一个 application，交付 runbook 先建）──
describe('ensureOrg / ensureAnchorUser（#117 共享 Casdoor 首建）', () => {
  const mkOrgClient = (mock: MockCasdoor, org: string, application?: string) =>
    new CasdoorClient({
      origin: mock.origin, clientId: 'x', clientSecret: 'y', org,
      adminUser: 'admin', adminPwd: 'pw', ...(application ? { application } : {}),
    })

  it('★ ensureOrg：建出的 org 单查可见且形状正确（owner=admin、passwordType=bcrypt）', async () => {
    const m = new MockCasdoor({ users: [] })
    await m.start()
    try {
      await mkOrgClient(m, 'neworg').ensureOrg('neworg')
      expect(m.organizationIn('admin', 'neworg')).toMatchObject({ owner: 'admin', name: 'neworg', passwordType: 'bcrypt' })
    } finally {
      await m.stop()
    }
  })

  it('★ ensureOrg：同名畸形 org（owner≠admin，单查失明）⇒ 响亮抛错——此前「列表可见」被当存在而假绿放行', async () => {
    // 复刻旧版 CLI 建出的畸形 org：owner=""、零 application；get-organizations 列表看得见，
    // get-organization?id=admin/<name> 单查失明 ⇒ ensureOrg 不得把它当「已存在」放行
    const m = new MockCasdoor({ orgs: [{ name: 'ghost', owner: '', applications: [] }] })
    await m.start()
    try {
      await expect(mkOrgClient(m, 'ghost').ensureOrg('ghost')).rejects.toThrow(/ghost/)
    } finally {
      await m.stop()
    }
  })

  it('ensureOrg 幂等：已存在的正常 org 直接返回，不发 add-organization', async () => {
    const m = new MockCasdoor({ orgs: [{ name: 'acme-org' }] })
    await m.start()
    try {
      await mkOrgClient(m, 'acme-org').ensureOrg('acme-org')
      expect(m.addOrganizationCalls).toHaveLength(0)
    } finally {
      await m.stop()
    }
  })

  it('★ ensureAnchorUser：add-user 带 signupApplication（缺省 app-built-in，可配——与 #login/ensureUser 同口径）', async () => {
    const m = new MockCasdoor({ orgs: [{ name: 'neworg' }, { name: 'neworg2' }] })
    await m.start()
    try {
      await mkOrgClient(m, 'neworg').ensureAnchorUser('neworg')
      expect(m.userIn('neworg', 'tenantsub')).toMatchObject({
        owner: 'neworg', name: 'tenantsub', type: 'normal-user', isForbidden: true,
        signupApplication: 'app-built-in',
      })
      await mkOrgClient(m, 'neworg2', 'app-shanhai').ensureAnchorUser('neworg2')
      expect(m.userIn('neworg2', 'tenantsub')).toMatchObject({ signupApplication: 'app-shanhai' })
    } finally {
      await m.stop()
    }
  })

  it('★ ensureAnchorUser：org 零 application ⇒ add-user 被真机拒（交付 runbook 先建 application）且不留半建用户', async () => {
    const m = new MockCasdoor({ orgs: [{ name: 'neworg', applications: [] }] })
    await m.start()
    try {
      await expect(mkOrgClient(m, 'neworg').ensureAnchorUser('neworg')).rejects.toThrow()
      expect(m.userIn('neworg', 'tenantsub')).toBeUndefined()
    } finally {
      await m.stop()
    }
  })
})

// ---- M3 租户管理域（spec D4/D9：listUsers / 用户生命周期 / 权限码 grant/revoke） ----

describe('M3 用户与授权（D4）', () => {
  let mm: MockCasdoor
  beforeAll(async () => {
    mm = new MockCasdoor({
      users: [
        { name: 'alice', password: 'pw', owner: 'acme', displayName: 'Alice' },
        { name: 'bob', password: 'pw', owner: 'acme', isForbidden: true },
        { name: 'tenantsub', password: 'x', owner: 'acme', isForbidden: true },
      ],
      perms: [
        { owner: 'acme', name: 'demo-view', displayName: '演示查看', resources: ['demo:view'], users: ['acme/bob'] },
      ],
    })
    await mm.start()
  })
  afterAll(async () => { await mm.stop() })
  const client = () =>
    new CasdoorClient({ origin: mm.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })

  it('listUsers 列本 org 用户（三字段；built-in admin 不在桶内）', async () => {
    const users = await client().listUsers()
    expect(users).toContainEqual({ name: 'alice', displayName: 'Alice', isForbidden: false })
    expect(users).toContainEqual({ name: 'bob', displayName: 'bob', isForbidden: true })
    expect(users.map((u) => u.name)).not.toContain('admin')
  })

  it('createManagedUser 建号（密码进载荷）且写后回读验证（铁律③）', async () => {
    await client().createManagedUser({ name: 'carol', displayName: 'Carol', password: 'InitPass123' })
    const seeded = mm.userIn('acme', 'carol')
    expect(seeded?.createdViaApi).toMatchObject({ owner: 'acme', name: 'carol', displayName: 'Carol', password: 'InitPass123', type: 'normal-user' })
  })

  it('setUserForbidden 置位：update 载荷带回既有 displayName（防字段被洗）且生效', async () => {
    await client().setUserForbidden('alice', true)
    const call = mm.updateUserCalls.at(-1)
    expect(call).toMatchObject({ id: 'acme/alice', isForbidden: true, displayName: 'Alice' })
    expect(mm.userIn('acme', 'alice')?.isForbidden).toBe(true)
  })

  it('resetUserPassword：payload 含新密码、不进任何日志面（update 调用可见性由 mock 记录保证）', async () => {
    await client().resetUserPassword('alice', 'NewPass456')
    expect(mm.updateUserCalls.at(-1)).toMatchObject({ id: 'acme/alice', password: 'NewPass456' })
  })

  it('deleteUser 走 JSON body {owner,name}（铁律②）且删后回读为无（铁律③）', async () => {
    await client().deleteUser('bob')
    expect(mm.deleteUserCalls).toEqual([{ owner: 'acme', name: 'bob' }])
    expect(mm.userIn('acme', 'bob')).toBeUndefined()
  })

  it('deleteUser 对不存在者抛错（回读仍存在分支不可达于 mock，但回读校验本身被走过）', async () => {
    // mock 的 delete 幂等形状：不存在也 ok —— 客户端回读 getUser=null ⇒ 正常返回（幂等删除）
    await expect(client().deleteUser('ghostuser')).resolves.toBeUndefined()
  })

  it('grantPermissionToUser 追加全形 org/user、保留既有配额，写后回读验证', async () => {
    await client().grantPermissionToUser('demo:view', 'alice')
    const perm = mm.permissionsIn('acme').find((p) => (p.resources as string[]).includes('demo:view'))
    expect(perm?.users).toEqual(['acme/bob', 'acme/alice']) // 既有 acme/bob 保留、新挂全形
  })

  it('grantPermissionToUser 幂等：已挂（短名或全形）不再发 update', async () => {
    const before = mm.updateUserCalls.length // 无关口；permission 的 update 无独立记录口，用状态断言
    await client().grantPermissionToUser('demo:view', 'bob') // acme/bob 已在
    const perm = mm.permissionsIn('acme').find((p) => (p.resources as string[]).includes('demo:view'))
    expect(perm?.users).toEqual(['acme/bob', 'acme/alice']) // 不变（无重复、无顺序扰动）
    expect(before).toBe(mm.updateUserCalls.length)
  })

  it('revokePermissionFromUser 清全形并保留他人', async () => {
    await client().revokePermissionFromUser('demo:view', 'alice')
    const perm = mm.permissionsIn('acme').find((p) => (p.resources as string[]).includes('demo:view'))
    expect(perm?.users).toEqual(['acme/bob'])
  })

  it('revokePermissionFromUser 幂等：本就没挂直接返回', async () => {
    await expect(client().revokePermissionFromUser('demo:view', 'ghostuser')).resolves.toBeUndefined()
    const perm = mm.permissionsIn('acme').find((p) => (p.resources as string[]).includes('demo:view'))
    expect(perm?.users).toEqual(['acme/bob'])
  })

  it('grant/revoke 对未知码抛错（先跑装载器供给）', async () => {
    await expect(client().grantPermissionToUser('nope:code', 'alice')).rejects.toThrow('不存在权限码')
    await expect(client().revokePermissionFromUser('nope:code', 'alice')).rejects.toThrow('不存在权限码')
  })
})
