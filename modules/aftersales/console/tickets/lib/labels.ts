// labels.ts — 工单页的文案与语义色（列表 / 详情 / 导出共用）。
import type { Brand, StoreAffiliation, TicketStatus } from '../../../api-types'
import type { Tone } from '../../lib/ui'

export const STATUS_LABEL: Record<TicketStatus, string> = {
  pending: '待处理',
  completed: '已处理',
  cancelled: '已驳回',
}

export const STATUS_TONE: Record<TicketStatus, Tone> = {
  pending: 'warn',
  completed: 'ok',
  cancelled: 'danger',
}

/** 品牌胶囊只展示这两个（无品牌前缀的 65 家门店不进品牌筛选，spec §0）。 */
export const BRAND_LABEL: Record<Exclude<Brand, ''>, string> = {
  xiongmao: '熊喵',
  pptd: '品品甜',
}

export const BRAND_TONE: Record<Exclude<Brand, ''>, Tone> = {
  xiongmao: 'ok',
  pptd: 'warn',
}

/** 归属一致性（ADR 2026-11-24 §7 P1-a）：信息性展示，不参与放行判定。 */
export const AFFIL_LABEL: Record<StoreAffiliation, { label: string; tone: Tone }> = {
  matched: { label: '一致', tone: 'ok' },
  mismatch: { label: '门店不一致', tone: 'danger' },
  unregistered: { label: '未登记', tone: 'warn' },
}

export const AMOUNT_TYPE_LABEL: Record<'ratio' | 'fixed' | 'reject', string> = {
  ratio: '按比例',
  fixed: '固定金额',
  reject: '驳回',
}
