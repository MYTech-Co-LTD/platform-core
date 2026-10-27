// console-schedules-tz.test.ts — 业务排班时区统一门禁（spec 2026-10-15 §10.6，2026-10-16 用户拍板）。
//
// 钉什么：deploy/duckle/console/schedules/ 下三本种子（3120×21 + 64188×16 + forms×1，共 38 条）必须
//   ① 全部显式 `timezone: 'Asia/Shanghai'`（含原先缺省无字段的 9 条）；
//   ② `kind.expr` 与 §10.6 转换表**逐字**一致（旧 UTC expr +8h）。
//   ⚠️ **2026-10-20 订正（#931）**：非销售采集统一到 **14–24 点每 2 小时**（`M 14,16,18,20,22 * * *`），
//     触发瞬间**有意改变**——原因是 `${date-1d}` 按 UTC 解析、00:0x CST 时 UTC 仍在前一天 ⇒ 实际采成 T-2。
//     14:00 CST = 06:00 UTC，UTC 与 CST 同日 ⇒ 日期基准回到北京。销售族（tick/windows/close）与对账不在本次范围。
// 为什么钉真实 JSON（与 sync-data-semantics.test.ts 读真 YAML 同一理由）：排班是物化定义，
// 谁回退一条 timezone / 抄错一个钟点都不报错，只表现为线上采集整体漂 8h——门禁必须红在仓内。
// 期望表就是 §10.6 的表（逐条转抄，不自创）：改排班先改表，改表先改 spec。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 期望：book →（排班 id → §10.6 转换表逐字的 expr）。行序即文件内条目序。 */
const EXPECTED: Record<string, Record<string, string>> = {
  '3120': {
    'panel-lemeng.retail.tick.l1': '*/5 8-23 * * *',
    'panel-lemeng.dim.item.l0': '0 14,16,18,20,22 * * *',
    'panel-lemeng.retail.close.l1': '0 0 * * *',
    'panel-lemeng.dim.branch.l0': '0 14,16,18,20,22 * * *',
    'panel-lemeng.branch.expense.l0.3120': '5 14,16,18,20,22 * * *',
    'panel-lemeng.branch_indicator.l0.3120': '10 14,16,18,20,22 * * *',
    'panel-lemeng.loss.adjustment.l0.3120': '5 14,16,18,20,22 * * *',
    'panel-lemeng.dim.item_price.l0.3120': '15 14,16,18,20,22 * * *',
    'panel-lemeng.client.expense.l0.3120': '15 14,16,18,20,22 * * *',
    'panel-lemeng.request.order.l0.3120': '20 14,16,18,20,22 * * *',
    'panel-lemeng.transfer.in.l0.3120': '25 14,16,18,20,22 * * *',
    'panel-lemeng.retail.windows.l1': '30 10,18 * * *',
    'panel-lemeng.transfer.out.l0.3120': '35 14,16,18,20,22 * * *',
    'panel-lemeng.inventory.snapshot.l0.3120': '35 14,16,18,20,22 * * *',
    // #1079 兜底轮：主轮（T-2）当天全空时补前一日（T-3），每日 00:35 CST 一轮
    'panel-lemeng.inventory.snapshot.catchup.3120': '35 0 * * *',
    'panel-lemeng.purchase.analysis.l0.3120': '40 14,16,18,20,22 * * *',
    'panel-lemeng.wholesale.out.l0.3120': '45 14,16,18,20,22 * * *',
    'panel-lemeng.client.l0.3120': '55 14,16,18,20,22 * * *',
    'panel-lemeng.wholesale.return.l0.3120': '55 14,16,18,20,22 * * *',
    'panel-lemeng.member.summary.l0.3120': '55 14,16,18,20,22 * * *',
    'panel-lemeng.recon.preagg': '40 0 * * *',
  },
  '64188': {
    'panel-lemeng.dim.branch.l0': '0 14,16,18,20,22 * * *',
    'panel-lemeng.dim.item.l0': '0 14,16,18,20,22 * * *',
    'panel-lemeng.dim.item_price.l0': '15 14,16,18,20,22 * * *',
    'panel-lemeng.retail.windows.l1': '30 10,18 * * *',
    'panel-lemeng.retail.tick.l1': '*/5 8-23 * * *',
    'panel-lemeng.retail.close.l1': '0 0 * * *',
    'panel-lemeng.recon.preagg': '30 0 * * *',
    // 2026-10-27（#1088）64188 补采：要货/采购/报损/库存(主+兜底)/门店费用/客户费用/门店指标/会员汇总。
    // 批发与配送**明确不采**（用户 2026-10-27 裁决），故无 transfer.* / wholesale.* 条目。
    'panel-lemeng.branch.expense.l0.64188': '5 14,16,18,20,22 * * *',
    'panel-lemeng.branch_indicator.l0.64188': '10 14,16,18,20,22 * * *',
    'panel-lemeng.loss.adjustment.l0.64188': '5 14,16,18,20,22 * * *',
    'panel-lemeng.request.order.l0.64188': '20 14,16,18,20,22 * * *',
    'panel-lemeng.inventory.snapshot.l0.64188': '35 14,16,18,20,22 * * *',
    'panel-lemeng.inventory.snapshot.catchup.64188': '35 0 * * *',
    'panel-lemeng.purchase.analysis.l0.64188': '40 14,16,18,20,22 * * *',
    'panel-lemeng.client.expense.l0.64188': '15 14,16,18,20,22 * * *',
    'panel-lemeng.member.summary.l0.64188': '55 14,16,18,20,22 * * *',
  },
  // forms（#729 M1.4，**非乐檬域**，有自己的 console）：新增即按 CST 写，无 UTC→CST 转换行。
  // 日批 00:20 CST（刚过零点采集，业务日的提交 T+1 可见；水位=id 键集游标 ⇒ 错峰不影响完整性）。
  forms: {
    'panel-forms.submission.l0': '20 0 * * *',
  },
}

