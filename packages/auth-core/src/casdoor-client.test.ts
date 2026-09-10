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

// ---- C2 语义钉死（mock 三纪律 + 会话缓存/重试/异常面） ----
describe('CasdoorClient 语义钉死（C2）', () => {
  it('密码验证失败 = HTTP 200 + {"status":"error"}（纪律③），且响应不含明文密码（纪律①）', async () => {
    const r = await fetch(`${m.origin}/api/login?type=login&username=admin1&password=bad&application=app-built-in`, { method: 'POST' })
    expect(r.status).toBe(200) // 绝不能是 401/403 —— 真实 Casdoor 行为
    const j: Record<string, unknown> = await r.json()
    expect(j.status).toBe('error')
    expect(JSON.stringify(j)).not.toContain('"password"')
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
})
