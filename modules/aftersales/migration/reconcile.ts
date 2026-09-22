// reconcile.ts — 对账（spec §3.3：计数 + 金额汇总；一次性快照的验收面）。
// 期望值全部由【同一份 clean 产物】计算（自洽口径）；target 侧只数 source_id <> '' 的迁移行，
// 不混入线上新写行（迁移后业务马上会用，混入会让对账永远红）。
import type { Pool } from 'pg'
import type { CleanTicket } from './clean'

export interface CountCheck { table: string; source: number; target: number; ok: boolean }
export interface SumCheck { label: string; expected: string; actual: string; ok: boolean }

/** targetTable 是 aftersales.<table>；expected.source = 源侧行数（count API 或拉取行数）。 */
export async function reconcileCounts(
  pool: Pool, org: string, expected: { table: string; source: number }[],
): Promise<CountCheck[]> {
  const out: CountCheck[] = []
  for (const e of expected) {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.${e.table} where org = $1 and source_id <> ''`, [org])
    const target = r.rows[0].n
    out.push({ table: e.table, source: e.source, target, ok: source_eq(e.source, target) })
  }
  return out
}
function source_eq(source: number, target: number): boolean {
  // target ≤ source：源侧被 clean 跳过的行（no_source_id、unknown_status、unknown_amount_type 等）不落库
  // ——差额必须能在 ImportStat.reasons 对上。
  // 相等是最优结局；本函数不吞差额（差额核对是人工步，见 CLI 输出）。
  return source === target
}

/** 金额和（bigint 展示为字符串——JS number 装不下分单位总额）。期望值由 CLI 对 clean 产物求和。 */
export async function reconcileTicketSums(
  pool: Pool, org: string, expected: { amountMinor: bigint; basicUnitPriceMinor: bigint },
): Promise<SumCheck[]> {
  const r = await pool.query<{ amount: string; price: string }>(
    `select coalesce(sum(amount_minor), 0)::text as amount,
            coalesce(sum(basic_unit_price_minor), 0)::text as price
       from aftersales.ticket where org = $1 and source_id <> ''`, [org])
  return [
    { label: 'ticket.amount_minor', expected: expected.amountMinor.toString(), actual: r.rows[0].amount,
      ok: expected.amountMinor.toString() === r.rows[0].amount },
    { label: 'ticket.basic_unit_price_minor', expected: expected.basicUnitPriceMinor.toString(), actual: r.rows[0].price,
      ok: expected.basicUnitPriceMinor.toString() === r.rows[0].price },
  ]
}

/** 期望和的计算口径（CLI 用）：对 clean 产物求和（null 视 0）。 */
export function expectedTicketSums(tickets: CleanTicket[]): { amountMinor: bigint; basicUnitPriceMinor: bigint } {
  let amount = 0n
  let price = 0n
  for (const t of tickets) {
    amount += t.amountMinor ?? 0n
    price += t.basicUnitPriceMinor ?? 0n
  }
  return { amountMinor: amount, basicUnitPriceMinor: price }
}
