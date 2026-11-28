// attachment-kind.ts — 附件类型判定（console 侧展示用）。
//
// 白名单的**服务端事实源**在 `routes/attachment.ts` 的 ALLOWED_EXACT_TYPES；这里只负责
// 「显示成什么」。两边都是字面量，改白名单时一起改（测试里各钉一处）。
const EXCEL_TYPES = [
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
]

export const isExcelType = (contentType: string): boolean => EXCEL_TYPES.includes(contentType)
