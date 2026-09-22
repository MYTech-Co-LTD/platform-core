// attachment-gc.ts — 孤儿附件 GC（spec §5 #12；拍板：openship job 定时打 manage 面端点触发）。
//
// 孤儿 = ticket_attachment.ticket_id is null 的行：预签名先于工单落库，行先落在 client_request_id
// 上（spec §2.3）；访客传图未提交/提交失败放弃 ⇒ 行与桶对象永存。2026-09-16 上线后验证实测：
// 此前模块无任何删除路径。GC 由 DB 行驱动（对象 key 不含工单信息，只能由行的 object_key 反查，
// spec §5 #12）——不做桶侧 ListObjects 对账。
//
// 删除顺序（见计划 Task 1 的裁决，勿"优化"）：行锁先行（FOR UPDATE + ticket_id is null 谓词）
// → 删对象（夹在事务里，失败即回滚）→ 删行 → COMMIT。崩溃后重跑安全（S3 delete 幂等 204）。
import type { Pool, PoolClient } from 'pg'
import type { ZosStorage } from '../storage'

export const GC_DEFAULT_OLDER_THAN_DAYS = 7
export const GC_DEFAULT_LIMIT = 200
export const GC_MAX_LIMIT = 1000

export interface GcCandidate { id: string; objectKey: string; storageRef: string; createdAt: Date }
export interface GcReport {
  dryRun: boolean
  scanned: number
  eligible: number
  deletedObjects: number
  deletedRows: number
  skippedUnresolved: { id: number; storageRef: string }[]
  errors: { id: number; error: string }[]
}
export interface GcDeps {
  pool: Pool
  org: string
  resolver: (ref: string) => ZosStorage | null
  deleter: (s: ZosStorage, key: string) => Promise<void>
}
export interface GcOptions { olderThanDays: number; dryRun: boolean; limit: number }

export async function selectGcCandidates(
  pool: Pool, org: string, olderThanDays: number, limit: number,
): Promise<GcCandidate[]> {
  const r = await pool.query<{ id: string; object_key: string; storage_ref: string; created_at: Date }>(
    `select id, object_key, storage_ref, created_at
       from aftersales.ticket_attachment
      where org = $1 and ticket_id is null
        and created_at < now() - ($2::int * interval '1 day')
      order by created_at asc
      limit $3`,
    [org, olderThanDays, limit],
  )
  return r.rows.map((row) => ({
    id: row.id, objectKey: row.object_key, storageRef: row.storage_ref, createdAt: row.created_at,
  }))
}

export type GcSingleResult =
  | { outcome: 'deleted' } | { outcome: 'claimed' } | { outcome: 'unresolved' }
  | { outcome: 'error'; message: string }

/**
 * 单行 GC（事务级行锁先行）。四种结局：
 *  deleted=行+对象都已删；claimed=行锁重查发现已被认领（什么都不动）；
 *  unresolved=storage_ref 解析不出桶（行保留——删错桶=白删）；error=删对象失败（行保留，重试）。
 */
export async function gcSingleAttachment(
  client: PoolClient, org: string, cand: GcCandidate,
  resolver: GcDeps['resolver'], deleter: GcDeps['deleter'],
): Promise<GcSingleResult> {
  await client.query('begin')
  try {
    // 行锁 + 认领重查（一查两得）：锁到本行处理完为止；谓词与扫描同源（ticket_id is null）
    const lock = await client.query(
      `select id from aftersales.ticket_attachment
        where org = $1 and id = $2 and ticket_id is null
        for update`,
      [org, cand.id],
    )
    if ((lock.rowCount ?? 0) === 0) { await client.query('commit'); return { outcome: 'claimed' } }

    const storage = resolver(cand.storageRef)
    if (!storage) { await client.query('commit'); return { outcome: 'unresolved' } }

    try {
      await deleter(storage, cand.objectKey)
    } catch (err) {
      await client.query('rollback')
      return { outcome: 'error', message: err instanceof Error ? err.message : String(err) }
    }

    await client.query(
      `delete from aftersales.ticket_attachment where org = $1 and id = $2 and ticket_id is null`,
      [org, cand.id],
    )
    await client.query('commit')
    return { outcome: 'deleted' }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    return { outcome: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export async function runAttachmentGc(deps: GcDeps, opts: GcOptions): Promise<GcReport> {
  const cands = await selectGcCandidates(deps.pool, deps.org, opts.olderThanDays, opts.limit)
  const report: GcReport = {
    dryRun: opts.dryRun, scanned: cands.length, eligible: cands.length,
    deletedObjects: 0, deletedRows: 0, skippedUnresolved: [], errors: [],
  }
  if (opts.dryRun) return report   // 只报告不动手（端点的安全缺省）

  const client = await deps.pool.connect()
  try {
    for (const cand of cands) {
      const r = await gcSingleAttachment(client, deps.org, cand, deps.resolver, deps.deleter)
      if (r.outcome === 'deleted') { report.deletedObjects += 1; report.deletedRows += 1 }
      else if (r.outcome === 'unresolved') report.skippedUnresolved.push({ id: Number(cand.id), storageRef: cand.storageRef })
      else if (r.outcome === 'error') report.errors.push({ id: Number(cand.id), error: r.message })
      // claimed：行已被认领，不是异常，不记账
    }
  } finally {
    client.release()
  }
  return report
}
