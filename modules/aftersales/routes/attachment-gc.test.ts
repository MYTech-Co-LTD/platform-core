import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { TenantStorageConfig } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-aftersales-gc-route'
const TENANT_CFG: TenantStorageConfig = {
  kind: 's3', endpoint: 'https://zos.tenant.test', region: 'xinan1',
  bucket: 'tenant-b1', accessKeyId: 'AKIATENANT', secretAccessKey: 'sk-tenant',
}
const post = (body: unknown) => ({
  method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describePg('POST /attachments/gc（manage 面）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ctx = { pool }
  const app = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }), ctx, TENANT_CFG)

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('body 非法（olderThanDays=0）→ 400 INVALID_BODY', async () => {
    const res = await app.request('/attachments/gc', post({ olderThanDays: 0 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })

  it('缺省即 dry-run：POST {} → 200 且 dryRun=true，一行都不动', async () => {
    await pool.query(
      `insert into aftersales.ticket_attachment(org, client_request_id, object_key, storage_ref, created_at)
       values ($1, 'cr-1', 'aftersales/x/1/u', '', now() - interval '30 day')`, [ORG])
    const res = await app.request('/attachments/gc', post({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ dryRun: true, scanned: 1, eligible: 1, deletedRows: 0 })
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })

  it('一个存储候选都没有 → 503 ZOS_NOT_CONFIGURED（与读侧同形）', async () => {
    // 不注入存储配置（第 4 参缺省）且把平台 env 五键 stub 成空串 ⇒ platformStorageFromEnv 为
    // null ⇒ storageCandidatesFor().all 为空。stub 成空串是为了在「本机恰好 export 过真值」时也确定。
    for (const k of ['AFTERSALES_ZOS_ENDPOINT', 'AFTERSALES_ZOS_REGION', 'AFTERSALES_ZOS_BUCKET',
                     'AFTERSALES_ZOS_ACCESS_KEY', 'AFTERSALES_ZOS_SECRET']) vi.stubEnv(k, '')
    const bare = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }), ctx)
    const res = await bare.request('/attachments/gc', post({}))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('ZOS_NOT_CONFIGURED')
    vi.unstubAllEnvs()
  })
})
