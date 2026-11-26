// export.ts — 工单导出的浏览器侧编排（2026-11-26 / #2884，spec §2.6/§3.8/§5.1）。
//
// 分工：
//   · Excel 由服务端生成（`GET /tickets/export`）；
//   · 附件清单由服务端给**预签名 URL**（`GET /tickets/export-manifest`），浏览器**直连对象存储**
//     下载——应用服务器出口只有 5–6 Mbps，走它会把大包拖成分钟级；
//   · 打包在浏览器里用 fflate（store 级别，图片/视频本来就压缩过，再压是白费 CPU）。
import { zip } from 'fflate'
import { apiBlob, apiGet } from '../../lib/api'
import type { ExportManifest } from '../../../api-types'
import type { TicketFilters } from './query'

export type ExportRange = 'selected' | 'filtered' | 'all'

export type ExportPhase = 'manifest' | 'excel' | 'attachments' | 'zip'
export interface ExportProgress {
  phase: ExportPhase
  done?: number
  total?: number
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

/** 附件总量上限（前端预估 `sizeBytes` 之和）：超过就提示分次导出，别把浏览器内存打爆。 */
export const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

function extOf(contentType: string): string {
  return EXT[contentType.split(';')[0].trim().toLowerCase()] ?? 'bin'
}

function buildQuery(
  range: ExportRange,
  ids: number[],
  filters: TicketFilters,
  columns?: string[],
): string {
  const qs = new URLSearchParams({ range })
  if (range === 'selected') qs.set('ids', ids.join(','))
  if (range === 'filtered') {
    for (const key of ['status', 'brand', 'code', 'product', 'store', 'relatedOrder', 'opinion',
      'processedFrom', 'processedTo'] as const) {
      if (filters[key]) qs.set(key, filters[key])
    }
  }
  if (columns && columns.length > 0) qs.set('columns', columns.join(','))
  return qs.toString()
}

function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 立刻 revoke 会让部分浏览器来不及取数据；下一个宏任务再收。
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

export interface RunExportOptions {
  range: ExportRange
  ids: number[]
  filters: TicketFilters
  columns: string[]
  includeAttachments: boolean
  onProgress?: (p: ExportProgress) => void
}

/**
 * 执行导出。返回实际下载的文件名（便于测试/提示）；用户取消或失败时抛 `ExportError`。
 *
 * `selected` 的 ids 来自当前页勾选（≤100）；`filtered` 带当前筛选；`all` 不带筛选。
 */
export async function runExport(o: RunExportOptions): Promise<string> {
  if (o.range === 'selected' && o.ids.length === 0) {
    throw new ExportError('没有选中的工单')
  }

  o.onProgress?.({ phase: 'excel' })
  const xlsx = await apiBlob(`/tickets/export?${buildQuery(o.range, o.ids, o.filters, o.columns)}`)
  const xlsxName = xlsx.filename ?? '售后工单.xlsx'

  if (!o.includeAttachments) {
    downloadBlob(xlsx.blob, xlsxName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    return xlsxName
  }

  o.onProgress?.({ phase: 'manifest' })
  const manifest = await apiGet<ExportManifest>(
    `/tickets/export-manifest?${buildQuery(o.range, o.ids, o.filters)}`,
  )

  const files: Record<string, Uint8Array> = {
    [xlsxName]: new Uint8Array(await xlsx.blob.arrayBuffer()),
  }
  const downloadable = manifest.tickets.flatMap((t) =>
    t.attachments
      .filter((a) => a.url !== null)
      .map((a) => ({ code: t.code || String(t.id), attachment: a })),
  )

  const totalBytes = downloadable.reduce((sum, x) => sum + x.attachment.sizeBytes, 0)
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new ExportError('附件总量超过 500 MB，请缩小范围或分次导出')
  }

  // 每单从 001 编号（zip 内按单分目录）。
  const perTicket = new Map<string, number>()
  o.onProgress?.({ phase: 'attachments', done: 0, total: downloadable.length })
  for (let i = 0; i < downloadable.length; i++) {
    const { code, attachment } = downloadable[i]!
    const res = await fetch(attachment.url as string)
    if (!res.ok) throw new ExportError(`附件下载失败：${code}（HTTP ${res.status}）`)
    const n = (perTicket.get(code) ?? 0) + 1
    perTicket.set(code, n)
    const name = `${code}/${String(n).padStart(3, '0')}.${extOf(attachment.contentType)}`
    files[name] = new Uint8Array(await res.arrayBuffer())
    o.onProgress?.({ phase: 'attachments', done: i + 1, total: downloadable.length })
  }

  o.onProgress?.({ phase: 'zip', done: downloadable.length, total: downloadable.length })
  const zipped = await zipAsync(files)
  const zipName = xlsxName.replace(/\.xlsx$/i, '') + '.zip'
  downloadBlob(zipped, zipName, 'application/zip')
  return zipName
}
