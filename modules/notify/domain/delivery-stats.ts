// delivery-stats.ts — 「谁收不到」的读面聚合（plan 2026-10-31 Phase 2 / issue #1225）。
//
// 为什么需要它：个人级失败（地址解析不出 / 收件人不在应用可见范围）今天散落在
// `notify.delivery.last_error` 里，逐条翻库才能发现。这里按 `(收件人, 渠道, 错误)` 聚合，
// 让「谁、为什么、多少次」一眼可见——**不改变投递行为**，纯读。
//
// 分类口径（不做模糊匹配猜服务商）：
//   · `unresolved` —— 我们自己的地址解析没出来（`missing_channel_address`）；
//   · `rejected`   —— 渠道明确拒收（企微 81013 / 60111 等「用户不在可见范围/不存在」）；
//   · `other`      —— 其它永久失败（归类但不猜原因）。
// 三类的处置不同：前者改配置，中者改可见范围，后者要看原文。
import type { Pool } from 'pg'

export type IssueKind = 'unresolved' | 'rejected' | 'other'

export interface AddressIssue {
  kind: IssueKind
  recipient: string
  channel: string
  code: string
  count: number
  lastAt: string
}

/** 企微「收件人本身不可用」的错误码族（81013 用户无效 / 60111 不存在 / 60020 IP 未信任）。 */
const REJECTED_PATTERNS = ['81013', '60111', '81012', '60020']

export function classifyDeliveryError(lastError: string): IssueKind {
  if (lastError === 'missing_channel_address') return 'unresolved'
  if (REJECTED_PATTERNS.some((p) => lastError.includes(p))) return 'rejected'
  return 'other'
}

/**
 * 最近 `hours` 小时内**永久失败**（status='dead'）按收件人聚合。
 * 只读 `dead`：可重试的失败还会自己恢复，混进来会制造噪音。
 */
export async function listAddressIssues(
  pool: Pool, org: string, hours = 24, limit = 50,
): Promise<AddressIssue[]> {
  const { rows } = await pool.query<{
    recipient: string; channel: string; last_error: string | null; n: number; last_at: Date
  }>(
    `select recipient, channel, last_error, count(*)::int as n, max(updated_at) as last_at
       from notify.delivery
      where org = $1 and status = 'dead' and updated_at > now() - ($2::int * interval '1 hour')
      group by recipient, channel, last_error
      order by n desc, last_at desc
      limit $3`,
    [org, hours, limit],
  )
  return rows.map((r) => {
    const code = r.last_error ?? 'unknown'
    return {
      kind: classifyDeliveryError(code),
      recipient: r.recipient,
      channel: r.channel,
      // 原文可能很长（企微带 hint 链接）——截断到可读区间，完整内容仍在 delivery.last_error
      code: code.length > 120 ? `${code.slice(0, 120)}…` : code,
      count: r.n,
      lastAt: new Date(r.last_at).toISOString(),
    }
  })
}
