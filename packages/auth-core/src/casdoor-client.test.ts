import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CasdoorClient } from './casdoor-client'
import { MockCasdoor } from './test-util/mock-casdoor'

let m: MockCasdoor
beforeAll(async () => { m = new MockCasdoor({ users: [{ name: 'admin1', password: 'pw', roles: ['ops'] }],
  perms: [{ users: ['admin1'], resources: ['demo:view'] }] }); await m.start() })
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
    const put = await fetch(`${m.origin}/api/update-permission?id=mock-org/demo:view`, {
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
