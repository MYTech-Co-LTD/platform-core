// export-fields.ts — 工单导出的列白名单（服务端生成 Excel 与 console 的字段勾选共用一份）。
//
// 为什么放在模块根而不是 routes/ 或 console/：两侧需要**同一份 key/表头/格式**。各写一份的
// 症状是「界面勾了『赔付金额』，导出的 Excel 里没有」——不报错，只是静默少列。
export interface ExportField {
  key: string
  header: string
  width?: number
  /** Excel 数字格式；有它 ⇒ 该列数值单元格套格式（文本列留空）。 */
  numFmt?: string
}

export const EXPORT_FIELDS: readonly ExportField[] = [
  { key: 'code', header: '工单编号', width: 16 },
  { key: 'status', header: '状态', width: 10 },
  { key: 'brand', header: '品牌', width: 10 },
  { key: 'productName', header: '商品', width: 20 },
  { key: 'storeName', header: '门店', width: 18 },
  { key: 'relatedOrder', header: '关联订单', width: 18 },
  { key: 'arrivalAt', header: '到货时间', width: 18 },
  { key: 'damageQuantity', header: '报损数量', width: 10, numFmt: '#,##0.00' },
  { key: 'damageAmount', header: '报损金额', width: 12, numFmt: '#,##0.00' },
  { key: 'refundAmount', header: '赔付金额', width: 12, numFmt: '#,##0.00' },
  { key: 'amountType', header: '售后类型', width: 10 },
  { key: 'refundRatio', header: '比例', width: 10, numFmt: '0.00%' },
  { key: 'operator', header: '处理人', width: 12 },
  { key: 'opinion', header: '售后意见', width: 30 },
  { key: 'watermarkAt', header: '水印时间', width: 12 },
  { key: 'attachments', header: '附件数', width: 8, numFmt: '0' },
  { key: 'createdAt', header: '提交时间', width: 18 },
  { key: 'processedAt', header: '处理时间', width: 18 },
  { key: 'storeAffiliation', header: '归属', width: 10 },
]
