/** 工单表单数据类型 */
export interface IWorkOrderFormData {
  product_name: string
  damage_quantity: number | null
  damage_reason: string
  arrival_time: string
}

export interface IAfterSalesWorkOrder {
  /** 主键ID */
  id: string
  /** 工单编号 */
  order_number: string
  /** 商品名称 */
  product_name: string
  /** 关联订单 */
  related_order: string
  /** 订货时间 */
  order_time: number
  /** 到货时间 */
  arrival_time: number
  /** 门店选择 */
  store_selection: string
  /** 基本单位 */
  basic_unit: string
  /** 基本数量 */
  basic_quantity: number
  /** 基本单价 */
  basic_unit_price: number
  /** 报损数量 */
  damage_quantity: number
  /** 报损原因 */
  damage_reason: string
  /** 报损图片（可存储多个图片URL，JSON格式） */
  damage_images: any
  /** 批次号 */
  batch_number: string
  /** 售后规则 */
  after_sales_rules: string
  /** 售后状态 */
  after_sales_status: string
  /** 报损金额 */
  damage_amount: number
  /** 报损视频URL */
  damage_video: any
  /** 售后类型 */
  after_sales_type: string
  /** 品牌关联 */
  brand_related: string
  /** 紧急状态 */
  emergency_status: string
  /** 售后金额 */
  after_sales_amount: number
  /** 售后比例 */
  after_sales_rate: number
  /** 售后意见 */
  after_sales_opinion: string
  /** 水印时间 */
  timestamp_with_watermark: number
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
}

export type AfterSalesStatus = 'pending' | 'processing' | 'completed' | 'cancelled'
export type AfterSalesType = 'return' | 'exchange' | 'repair' | 'refund' | 'other'

/**
 * 附件（**域侧适配版**，非源侧形状）：
 * 源侧那份的 `url` / `originalPath` 在域侧**没有产出方**——`wuji-upload` 的 shim 回的是
 * `{id, objectKey}`（预签名 **PUT** 地址不是可读地址，spec §2.3），对象 key 也由服务端按
 * `objectKeyFor(org, clientRequestId)` 定，客户端拼的路径没有消费方。
 * 于是页面真正要的两样东西改由下面两个字段承载（`previewUrl` + `attachmentId`）：
 */
export interface IAttachment {
  type: 'image' | 'video'
  /** 本地预览（`URL.createObjectURL(file)`）——提交前展示用；提交后即可 revoke */
  previewUrl: string
  /** 服务端预签名时给的行 id：提交工单时作为 `attachmentIds` 认领（spec §2.3） */
  attachmentId: number | null
  name: string
  size: number
  originalName: string
  index: number
  uploadStatus: 'uploading' | 'completed' | 'failed'
  uploadProgress: number
}
