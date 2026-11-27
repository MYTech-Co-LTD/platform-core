// attachment-cache.ts — 附件字节的懒加载 + 单次缓存（2026-11-27）。
//
// 目标（用户要求）：
//   · 工单列表/处理/详情弹窗只显示附件**元数据**，不加载任何字节；
//   · 只有打开附件预览弹窗时，才加载**当前那一个**附件；
//   · 每个附件在一次会话里只真正取一次：图片取成 Blob 后转 object URL 缓存；
//     视频缓存预签名 URL（不整段下载，浏览器按需流式播放）。
//
// 为什么图片必须走 Blob：每次 `GET /tickets/:id` 都会重新预签名，URL 的签名查询串不同；
// 直接把新 URL 塞进 `<img>` 会让浏览器按新 URL 重新下载。Blob object URL 与签名无关，
// 只要会话不结束就一直复用。
import { apiGet } from '../../lib/api'
import type { AttachmentDetail, TicketAttachment } from '../../../api-types'

/** 预签名 TTL 是 600s；缓存按 8 分钟兜底刷新（图片有 object URL 后不需要刷新）。 */
const URL_TTL_MS = 8 * 60 * 1000

interface CacheEntry {
  url: string
  expiresAt: number
  /** 仅图片：Blob object URL（会话内复用，pagehide 时 revoke）。 */
  objectUrl?: string
}

const cache = new Map<number, CacheEntry>()
const inflight = new Map<number, Promise<string>>()

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return entry !== undefined && entry.expiresAt > Date.now()
}

/** 走单附件端点取新预签名 URL（不依赖详情响应里可能已过期的 URL）。 */
async function freshUrl(id: number): Promise<string> {
  const d = await apiGet<AttachmentDetail>(`/attachments/${id}`)
  const entry = cache.get(id) ?? { url: d.url ?? '', expiresAt: 0 }
  entry.url = d.url ?? ''
  entry.expiresAt = Date.now() + URL_TTL_MS
  cache.set(id, entry)
  return entry.url
}

/** 图片：返回可放进 `<img src>` 的 object URL；同一 id 并发/重复调用只 fetch 一次。 */
export async function imageObjectUrl(item: TicketAttachment): Promise<string> {
  const hit = cache.get(item.id)
  if (hit?.objectUrl) return hit.objectUrl

  const existing = inflight.get(item.id)
  if (existing) return existing

  const task = (async () => {
    // 先用详情里的 URL（刚取详情，通常新鲜）；没有/过期就走单附件端点。
    let url = isFresh(hit) ? hit.url : (item.url ?? '')
    if (!url) url = await freshUrl(item.id)

    let res = await fetch(url)
    if (!res.ok) {
      // URL 过期/CORS 之外的 403 常见于签名过期：换一个再试一次。
      url = await freshUrl(item.id)
      res = await fetch(url)
    }
    if (!res.ok) throw new Error(`附件加载失败（HTTP ${res.status}）`)

    const objectUrl = URL.createObjectURL(await res.blob())
    const entry = cache.get(item.id) ?? { url, expiresAt: 0 }
    entry.url = url
    entry.expiresAt = Date.now() + URL_TTL_MS
    entry.objectUrl = objectUrl
    cache.set(item.id, entry)
    return objectUrl
  })()

  inflight.set(item.id, task)
  try {
    return await task
  } finally {
    inflight.delete(item.id)
  }
}

/** 视频：只返回预签名 URL（不整段下载）；缓存 URL，避免重复预签名/重复起播地址。 */
export async function videoUrl(item: TicketAttachment): Promise<string> {
  const hit = cache.get(item.id)
  if (isFresh(hit)) return hit.url
  if (item.url) {
    cache.set(item.id, { url: item.url, expiresAt: Date.now() + URL_TTL_MS })
    return item.url
  }
  return freshUrl(item.id)
}

/** 视频播放报错时强制换一个预签名 URL（不改 object URL；图片不需要）。 */
export async function refreshUrl(id: number): Promise<string> {
  return freshUrl(id)
}

/**
 * 打开处理弹窗后后台预缓存**图片**附件（视频不预拉字节）。
 *
 * 并发 4：一张失败只跳过该张（预览打开时仍会显示错误/重试），不影响其他张，也不阻塞表单。
 * 与预览共用同一个 inflight 去重：用户马上点预览时，等的也是这同一个 fetch，不会重复下载。
 */
export async function preloadImageAttachments(
  items: TicketAttachment[],
  concurrency = 4,
): Promise<void> {
  const images = items.filter((a) => a.contentType.startsWith('image/'))
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, images.length) },
    async () => {
      while (next < images.length) {
        const item = images[next++]
        try {
          await imageObjectUrl(item)
        } catch {
          // 单张失败不打断预缓存；预览打开时再显示错误与重试。
        }
      }
    },
  )
  await Promise.all(workers)
}

/** 仅供测试：清空缓存并 revoke 所有 object URL。 */
export function __resetAttachmentCacheForTests(): void {
  for (const e of cache.values()) if (e.objectUrl) URL.revokeObjectURL(e.objectUrl)
  cache.clear()
  inflight.clear()
}

if (typeof window !== 'undefined') {
  // 页面卸载才 revoke；关闭预览弹窗不 revoke——这就是「只加载一次」的缓存生命周期。
  window.addEventListener('pagehide', () => {
    for (const e of cache.values()) if (e.objectUrl) URL.revokeObjectURL(e.objectUrl)
    cache.clear()
  })
}