/** 单形状读取（scripts/ 纪律：字段恒在，缺了当结构漂移大声红）。 */
function readBook(book: string): Array<{ id?: unknown; kind?: { type?: unknown; expr?: unknown }; timezone?: unknown }> {
  return JSON.parse(readFileSync(path.join(ROOT, 'deploy', 'duckle', 'console', 'schedules', `${book}.json`), 'utf8'))
}

describe('console 排班时区统一（spec §10.6）：38 条全显式 Asia/Shanghai + expr 逐字合表', () => {
  for (const [book, expected] of Object.entries(EXPECTED)) {
    it(`book=${book}：条目集与期望表恰同集，timezone 全显式 Asia/Shanghai，expr 逐字一致`, () => {
      const entries = readBook(book)
      expect(entries.length, `book=${book} 条目数`).toBe(Object.keys(expected).length)

      const seen = new Set<string>()
      for (const e of entries) {
        const id = String(e.id)
        seen.add(id)
        expect(expected[id], `book=${book} 出现期望表外的排班 ${id}（改排班先改 §10.6 表与本测试）`).toBeDefined()
        expect(e.kind?.type, `${id} kind.type`).toBe('cron')
        expect(e.timezone, `${id} timezone 缺失/非显式（§10.6：一律显式 Asia/Shanghai）`).toBe('Asia/Shanghai')
        expect(e.kind?.expr, `${id} expr 与 §10.6 转换表不符`).toBe(expected[id])
      }
      expect([...seen].sort(), `book=${book} 期望表里的排班在文件里缺席`).toEqual(Object.keys(expected).sort())
    })
  }

  it('合计恰 38 条（3120×21 + 64188×16 + forms×1）——条数漂移必须显式改 spec §10.6 与本测试', () => {
    const total = Object.values(EXPECTED).reduce((n, m) => n + Object.keys(m).length, 0)
    expect(total).toBe(38)
  })
})
