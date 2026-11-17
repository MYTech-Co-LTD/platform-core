// xlsx.ts — Excel 导出（开发地图 W4）：CSV 之外给业务一个「打开就是表格」的产物。
//
// 三条纪律：
//  ① **与 CSV 同源**：数据只来自既有导出结果（凭证按日组成 / 明细行），本模块只做序列化，
//     不新开查询通道、不做任何计算；
//  ② 数字是**数值单元格**（不是文本），并套数字格式（currency/percent/number）——否则
//     Excel 里求和/排序全废；无法解析为有限数的值按文本写，绝不硬转成 0；
//  ③ 表头冻结 + 自动列宽只是可读性，不改变数据形状。
import ExcelJS from 'exceljs'
import type { ReportReceipt } from './report-receipt'

const NUM_FMT: Record<'currency' | 'number' | 'percent', string> = {
  currency: '#,##0.00',
  percent: '0.00%',
  number: '#,##0.00',
}

async function bufferOf(wb: ExcelJS.Workbook): Promise<Buffer> {
  const ab = await wb.xlsx.writeBuffer()
  return Buffer.from(ab)
}

/** 凭证「按日组成」：营业日 + 值（数值 + 格式）。 */
export async function receiptXlsx(receipt: ReportReceipt): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'platform-core'
  const ws = wb.addWorksheet('按日组成')
  ws.columns = [
    { header: '营业日', key: 'day', width: 14 },
    { header: '值', key: 'value', width: 16, style: { numFmt: NUM_FMT[receipt.metric.format] } },
  ]
  const rows = receipt.series ?? []
  for (const r of rows) ws.addRow({ day: r.day, value: Number.isFinite(r.value) ? r.value : r.formatted })
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return bufferOf(wb)
}

/** 明细行：原列名 + 原始值；数值列按数值写，其余按文本。 */
export async function detailXlsx(columns: readonly string[], rows: readonly unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'platform-core'
  const ws = wb.addWorksheet('明细')
  ws.addRow([...columns])
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  for (const row of rows) {
    ws.addRow(row.map((v): string | number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (v === null || v === undefined) return null
      return String(v)
    }))
  }
  // 数值格式只作用于「确实是数值」的单元格。
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    row.eachCell((cell) => {
      if (typeof cell.value === 'number') cell.numFmt = NUM_FMT.number
    })
  })
  ws.columns.forEach((col, i) => {
    col.width = Math.min(40, Math.max(10, (columns[i] ?? '').length + 4))
  })
  return bufferOf(wb)
}
