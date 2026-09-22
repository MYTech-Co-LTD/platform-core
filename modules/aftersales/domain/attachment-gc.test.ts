import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import { ZosStorage } from '../storage'
import { gcSingleAttachment, runAttachmentGc, selectGcCandidates } from './attachment-gc'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-aftersales-gc'

const TENANT_CFG: TenantStorageConfig = {
  kind: 's3', endpoint: 'https://zos.tenant.test', region: 'xinan1',
  bucket: 'tenant-b1', accessKeyId: 'AKIATENANT', secretAccessKey: 'sk-tenant',
}
const PLATFORM_CFG: TenantStorageConfig = {
  kind: 's3', endpoint: 'https://zos.platform.test', region: 'xinan1',
  bucket: 'platform-b0', accessKeyId: 'AKIAPLAT', secretAccessKey: 'sk-plat',
}
const TENANT_REF = storageRefOf(TENANT_CFG)

/** 造一颗附件行。ageDays 回拨 created_at（GC 判龄靠它）；ticketId 非 null = 已认领。 */
async function seed(pool: Pool, key: string, ref: string, ageDays: number, ticketId: number | null = null): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `insert into aftersales.ticket_attachment(
       org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid, storage_ref, created_at)
     values ($1, $2, $3, $4, 'image/jpeg', 1, 'openid-x', $5, now() - ($6::int * interval '1 day'))
     returning id`,
    [ORG, ticketId, `cr-${key}`, `aftersales/${ORG}/${key}/u`, ref, ageDays],
  )
  return Number(r.rows[0].id)
}

/** 认领一颗附件（挂到 ticket 上）——需要一张真 ticket 行（FK）。 */
async function claim(pool: Pool, attachmentId: number): Promise<void> {
  const t = await pool.query<{ id: string }>(
    `insert into aftersales.ticket(org, source_id, code) values ($1, $2, 'AS-T') returning id`,
    [ORG, `src-${attachmentId}`],
  )
  await pool.query(`update aftersales.ticket_attachment set ticket_id = $2 where org = $1 and id = $3`,
    [ORG, Number(t.rows[0].id), attachmentId])
}

describePg('孤儿附件 GC（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  /** 记录桩：每颗被"删"的对象 (bucket, key)。 */
  const deleted: string[] = []
  const deleter = async (s: ZosStorage, key: string) => { deleted.push(`${(s as unknown as { config: { bucket: string } }).config.bucket}|${key}`) }
  /** resolver 按行上的 storage_ref 归桶（'' = 平台桶时代旧行，与读侧同语义）。 */
  const resolver = (ref: string): ZosStorage | null =>
    ref === '' ? new ZosStorage(PLATFORM_CFG) : ref === TENANT_REF ? new ZosStorage(TENANT_CFG) : null

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
    await pool.query('delete from aftersales.ticket where org = $1', [ORG])
    deleted.length = 0
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from aftersales.ticket where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('selectGcCandidates：只挑「未认领 + 超 N 天」，按 created_at 升序', async () => {
    await seed(pool, 'old-a', TENANT_REF, 8)
    await seed(pool, 'old-b', '', 30)
    await seed(pool, 'young', TENANT_REF, 6)          // 未超 7 天
    const claimedId = await seed(pool, 'claimed', TENANT_REF, 8)
    await claim(pool, claimedId)                       // 已认领 ⇒ 不算孤儿
    const cands = await selectGcCandidates(pool, ORG, 7, 100)
    expect(cands.map((c) => c.objectKey)).toEqual([
      `aftersales/${ORG}/old-b/u`,                     // 30 天 < 8 天 ⇒ 升序在前
      `aftersales/${ORG}/old-a/u`,
    ])
  })

  it('dryRun：只报告不动手——行全在、deleter 零调用', async () => {
    await seed(pool, 'old-a', TENANT_REF, 8)
    await seed(pool, 'old-b', '', 30)
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter }, { olderThanDays: 7, dryRun: true, limit: 100 })
    expect(report).toMatchObject({ dryRun: true, scanned: 2, eligible: 2, deletedObjects: 0, deletedRows: 0 })
    expect(report.skippedUnresolved).toEqual([])
    expect(deleted).toEqual([])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(2)
  })

  it('apply：删对象+删行；resolver 按行上的 ref 归桶（空串=平台桶）', async () => {
    await seed(pool, 'old-a', TENANT_REF, 8)
    await seed(pool, 'old-b', '', 30)
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter }, { olderThanDays: 7, dryRun: false, limit: 100 })
    expect(report).toMatchObject({ dryRun: false, deletedObjects: 2, deletedRows: 2 })
    expect(deleted.sort()).toEqual([
      `platform-b0|aftersales/${ORG}/old-b/u`,
      `tenant-b1|aftersales/${ORG}/old-a/u`,
    ].sort())
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(0)
  })

  it('ref 解析不出桶 ⇒ skippedUnresolved、行保留（删错桶=白删，宁可不动）', async () => {
    await seed(pool, 'ghost', 's3|https://zos.gone.test|gone-b', 8)
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter }, { olderThanDays: 7, dryRun: false, limit: 100 })
    expect(report.deletedObjects).toBe(0)
    expect(report.skippedUnresolved).toEqual([{ id: expect.any(Number), storageRef: 's3|https://zos.gone.test|gone-b' }])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })

  it('gcSingleAttachment：行已被认领 ⇒ claimed，对象零动作', async () => {
    const id = await seed(pool, 'late', TENANT_REF, 8)
    await claim(pool, id)   // 扫描之后、单行处理之前被认领——正是行锁重查要挡的竞态
    const client = await pool.connect()
    try {
      const r = await gcSingleAttachment(client, ORG,
        { id: String(id), objectKey: `aftersales/${ORG}/late/u`, storageRef: TENANT_REF, createdAt: new Date() },
        resolver, deleter)
      expect(r).toEqual({ outcome: 'claimed' })
    } finally { client.release() }
    expect(deleted).toEqual([])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })

  it('deleter 抛错 ⇒ error、行保留（回滚，下一轮重试）', async () => {
    await seed(pool, 'bad', TENANT_REF, 8)
    const boom = async () => { throw new Error('S3 down') }
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter: boom }, { olderThanDays: 7, dryRun: false, limit: 100 })
    expect(report.errors).toEqual([{ id: expect.any(Number), error: 'S3 down' }])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })
})
