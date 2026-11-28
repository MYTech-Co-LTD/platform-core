// labels.ts — 工单页的文案与语义色（列表 / 详情 / 导出共用）。
import type { StoreAffiliation, SubmissionQuality, TicketStatus } from '../../../api-types'
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

/** 售后提报规范性（2026-11-28）：处理时必选，**门店侧不可见**。空串 = 未评价。 */
export const QUALITY_LABEL: Record<SubmissionQuality, string> = {
  normal: '正常提交',
  false_claim: '虚假报损',
  late: '逾期提报',
  duplicate: '重复提报',
  incomplete: '材料不完整',
}

/** Select 选项（保持与 QUALITY_LABEL 同一顺序与文案，别写第二份）。 */
export const QUALITY_OPTIONS = (Object.keys(QUALITY_LABEL) as SubmissionQuality[])
  .map((value) => ({ value, label: QUALITY_LABEL[value] }))
