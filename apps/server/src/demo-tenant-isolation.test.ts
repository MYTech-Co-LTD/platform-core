// demo-tenant-isolation.test.ts — spec-1 §2 的机检面：模块租户数据表按 identity.orgId 隔离。
//
// 为什么走真装配而不是手搭模块 router：隔离由「路由按 org 过滤 + identity 注入」两层合成，
// 手搭 router 只测得到第一层；Host→租户→identity.orgId 这条链（I-1 契约）只有 buildApp 有。
// 真 PG + MockCasdoor + multi 形态（同 app.test.ts 约定：无 DATABASE_URL 整体跳过）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// 文件级关池（app.test.ts 同款守卫：防某个 describe 私自关池让后续用例拿死池）
afterAll(async () => {
  if (!dbUrl) return
  const pool = getPool({ databaseUrl: dbUrl })
  expect(pool.ended, '池在文件级 afterAll 之前就被 end 了——检查 describe 里是否私自关池').toBe(false)
  await pool.end().catch(() => {})
})

const ISO_PW = 'pw-isolation-1'

describePg('demo 模块租户隔离（spec-1 §2：org 不可互见）', () => {
  const mock = new MockCasdoor({
    // owner = 用户归属 org（真机语义，smoke-load 同款）：acme/beta 各一名
    users: [
      { name: 'iso-acme', password: ISO_PW, owner: 'acme' },
      { name: 'iso-beta', password: ISO_PW, owner: 'beta' },
    ],
    // 权限按 owner 分桶；scope 读侧消费 resources（loader 供给同形状）
    perms: [
      { owner: 'acme', resources: ['demo:note'], users: ['iso-acme'] },
      { owner: 'beta', resources: ['demo:note'], users: ['iso-beta'] },
    ],
  })
  let app: Awaited<ReturnType<typeof buildApp>>['app']

  beforeAll(async () => {
    await mock.start()
    const config: AppConfig = {
      port: 13000,
      databaseUrl: dbUrl!,
      tenantMode: 'multi', // 两租户并存，Host 头分流（acme.test / beta.test）
      platformOrg: '',
      sessionSecret: 'test-secret-test-secret-test-secret!',
      casdoor: {
        url: mock.origin,
        clientId: 'test-client',
        clientSecret: '',
        application: 'app-built-in',
        adminUser: 'admin',
        adminPwd: 'pw',
      },
      publicOrigin: 'http://127.0.0.1:13000',
      seedDemo: true, // 种 acme/beta 两租户 + demo 启用（tenant_module 源，默认订阅源=platform）
    }
    app = (await buildApp({ config })).app
  })
  afterAll(async () => {
    await mock.stop()
  })

  /** 账密登录拿 platform_session cookie（smoke-load 同款路径） */
  async function sessionCookie(host: string, username: string): Promise<string> {
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host },
      body: JSON.stringify({ username, password: ISO_PW }),
    })
    expect(res.status, `登录 ${username}@${host} 应 200`).toBe(200)
    const jar = res.headers.getSetCookie().join('; ')
    const hit = /platform_session=[^;]+/.exec(jar)
    if (!hit) throw new Error('登录响应未带 platform_session cookie')
    return hit[0]
  }

  it('acme 建的 note，beta 看不到；反向亦然；库里 org 列 = 写入者 org', async () => {
    const acmeCookie = await sessionCookie('acme.test', 'iso-acme')
    const betaCookie = await sessionCookie('beta.test', 'iso-beta')
    const marker = `iso-${Date.now()}`

    const create = async (host: string, cookie: string, body: string) => {
      const res = await app.request('/api/modules/demo/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host, cookie },
        body: JSON.stringify({ body }),
      })
      expect(res.status, `POST note @${host} 应 201`).toBe(201)
      return (await res.json()).note as { id: number }
    }
    const acmeNote = await create('acme.test', acmeCookie, `acme-${marker}`)
    const betaNote = await create('beta.test', betaCookie, `beta-${marker}`)

    const listIds = async (host: string, cookie: string) => {
      const res = await app.request('/api/modules/demo/notes', {
        headers: { host, cookie },
      })
      expect(res.status).toBe(200)
      return ((await res.json()).notes as Array<{ id: number }>).map((n) => n.id)
    }
    const acmeIds = await listIds('acme.test', acmeCookie)
    const betaIds = await listIds('beta.test', betaCookie)

    // 正向：各自见自己（防「过滤成空集」的假绿——两边都空也能过反向断言）
    expect(acmeIds).toContain(acmeNote.id)
    expect(betaIds).toContain(betaNote.id)
    // 反向：互不可见（spec-1 §2 的核心断言）
    expect(acmeIds).not.toContain(betaNote.id)
    expect(betaIds).not.toContain(acmeNote.id)

    // 物理证据：行的 org 列确为写入者 org（列表断言可能被 limit 截断糊弄，这层糊弄不了）
    const pool = getPool({ databaseUrl: dbUrl! })
    const { rows } = await pool.query<{ id: number; org: string }>(
      'select id, org from demo.note where id = any($1::int[])',
      [[acmeNote.id, betaNote.id]],
    )
    const orgById = new Map(rows.map((r) => [r.id, r.org]))
    expect(orgById.get(acmeNote.id)).toBe('acme')
    expect(orgById.get(betaNote.id)).toBe('beta')
  })
})
