// query.ts — 工单页的筛选状态与查询串（页面 / 导出共用一份）。
//
// 为什么单独一个文件：列表查询与导出清单必须用**同一套参数名**。各写一份的典型症状是
// 「列表筛了 3 条，导出却是 5 条」——参数名拼错不会报错，只会静默不过滤。
import type { TicketStatus } from '../../../api-types'

export interface TicketFilters {
  status: '' | TicketStatus
  /** 品牌 code，或 `__unclassified__`；空串 = 不筛 */
  brand: string
  code: string
  product: string
  store: string
  relatedOrder: string
  opinion: string
  /** `YYYY-MM-DD`；按 Asia/Shanghai 整天、两端都含（服务端语义） */
  processedFrom: string
  processedTo: string
}

export const EMPTY_FILTERS: TicketFilters = {
  status: '',
  brand: '',
  code: '',
  product: '',
  store: '',
  relatedOrder: '',
  opinion: '',
  processedFrom: '',
  processedTo: '',
}

/** 只把**非空**条件写进查询串——空值传过去服务端也会忽略，但会让 URL 变脏、测试断言变脆。 */
export function ticketQuery(f: TicketFilters, page?: number, size?: number): string {
  const qs = new URLSearchParams()
  for (const key of ['status', 'brand', 'code', 'product', 'store', 'relatedOrder', 'opinion',
    'processedFrom', 'processedTo'] as const) {
    const value = f[key]
    if (value) qs.set(key, value)
  }
  if (page !== undefined) qs.set('page', String(page))
  if (size !== undefined) qs.set('size', String(size))
  return qs.toString()
}
