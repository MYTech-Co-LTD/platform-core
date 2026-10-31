// channel-config.test.ts — 「配置好了吗」的判据随 transport 变（spec 2026-10-31 §3.5）
//
// 为什么值得单测：`configured` 是**交付性预检**的输入。直连通道若沿用桥的判据
// （secret_refs 的 env 齐不齐），已配好的直连会被判 `unconfigured` ⇒ 规则被判不可送达。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { channelIsConfigured } from './channel-config'
import { upsertCredential } from './credential-store'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-chan-cfg'
const KEK = 'f'.repeat(64)
const env = { NOTIFY_CRED_KEK: KEK }

describePg('channelIsConfigured', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from notify.channel_credential where org=$1', [ORG]).catch(() => {})
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from notify.channel_credential where org=$1', [ORG])
  })

  const ch = (config: Record<string, unknown>, secretRefs: Record<string, string> = {}) =>
    ({ provider: 'wecom_chat', config, secret_refs: secretRefs })

  it('★ 直连：有凭据即 configured（**不要求桥的 env**）', async () => {
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 's' }, 't', env)
    expect(await channelIsConfigured(pool, ORG, ch({ transport: 'direct' }, { bridge_url: 'MISSING' }), env)).toBe(true)
  })

  it('★ 直连：没凭据 ⇒ 不 configured（不是「桥的 env 有就行」）', async () => {
    expect(await channelIsConfigured(pool, ORG, ch({ transport: 'direct' }, { bridge_url: 'X' }), { ...env, X: 'v' })).toBe(false)
  })

  it('桥（缺省）：仍看 secret_refs 的 env（与改造前逐字一致）', async () => {
    expect(await channelIsConfigured(pool, ORG, ch({}, { bridge_url: 'X' }), { X: 'v' })).toBe(true)
    expect(await channelIsConfigured(pool, ORG, ch({ transport: 'bridge' }, { bridge_url: 'X' }), {})).toBe(false)
  })
})
