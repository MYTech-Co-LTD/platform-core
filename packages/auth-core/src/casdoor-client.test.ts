import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CasdoorClient } from './casdoor-client'
import { MockCasdoor } from './test-util/mock-casdoor'

let m: MockCasdoor
// owner 必须与下面 client 的 org 一致：权限按 org 分桶后，种到 mock-org 的码在
// org:'acme' 的 client 眼里是不存在的（这正是 mock 分桶语义生效的证明）
beforeAll(async () => { m = new MockCasdoor({ users: [{ name: 'admin1', password: 'pw', roles: ['ops'] }],
  perms: [{ owner: 'acme', users: ['admin1'], resources: ['demo:view'] }] }); await m.start() })
afterAll(async () => { await m.stop() })

describe('CasdoorClient', () => {
  it('verifyPassword 成功返回用户，失败返回 null', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme' })
    expect((await c.verifyPassword('admin1', 'pw')).name).toBe('admin1')
    expect(await c.verifyPassword('admin1', 'bad')).toBeNull()
  })
  it('getUser/getPermissions 携带 admin 会话', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    expect((await c.getUser('admin1')).roles).toEqual(['ops'])
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
    expect(jok.data).toBe('mock-org/admin1')

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

  it('admin 会话失效（401）自动重登一次并重试', async () => {
    const c = new CasdoorClient({ origin: m.origin, clientId: 'x', clientSecret: 'y', org: 'acme', adminUser: 'admin', adminPwd: 'pw' })
    expect((await c.getUser('admin1')).name).toBe('admin1') // 首次：登录 + 缓存 cookie
    m.expireSessions() // 服务端吊销全部会话 → 下一次管理调用 401
    expect((await c.getUser('admin1')).name).toBe('admin1') // 401 → 重登 → 重试成功
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
    expect((await c2.verifyPassword('admin1', 'pw')).name).toBe('admin1')
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
    expect(m.permissionsIn('acme').filter((p) => p.name === 'dup:code')).toHaveLength(1)
  })

  it('★ 撞码（name 相同但 resources 不含该码）→ 抛错，绝不静默把既有授权洗掉', async () => {
    // 共享 Casdoor 里可能由别的系统建出这种记录：name 撞上我们的 code，但 resources 不认它。
    // 此时 add 会被判 duplicate，而"码究竟在不在"必须靠重读判定，不能靠错误文案猜。
    await seedPermDirect({
      owner: 'acme', name: 'collide:code', resources: ['legacy:other'], users: ['alice'],
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
    expect(m.permissionsIn('acme').find((p) => p.name === 'collide:code')?.users).toEqual(['alice'])
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
              owner: 'acme', name: 'race:code', displayName: '竞态',
              resources: ['race:code'], users: ['someone'],
            }),
          })
        }
        return realFetch(input as RequestInfo, init)
      },
    })

    await expect(c.upsertPermission('race:code', '竞态')).resolves.toBeUndefined()
    expect(m.permissionsIn('acme').find((p) => p.name === 'race:code')?.users).toEqual(['someone'])
  })
})
