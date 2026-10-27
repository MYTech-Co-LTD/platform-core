// channel-address.test.ts — Casdoor 用户 → 渠道地址（2026-10-27 通知基础设施 §4.3）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { createChannelAddressResolver } from './channel-address'
import { runMigrations } from './migrate'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

describePg('channel-address', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => {
    await pool.query("delete from platform.identity_link where org='org-ca'")
    await pool.end()
  })

  it('wecom 走 identity_link；无绑定/跨 org 返回 null；in_app 用 Casdoor 名', async () => {
    await pool.query("delete from platform.identity_link where org='org-ca'")
    await pool.query(
      `insert into platform.identity_link(org,provider,external_id,casdoor_name,status,bound_via)
       values ('org-ca','wecom','wecom-u1','u1','active','manual')`,
    )

    const r = createChannelAddressResolver({ pool })
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u1' })).toBe('wecom-u1')
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u2' })).toBeNull()
    expect(await r.resolve({ org: 'org-other', provider: 'wecom_chat', casdoorName: 'u1' })).toBeNull()
    expect(await r.resolve({ org: 'org-ca', provider: 'in_app', casdoorName: 'u1' })).toBe('u1')
    expect(await r.resolve({ org: 'org-ca', provider: 'webhook', casdoorName: 'u1' })).toBeNull()
  })

  it('只认 active 绑定（pending/revoked 不解析）', async () => {
    await pool.query("delete from platform.identity_link where org='org-ca'")
    await pool.query(
      `insert into platform.identity_link(org,provider,external_id,casdoor_name,status,bound_via)
       values ('org-ca','wecom','wecom-p','u-p','pending','manual')`,
    )
    const r = createChannelAddressResolver({ pool })
    expect(await r.resolve({ org: 'org-ca', provider: 'wecom_chat', casdoorName: 'u-p' })).toBeNull()
  })
})
