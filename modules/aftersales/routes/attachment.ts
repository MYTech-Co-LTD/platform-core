import { z } from 'zod'
import { TENANT_STORAGE, storageRefOf } from '@platform/sdk'
import {
  UPLOAD_URL_TTL_SECONDS,
  objectKeyFor,
  storageCandidatesFor,
  storageFor,
  storageResolverFor,
  warnUnresolvedRef,
} from '../storage'
import {
  GC_DEFAULT_LIMIT, GC_DEFAULT_OLDER_THAN_DAYS, GC_MAX_LIMIT, runAttachmentGc,
} from '../domain/attachment-gc'
import { parseIdParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/**
 * 只收图片与视频（白名单，不是黑名单）。
 * 理由不是"分类整洁"：预签名 GET 的 URL 一旦泄露，对象的实际内容由上传者决定，
 * 而桶域是独立源。收窄入口是这一层唯一能做的把关（`text/html` 一类不给进）。
 */
const ALLOWED_PREFIXES = ['image/', 'video/']
/** 导出是为了让测试直接引用这个上界（`M-5`）——在测试里重写一遍字面量就是第二个事实源。 */
export const MAX_DECLARED_BYTES = 500 * 1024 * 1024 // 500MB，仅作明显误报的护栏，见下方注释

const UploadRequest = z.object({
  /** 客户端幂等键——同时是 object key 的 {ticket_ref} 段（spec §2.3） */
  clientRequestId: z.string().min(1).max(128),
  contentType: z.string().min(1).max(200),
  /** 客户端自报大小。见 handler 里的【已知边界】注释：这是展示用的，不是强制。 */
  sizeBytes: z.number().int().nonnegative().max(MAX_DECLARED_BYTES).optional(),
})

export function registerAttachmentGuest(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/guest/attachments', async (c) => {
    const identity = c.get('identity')
    const parsed = UploadRequest.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { clientRequestId, contentType, sizeBytes } = parsed.data

    if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) {
      return c.json({ error: 'UNSUPPORTED_CONTENT_TYPE', contentType }, 400)
    }

    // 没配存储 ⇒ 服务端算不出预签名 URL。回 503 而不是 500，也不是假装成功——
    // 前者说"这个能力此刻不可用"，后者会在客户端留下一张永远传不上去的工单。
    //
    // ⚠️ 写侧**只认本请求注入的配置**（`TENANT_STORAGE`），**绝不**回落到平台默认：
    // 租户配置「部分填写」时宿主不注入，此时若拿平台桶兜底 = 把本该报错的状态**静默写进平台桶**
    // （数据位置被误述 + 平台替租户承担成本）。这正是裁定 4 的 fail-explicit：**写侧不猜**。
    const cfg = c.get(TENANT_STORAGE)
    if (!cfg) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)
    const storage = storageFor(cfg)

    const objectKey = objectKeyFor(identity.orgId, clientRequestId)
    // 先取得预签名、再落元数据。顺序是刻意的：预签名会抛（凭证错 / 网络错），
    // 若先 INSERT 再签名，每次故障都在库里留一行【无主孤儿】——异常正常上抛，缺的是原子性。
    // presignPut 的入参只有 objectKey/contentType，**不依赖刚落的行** ⇒ 提前是免费的改善。
    // 字节从客户端直传 ZOS，全程不过平台（spec §2.3）；
    // 这一步【不校验对象是否真的传上来了】——预签名 PUT 是"给了一张票"，不是"票已核销"。
    // 是否真有字节，只有在读取时才知道（见下方【已知边界】）。
    const uploadUrl = await storage.presignPut(objectKey, contentType)
    const res = await ctx.pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(
         org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid, storage_ref)
       values ($1, null, $2, $3, $4, $5, $6, $7) returning id`,
      // storage_ref 是纯函数产物（不含凭据）——读侧全靠它把这一行归回当时的桶
      [identity.orgId, clientRequestId, objectKey, contentType, sizeBytes ?? 0, identity.userId, storageRefOf(cfg)],
    )

    return c.json(
      {
        id: Number(res.rows[0].id),
        objectKey,
        uploadUrl,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        // 【已知边界，写在这里让调用方看得见】客户端自报的 sizeBytes 是【建议值】：
        // 预签名 PUT 只约束 key 与 Content-Type，不约束长度——服务端没签 Content-Length，
        // 也没法在直传链路上拦（字节根本不过我们）。真正的体积上限要靠 ZOS 侧的桶策略
        // 或后端异步校验，M2a 不含。前端应把它当提示，不要当前置条件。
        sizeBytesAdvisory: true,
      },
      201,
    )
  })
}

export function registerAttachmentManage(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/attachments/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const res = await ctx.pool.query(
      `select id, ticket_id, object_key, content_type, size_bytes, uploader_openid, created_at, storage_ref
         from aftersales.ticket_attachment where org = $1 and id = $2`,
      [org, id],
    )
    const row = res.rows[0]
    // 跨租户取别人的附件同样是 404：与不存在同形
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)

    // 用**行上记录的**配置签名，不是「当前配置」（见 003 迁移的列注释：换桶后拿当前配置硬签
    // 会签出一个指向别的桶的 URL，客户端 NoSuchKey、平台侧零信号）
    const cands = storageCandidatesFor(c.get(TENANT_STORAGE))
    const storage = storageResolverFor(cands)(row.storage_ref as string)
    // 两种「签不出来」的语义必须分开（同形的话，运维分不清「本租户压根没配」与「配置换过、旧桶读不了」）：
    //   · 一个候选都没有（未配且无平台默认 / 部分填写）⇒ ZOS_NOT_CONFIGURED（与改动前逐字同形）
    //   · 有候选但该行的 ref 都对不上 ⇒ STORAGE_REF_UNRESOLVED（**显式失败**，绝不硬签）
    if (!storage) {
      const ref = row.storage_ref as string
      if (cands.all.length > 0) warnUnresolvedRef(org, ref)
      return c.json({ error: cands.all.length > 0 ? 'STORAGE_REF_UNRESOLVED' : 'ZOS_NOT_CONFIGURED' }, 503)
    }

    return c.json({
      id: Number(row.id),
      ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
      objectKey: row.object_key,
      contentType: row.content_type,
      // bigint 是字符串——见 domain/ticket.ts 的说明
      sizeBytes: Number(row.size_bytes),
      uploaderOpenid: row.uploader_openid,
      createdAt: row.created_at,
      url: await storage.presignGet(row.object_key as string),
    })
  })
}

/** GC 请求体：全可选、缺省安全（dry-run）。olderThanDays 上界 10 年防误输。 */
const GcBody = z.object({
  olderThanDays: z.number().int().min(1).max(3650).optional(),
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).max(GC_MAX_LIMIT).optional(),
})

/** 孤儿附件 GC（spec §5 #12；拍板：openship job 定时打本端点触发）。manage 面。 */
export function registerAttachmentGc(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/attachments/gc', async (c) => {
    const org = c.get('identity').orgId
    const parsed = GcBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const opts = {
      olderThanDays: parsed.data.olderThanDays ?? GC_DEFAULT_OLDER_THAN_DAYS,
      // 破坏性操作安全缺省：dry-run。生产 openship job 显式传 dryRun:false。
      dryRun: parsed.data.dryRun ?? true,
      limit: parsed.data.limit ?? GC_DEFAULT_LIMIT,
    }
    // 候选集合与读侧同源（storageCandidatesFor 含平台默认）：孤儿行大多写在平台桶时代；
    // 删对象必须按行上的 storage_ref 归桶（删错桶=白删）。
    const cands = storageCandidatesFor(c.get(TENANT_STORAGE))
    if (cands.all.length === 0) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)
    const report = await runAttachmentGc(
      { pool: ctx.pool, org, resolver: storageResolverFor(cands), deleter: (s, key) => s.deleteObject(key) },
      opts,
    )
    return c.json(report)
  })
}
