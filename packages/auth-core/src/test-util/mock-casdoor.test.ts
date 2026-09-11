// mock 的 owner= 隔离是「门禁对 multi 权限失明」的根因（issue #3 第二节成因①）：
// mock 自陈"单 org、忽略 owner=" ⇒ 真实的写读分叉在冒烟里看不见。
// 测试替身自己的语义也要有测试——否则它给出的"全绿"没有任何证据价值。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from './mock-casdoor'

let m: MockCasdoor
beforeAll(async () => {
  m = new MockCasdoor({
    users: [{ name: 'admin1', password: 'pw' }],
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
