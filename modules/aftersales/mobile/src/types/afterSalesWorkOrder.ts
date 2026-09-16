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

export interface IAttachment {
  /** 文件类型（image/video） */
  type: 'image' | 'video'
  /** 文件URL */
  url: string
  /** 文件名 */
  name: string
  /** 文件大小（字节） */
  size: number
  /** 原始文件路径（用于重命名） */
  originalPath?: string
  /** 原始文件名（用于重命名） */
  originalName?: string
  /** 文件序号 */
  index?: number
  /** 上传状态：'pending' 等待中, 'uploading' 上传中, 'completed' 已完成, 'failed' 失败 */
  uploadStatus?: 'pending' | 'uploading' | 'completed' | 'failed'
  /** 上传进度 0-100 */
  uploadProgress?: number
  /** 临时预览URL（用于上传中显示本地预览） */
  previewUrl?: string
}
