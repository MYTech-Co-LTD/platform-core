// xlsx.test.ts — Excel 导出（W4）：产物必须是**真 xlsx**且数字是数值单元格。
//
// 判据用 ExcelJS 回读（与生成同一套库）：内容、类型、数字格式三项都验——
// 只断言「文件非空/是 zip」挡不住「全写成文本」这种最贵的回归。
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { detailXlsx, receiptXlsx } from './xlsx'
import type { ReportReceipt } from './report-receipt'

const receipt = (format: 'currency' | 'number' | 'percent'): ReportReceipt => ({
  metric: {
    id: 'm:sales', title: '销售额', definition: null, unit: null,
    scopeNote: null, caliber: 'certified', format,
  },
  window: { from: '2026-10-01', to: '2026-10-02', mode: 'range' },
  scope: { branchNum: null, args: {} },
  value: '1,234.00', rawValue: 1234, dataAsOf: null, watermark: null,
  freshness: { status: null, line: null },
  series: [
    { day: '2026-10-01', value: 1000, formatted: '1,000.00' },
    { day: '2026-10-02', value: 234, formatted: '234.00' },
  ],
  seriesSum: '1,234.00', consistent: true, delta: null, notes: [],
})

const read = async (buf: Buffer): Promise<ExcelJS.Workbook> => {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb
}

describe('receiptXlsx', () => {
  it('按日组成：营业日为文本、值为数值 + 货币格式', async () => {
    const wb = await read(await receiptXlsx(receipt('currency')))
    const ws = wb.getWorksheet('按日组成')!
    expect(ws.getRow(1).values).toEqual([undefined, '营业日', '值'])
    expect(ws.getCell('A2').value).toBe('2026-10-01')
    expect(ws.getCell('B2').value).toBe(1000)
    expect(ws.getCell('B2').numFmt).toBe('#,##0.00')
    expect(ws.getCell('B3').value).toBe(234)
  })

  it('比率指标用百分数格式（原值是比率 0.xx）', async () => {
    const r = receipt('percent')
    r.series = [{ day: '2026-10-01', value: 0.2, formatted: '20.00%' }]
    const ws = (await read(await receiptXlsx(r))).getWorksheet('按日组成')!
    expect(ws.getCell('B2').value).toBe(0.2)
    expect(ws.getCell('B2').numFmt).toBe('0.00%')
  })
})

describe('detailXlsx', () => {
  it('数值列写数值，其余写文本；表头冻结', async () => {
    const wb = await read(await detailXlsx(
      ['branch_num', 'item_name', 'amount'],
      [['87', '西瓜', 12.5], ['116', '苹果', 3]],
    ))
    const ws = wb.getWorksheet('明细')!
    expect(ws.getRow(1).values).toEqual([undefined, 'branch_num', 'item_name', 'amount'])
    expect(ws.getCell('A2').value).toBe('87')          // 字符串维度不硬转数（前导零/编号）
    expect(ws.getCell('B2').value).toBe('西瓜')
    expect(ws.getCell('C2').value).toBe(12.5)
    expect(ws.getCell('C2').numFmt).toBe('#,##0.00')
    expect(ws.views?.[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
  })
})
