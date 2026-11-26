// ticket-delete.ts — 工单批量删除（2026-11-26 / issue #2884，spec §2.7/§5.2）。
//
// 权限：manifest 把本端点声明在 `aftersales:delete` 下（**单独权限码**，默认无人持有；
// 不限状态）。门卫在宿主侧施加，本文件不写 requireScope。
//
// 失败模式（有意取舍，spec §5.2）：S3 删除不在数据库事务内 ⇒ 顺序是
//   ① 事务外：读该单全部附件并**逐行解析 storage_ref**——任一解析不出来 ⇒ 该单整体失败，
//      不做任何破坏性动作；
//   ② 事务内：锁行 → 删附件行 → 删工单 → 写审计 → 提交；
//   ③ 提交后：删对象。失败**不回滚**已提交的删除（否则就是「工单还在、附件打不开」的半删），
//      只记 warn + 追加一条 `ticket.delete.objects` 审计；残留的是**不可见的孤儿对象**，
//      后续可由附件 GC 扩展清理。
import { z } from 'zod'
import { TENANT_STORAGE } from '@platform/sdk'
import { storageCandidatesFor, storageResolverFor, warnUnresolvedRef } from '../storage'
import type { ZosStorage } from '../storage'
import { writeAudit } from '../domain/audit'
import type { ModuleHono, RouteCtx } from './context'

const BatchDeleteBody = z.object({
  // 1..100：与导出「选中」同一上限；去重后为空也非法。
  ids: z.array(z.number().int().positive().safe()).min(1).max(100),
})

interface DeleteFailure {
  id: number
  code: string
  error: 'NOT_FOUND' | 'STORAGE_UNRESOLVED' | 'DELETE_FAILED'
}

export function registerTicketDelete(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/tickets/batch-delete', async (c) => {
    const org = c.get('identity').orgId
    const actor = c.get('identity').userId

    const parsed = BatchDeleteBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const ids = [...new Set(parsed.data.ids)]

    const resolve = storageResolverFor(storageCandidatesFor(c.get(TENANT_STORAGE)))
    const deleted: number[] = []
    const failed: DeleteFailure[] = []

    for (const id of ids) {
      // ① 事务外：工单事实 + 附件清单 + 存储解析。解析失败 ⇒ 该单不动。
      const info = await ctx.pool.query<{ code: string; status: string; amount_minor: string }>(
        'select code, status, amount_minor from aftersales.ticket where org = $1 and id = $2',
        [org, id],
      )
      const ticket = info.rows[0]
      if (!ticket) {
        failed.push({ id, code: '', error: 'NOT_FOUND' })
        continue
      }

      const att = await ctx.pool.query<{ object_key: string; storage_ref: string }>(
        `select object_key, storage_ref from aftersales.ticket_attachment
          where org = $1 and ticket_id = $2 order by id`,
        [org, id],
      )
      const objects: { key: string; storage: ZosStorage }[] = []
      let unresolvedRef: string | null = null
      for (const a of att.rows) {
        const storage = resolve(a.storage_ref)
        if (!storage) {
          unresolvedRef = a.storage_ref
          break
        }
        objects.push({ key: a.object_key, storage })
      }
      if (unresolvedRef !== null) {
        warnUnresolvedRef(org, unresolvedRef)
        failed.push({ id, code: ticket.code, error: 'STORAGE_UNRESOLVED' })
        continue
      }

      // ② 事务内：锁行（防并发双删）→ 删附件行 → 删工单 → 审计。
      const client = await ctx.pool.connect()
      try {
        await client.query('begin')
        const lock = await client.query<{ id: string }>(
          'select id from aftersales.ticket where org = $1 and id = $2 for update',
          [org, id],
        )
        if (!lock.rows[0]) {
          await client.query('rollback')
          failed.push({ id, code: ticket.code, error: 'NOT_FOUND' })
          continue
        }
        await client.query('delete from aftersales.ticket_attachment where org = $1 and ticket_id = $2', [org, id])
        await client.query('delete from aftersales.ticket where org = $1 and id = $2', [org, id])
        await writeAudit(client, {
          org,
          actor,
          action: 'ticket.delete',
          target: ticket.code,
          // 金额摘要保留：工单行没了，至少审计里还能回答「删掉的是多少钱的单」。
          detail: { status: ticket.status, amountMinor: Number(ticket.amount_minor), attachments: objects.length },
        })
        await client.query('commit')
      } catch (err) {
        await client.query('rollback').catch(() => {})
        console.warn(`[aftersales] ticket delete failed id=${id}:`, err instanceof Error ? err.message : err)
        failed.push({ id, code: ticket.code, error: 'DELETE_FAILED' })
        continue
      } finally {
        client.release()
      }

      // ③ 提交后删对象：失败只告警 + 追加审计，不回滚（见文件头）。
      const objectDeleteFailures: string[] = []
      for (const o of objects) {
        try {
          await o.storage.deleteObject(o.key)
        } catch (err) {
          objectDeleteFailures.push(o.key)
          console.warn(`[aftersales] object delete failed key=${o.key}:`, err instanceof Error ? err.message : err)
        }
      }
      if (objectDeleteFailures.length > 0) {
        await writeAudit(ctx.pool, {
          org,
          actor,
          action: 'ticket.delete.objects',
          target: ticket.code,
          detail: { failures: objectDeleteFailures },
        }).catch((err: unknown) => {
          console.warn('[aftersales] object-delete audit failed（不影响已完成的删除）:', err instanceof Error ? err.message : err)
        })
      }
      deleted.push(id)
    }

    return c.json({ deleted, failed })
  })
}
