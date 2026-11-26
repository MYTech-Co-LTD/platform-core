// xlsx.ts — 售后工单 Excel 导出（2026-11-26 / issue #2884）。
//
// 为什么模块内自持一份而不是 import `modules/data/domain/xlsx.ts`：B1 禁止跨模块引用
// （`scripts/lint-architecture.mjs`）。做法照 data 的三条纪律：
//  ① 只做序列化，不新开查询通道、不做计算；
//  ② 数值是**数值单元格**并套数字格式（金额 `#,##0.00`、比例 `0.00%`），否则 Excel 里
//     求和/排序全废；无法解析为有限数的值按文本写，绝不硬转成 0；
//  ③ 表头冻结 + 自动列宽只是可读性，不改变数据形状。
import ExcelJS from 'exceljs'

export interface XlsxColumn {
  key: string
  header: string
  width?: number
  /** Excel 数字格式；有它 ⇒ 该列的数值单元格套格式（文本列留空）。 */
  numFmt?: string
}

/** 一行 = key → 标量。`null`/`undefined` 写成空格子，不编造 0。 */
export type XlsxRow = Record<string, string | number | null | undefined>

export async function ticketsXlsx(columns: readonly XlsxColumn[], rows: readonly XlsxRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'platform-core'
  const ws = wb.addWorksheet('售后工单')

  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 16,
    ...(c.numFmt ? { style: { numFmt: c.numFmt } } : {}),
  }))
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  for (const row of rows) {
    // 只写声明的列；未知键不落表（导出列是白名单，不是「对象里有什么写什么」）。
    const value: Record<string, string | number | null> = {}
    for (const c of columns) {
      const v = row[c.key]
      value[c.key] = v === undefined || v === null
        ? null
        : typeof v === 'number' && Number.isFinite(v) ? v : String(v)
    }
    ws.addRow(value)
  }

  // 数值格式只作用于「确实是数值」的单元格；文本列（如编号 `AS-...`）不能被格式化成数字。
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    row.eachCell((cell, colNumber) => {
      const fmt = columns[colNumber - 1]?.numFmt
      if (fmt && typeof cell.value === 'number') cell.numFmt = fmt
    })
  })

  const ab = await wb.xlsx.writeBuffer()
  return Buffer.from(ab)
}
