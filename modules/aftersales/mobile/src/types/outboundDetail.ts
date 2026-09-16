export interface IOutboundDetail {
  /** 主键ID */
  id: string
  /** 单据号 */
  document_number: string
  /** 销售时间 */
  sale_time: string
  /** 调往门店名称 */
  to_store_name: string
  /** 商品名称 */
  product_name: string
  /** 基本单位 */
  basic_unit: string
  /** 配送单位 */
  delivery_unit: string
  /** 基本数量 */
  basic_quantity: number
  /** 基本单价 */
  basic_unit_price: number
  /** 毛利金额 */
  gross_profit: number
  /** 批次 */
  batch: string
  /** 创建时间 */
  create_time: string
  /** 更新时间 */
  update_time: string
}
