// credential-store.test.ts — 凭据解析顺序与 fail-closed（spec §3.2）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { resolveWecomCredential, upsertCredential, getCredentialMeta } from './credential-store'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-cred-store'
const KEK = 'c'.repeat(64)

describePg('credential-store', () => {
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

  const env = { NOTIFY_CRED_KEK: KEK }

  it('★ DB 优先：写入后按 DB 解析，且库里是密文', async () => {
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww123', agentId: '1000009', secret: 'plain-secret' }, 't', env)
    const raw = await pool.query('select secret_enc from notify.channel_credential where org=$1 and provider=$2', [ORG, 'wecom'])
    expect(String(raw.rows[0].secret_enc)).not.toContain('plain-secret')
    const r = await resolveWecomCredential(pool, ORG, env)
    expect(r).toMatchObject({ ok: true, source: 'db', cred: { corpId: 'ww123', agentId: '1000009', secret: 'plain-secret' } })
    expect(await getCredentialMeta(pool, ORG, 'wecom')).toMatchObject({ appKey: 'ww123' })
  })

  it('★ DB 无行 ⇒ env 兜底（corpId|agentId|secret）', async () => {
    const r = await resolveWecomCredential(pool, ORG, { ...env, WECOM_DIRECT__ORG_CRED_STORE: 'ww9|100|sec' })
    expect(r).toMatchObject({ ok: true, source: 'env', cred: { corpId: 'ww9', agentId: '100', secret: 'sec' } })
  })

  it('★ 都没有 ⇒ missing（**不静默降级**，调用方落 credential_missing）', async () => {
    expect(await resolveWecomCredential(pool, ORG, env)).toEqual({ ok: false, reason: 'missing' })
  })

  it('★ env 格式不对 ⇒ env_malformed', async () => {
    const r = await resolveWecomCredential(pool, ORG, { ...env, WECOM_DIRECT__ORG_CRED_STORE: 'only-two|parts' })
    expect(r).toMatchObject({ ok: false, reason: 'env_malformed' })
  })

  it('★ KEK 缺失时写不进去（绝不落明文）', async () => {
    await expect(
      upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 'x' }, 't', {}),
    ).rejects.toThrow(/NOTIFY_CRED_KEK/)
    const n = await pool.query('select count(*)::int n from notify.channel_credential where org=$1', [ORG])
    expect(n.rows[0].n).toBe(0)
  })

  it('★ 库里有密文但 KEK 不对 ⇒ decrypt_failed（不是 missing）', async () => {
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww1', agentId: '1', secret: 'x' }, 't', env)
    const r = await resolveWecomCredential(pool, ORG, { NOTIFY_CRED_KEK: 'd'.repeat(64) })
    expect(r).toMatchObject({ ok: false, reason: 'decrypt_failed' })
  })
})
