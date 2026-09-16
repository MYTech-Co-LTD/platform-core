export interface IStoreInfo {
  /** 主键ID */
  id: string
  /** 门店编号 */
  store_number: string
  /** 门店代码 */
  store_code: string
  /** 门店名称 */
  store_name: string
  /** 速记码 */
  quick_code: string
  /** 是否启用（1:启用 0:停用） */
  is_enabled: string | number
  /** 门店面积（平方米） */
  store_area: number
  /** 门店租金（年） */
  annual_rent: number
  /** 门店员工人数 */
  employee_count: number
  /** 邮编 */
  postal_code: string
  /** 地址 */
  address: string
  /** 门店类型 */
  store_type: string
  /** 区域分组 */
  region_group: string
  /** 联系电话 */
  contact_phone: string
  /** 建档日期 */
  archive_date: number
  /** 信用额度 */
  credit_limit: number
  /** 启用门店价格（1:启用 0:不启用） */
  enable_store_price: string | number
  /** 备注 */
  remark: string
  /** 门店标签（多个标签用逗号分隔） */
  store_tags: string
  /** 门店ID */
  store_id: string
  /** 门店状态（normal:正常 closed:关闭 renovating:装修中） */
  store_status: string
  /** WMS门店代码 */
  wms_store_code: string
  /** 品牌关联 */
  brand_relation: string
  /** 创建时间 */
  create_time: number
  /** 更新时间 */
  update_time: number
}

export interface IStoreStaffRegistration {
  /** 随机ID主键 */
  id: string
  /** 门店名称 */
  store_name: string
  /** 联系人姓名 */
  contact_name: string
  /** 联系人电话 */
  contact_phone: string
  /** 审批状态 */
  approval_status: string
  /** 创建时间 */
  created_at: number
  /** 更新时间 */
  updated_at: number
}

export type StoreStatus = 'normal' | 'closed' | 'renovating'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'
