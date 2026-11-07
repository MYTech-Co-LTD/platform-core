// mine.ts —— 一轮挖掘：读水位 → 拉两源 → 判定 → upsert → 成功后推进水位。
// 全部 IO 注入（MineIo），因此单测不连库不连网；CLI 组装真实现（scripts/demand-mining.mjs）。
import { classifyAudit, huntFromConvs, isProbeTarget } from './classify'
import type { AuditRow, ConvRow, DemandDraft } from './classify'
import type { CursorSource } from './store'

export interface MineIo {
  readCursor(org: string, source: CursorSource): Promise<number>
  writeCursor(org: string, source: CursorSource, value: number): Promise<void>
  /**
   * `sinceId` 是**不含**的（SQL 用 `id > sinceId`）。
   * 返回值只承诺「本批读到的行」——水位由调用方从这些行推导，**不接受**读侧另报 maxId：
   * 读行带 `limit`、maxId 若取全表 max 就会越过未读行（静默丢行），故接口里没有这个字段。
   */
  readAudit(org: string, sinceId: number): Promise<AuditRow[]>
  /** `sinceUs` 在非 0 时是**不含**的（SQL 用 `_timestamp > sinceUs`），见下方水位推导。 */
  readConv(org: string, sinceUs: number): Promise<ConvRow[]>
  readStuck(org: string, sessionIds: readonly string[]): Promise<Map<string, unknown[]>>
  catalogIds(org: string): Promise<string[]>
  upsert(org: string, draft: DemandDraft): Promise<void>
}

export interface MineSummary {
  scanned: number; alias: number; newMetric: number; drill: number; hunt: number
  skippedProbe: number; cursorAudit: number; cursorConv: number
  /** true = 本轮**没有**挖对话侧（多租户部署无归因字段）；不是「挖了 0 条」。 */
  convSkipped?: boolean
}

export interface MineOptions {
  /**
   * 跳过对话侧（`askdata_trace` / `askdata_stuck`）。
   *
   * 为什么需要：这两个 OO 流**没有租户字段**（2026-11-07 实测 schema）。多租户部署里
   * 同一部署的对话流无法归因到某个 org ⇒ 只能跳过并显式标记，不能把别家的会话算到本 org。
   */
  skipConv?: boolean
}

/**
 * 一轮。顺序：先审计（驱动 skip 计数），再 conv（要会话 → 拉 stuck 证据）。
 *
 * 水位语义：**每个源在自己的行全部 upsert 成功后立刻推进**，互不拖累——
 * OO 连续不可用时，审计侧已落库的计数不会被下轮重读重算。
 *
 * 两个源都取「本批实际读到的行」推导水位，且 conv 用**排他游标**（`> cursor`，游标写本批 max）：
 * 边界组（`_timestamp == max`）不再重读，因此不会每轮给同一个 `(session, 窗口)` 重复 +1 occurrences。
 * 代价是**同微秒迟到的行会漏**——OO 的 `_timestamp` 是入库时间，同一批入库可能共享微秒；
 * 这里选择「不重复计数」而不是「绝不漏一行」。**不要写 `max+1`**：那会额外排除 `max` 与 `max+1`
 * 两档，凭空制造 1 微秒盲区，却不再带来任何额外收益。
 */
export async function mineOnce(
  io: MineIo, org: string, nowUs: number, opts: MineOptions = {},
): Promise<MineSummary> {
  const catalog = await io.catalogIds(org)
  const summary: MineSummary = {
    scanned: 0, alias: 0, newMetric: 0, drill: 0, hunt: 0, skippedProbe: 0,
    cursorAudit: await io.readCursor(org, 'query_audit'),
    cursorConv: await io.readCursor(org, 'askdata_conv'),
  }

  const audit = await io.readAudit(org, summary.cursorAudit)
  summary.scanned += audit.length
  for (const row of audit) {
    const draft = classifyAudit(row, catalog)
    if (draft === null) {
      // 只统计「本该是需求、但被探针前缀挡掉」的行；bad_param 等本来就不是需求，不计。
      const t = String(row.metric_id ?? '')
      if ((row.reason === 'metric_not_declared' || row.reason === 'no_detail_binding') && isProbeTarget(t)) {
        summary.skippedProbe += 1
      }
      continue
    }
    await io.upsert(org, draft)
    if (draft.kind === 'alias_gap') summary.alias += 1
    else if (draft.kind === 'new_metric') summary.newMetric += 1
    else summary.drill += 1
  }
  // 水位只由**本批读到的行**推导（不能用全表 max：读行有 limit，会越过未读行）。
  const auditIds = audit.map((r) => Number(r.id)).filter((n) => Number.isFinite(n))
  summary.cursorAudit = auditIds.length > 0 ? Math.max(...auditIds) : summary.cursorAudit
  // 审计侧先落水位：conv 源失败（fail-fast 上抛）不应让已 upsert 的计数在下轮被重读重算。
  await io.writeCursor(org, 'query_audit', summary.cursorAudit)

  if (opts.skipConv === true) {
    // 对话侧无归因字段 ⇒ 不读、不推 conv 水位，并显式标记（见 MineOptions.skipConv）。
    summary.convSkipped = true
    return summary
  }

  const conv = await io.readConv(org, summary.cursorConv)
  const sessionIds = [...new Set(conv.map((r) => r.session_id))]
  const stuck = sessionIds.length === 0 ? new Map<string, unknown[]>() : await io.readStuck(org, sessionIds)
  for (const draft of huntFromConvs(conv, stuck)) {
    await io.upsert(org, draft)
    summary.hunt += 1
  }
  // 排他游标：读侧用 `_timestamp > cursor`，这里写本批 max —— 边界组不再重读（见函数头注释）。
  const maxConv = conv.reduce((m, r) => Math.max(m, r._timestamp), 0)
  summary.cursorConv = maxConv > 0 ? maxConv : summary.cursorConv

  await io.writeCursor(org, 'askdata_conv', summary.cursorConv)
  return summary
}
