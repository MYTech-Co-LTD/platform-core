// mine.ts —— 一轮挖掘：读水位 → 拉两源 → 判定 → upsert → 成功后推进水位。
// 全部 IO 注入（MineIo），因此单测不连库不连网；CLI 组装真实现（scripts/demand-mining.mjs）。
import { classifyAudit, huntFromConvs, isProbeTarget } from './classify'
import type { AuditRow, ConvRow, DemandDraft } from './classify'
import type { CursorSource } from './store'

export interface MineIo {
  readCursor(org: string, source: CursorSource): Promise<number>
  writeCursor(org: string, source: CursorSource, value: number): Promise<void>
  readAudit(org: string, sinceId: number): Promise<{ rows: AuditRow[]; maxId: number }>
  readConv(org: string, sinceUs: number): Promise<ConvRow[]>
  readStuck(org: string, sessionIds: readonly string[]): Promise<Map<string, unknown[]>>
  catalogIds(org: string): Promise<string[]>
  upsert(org: string, draft: DemandDraft): Promise<void>
}

export interface MineSummary {
  scanned: number; alias: number; newMetric: number; drill: number; hunt: number
  skippedProbe: number; cursorAudit: number; cursorConv: number
}

/**
 * 一轮。顺序：先审计（驱动 skip 计数），再 conv（要会话 → 拉 stuck 证据）。
 * 水位**在对应源全部 upsert 成功后**推进——中途抛错则水位不动，下轮重读（upsert 幂等吸收）。
 */
export async function mineOnce(io: MineIo, org: string, nowUs: number): Promise<MineSummary> {
  const catalog = await io.catalogIds(org)
  const summary: MineSummary = {
    scanned: 0, alias: 0, newMetric: 0, drill: 0, hunt: 0, skippedProbe: 0,
    cursorAudit: await io.readCursor(org, 'query_audit'),
    cursorConv: await io.readCursor(org, 'askdata_conv'),
  }

  const audit = await io.readAudit(org, summary.cursorAudit)
  summary.scanned += audit.rows.length
  for (const row of audit.rows) {
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
  summary.cursorAudit = audit.maxId

  const conv = await io.readConv(org, summary.cursorConv)
  const sessionIds = [...new Set(conv.map((r) => r.session_id))]
  const stuck = sessionIds.length === 0 ? new Map<string, unknown[]>() : await io.readStuck(org, sessionIds)
  for (const draft of huntFromConvs(conv, stuck)) {
    await io.upsert(org, draft)
    summary.hunt += 1
  }
  const maxConv = conv.reduce((m, r) => Math.max(m, Number((r as { _timestamp?: number })._timestamp ?? 0)), 0)
  summary.cursorConv = maxConv > 0 ? maxConv : summary.cursorConv

  await io.writeCursor(org, 'query_audit', summary.cursorAudit)
  await io.writeCursor(org, 'askdata_conv', summary.cursorConv)
  return summary
}
