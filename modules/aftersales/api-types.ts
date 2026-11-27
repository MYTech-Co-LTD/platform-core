// api-types.ts — 服务端与 console **共用**的响应类型（M3a，spec §3.1）。
//
// 为什么存在：console 的测试要 mock `platformFetch`，而 AGENTS.md #11「测试替身必须收严到
// 真机形状」正警告替身漂移。把两端共用的形状写成**一份**类型 ⇒ 前端替身钉在真类型上。
//
// ⚠️ 两条**实测**事实（写本文件时逐字段对过 `routes/*.ts`，不是照计划抄的）：
//
//   ① `rules` / `employees` / `stores` / `products` 的 mapper 都是**显式构造对象** ⇒ 全 **camelCase**
//      （`refundRatio` / `createdAt` / `storeId` / `openId` / `approveStatus` / `regionId` /
//       `basicQuantity` / `basicUnitPriceMinor`）。
//
//   ② **tickets 的响应是「半 snake 半 camel」混合体**：`normalizeTicketRow` 用 `...row` 把
//      DB 原始行**摊平**进响应（故保留 `product_name` / `damage_quantity` / `amount_minor` 等
//      snake_case），再额外挂 4 个 camelCase 别名（`productId` / `storeId` / `amountMinor` /
//      `refundRatio`）。这与 spec 终审登记的 **F4「半 camelCase」**是同一类问题（那条当时标的是
//      访客列表）。**本轮不改接口**（不扩后端）⇒ 下面 `TicketListItem` 以 **snake_case 那份**为准
//      （它必然存在），camelCase 别名标成可选。
//
// ⚠️ 另一条（#155 后的现况）：`GET /rules` / `/employees` / `/stores` 已与 `/products`
//    **同形**，回 `{items,total,page,size}`（`page`/`size` 走同一份 `parsePageParam`；
//    原 `MAX_RULES`/`MAX_EMPLOYEES`/`MAX_STORES` 硬上界退役，由 `MAX_PAGE_SIZE` 接管）。
//    console 三页**仍单页展示**——分页重构不在 #155，改前**不要摆页码**。
//    `GET /employee-approvals` 仍回 `{items}`（`Unpaged`）。

export type TicketStatus = 'pending' | 'completed' | 'cancelled'
export type AmountType = 'ratio' | 'fixed'
export type ApproveStatus = 'pending' | 'approved' | 'rejected'

/** 品牌选项（动态，来自 data.v_brand_registry ∪ 工单历史快照；不再有租户业务枚举）。 */
export interface BrandOption {
  code: string
  name: string
  count: number
}
/** 提单时「提交人档案门店 vs 单据门店」的一致性（ADR 2026-11-24；见 routes/affiliation.ts） */
export type StoreAffiliation = 'matched' | 'mismatch' | 'unregistered'

/**
 * `GET /tickets` 的一行。
 * 以 **snake_case 那份为准**（`normalizeTicketRow` 摊平 DB 行后必然存在）；
 * 末尾 4 个 camelCase 别名是同一批值的重复出口，可选。
 */
export interface TicketListItem {
  id: number
  code: string
  // 自然键（#500）：product_id/store_id 是死列（存量行可能有值，新单恒 null）——别再消费。
  product_id: number | null
  product_name: string
  store_id: number | null
  store_name: string
  product_code: string
  store_code: string
  damage_quantity: number
  status: TicketStatus
  amount_type: AmountType | null
  amount_minor: number | null
  refund_ratio: number | null
  operator: string | null
  remark: string | null
  related_order: string | null
  /** 到货时间（迁移 009）：前端两个控件拼成的 ISO 字符串，可空 */
  arrival_at?: string | null
  created_at: string
  processed_at: string | null
  // 归属一致性快照（ADR 2026-11-24 §7 P1-a）：**信息性**，不参与任何放行判定。
  // 快照语义——记录提单那一刻的事实，档案后改不回溯。null = 判定失败（fail-open）或存量行。
  store_affiliation?: StoreAffiliation | null
  // ── 2026-11-26 起列表新增（#2884）──
  /** 处理人的售后意见（与店员填的报损原因 `remark` 分开） */
  opinion?: string
  /** 照片水印日期 `YYYY-MM-DD` */
  watermark_at?: string | null
  // 品牌/等级快照（#2892 / #2924）：提单时解析，读侧不 join；空串 = 未分类/未分级。
  brand_code?: string
  brand_name?: string
  brand_source?: string
  brand_origin?: string
  store_level_code?: string
  store_level_name?: string
  store_level_source?: string
  image_count?: number
  video_count?: number
  /** 报损金额（毛额，整数分）= 报损数量 × 单价；pending 也有值 */
  damage_amount_minor?: number
  // —— `normalizeTicketRow` 额外挂的 camelCase 别名（同值）——
  productId?: number | null
  storeId?: number | null
  amountMinor?: number
  refundRatio?: number | null
  damageAmountMinor?: number
}

/** 挂原单冻结依据（#500 段③，spec §6.2）：建单时定死，票面可追溯到具体那张 MO/WO 的那一行。 */
export interface TicketSettlement {
  settlement_source: 'transfer' | 'wholesale' | ''
  settlement_order_no: string
  settlement_item_code: string
  settlement_line_key: string
  settlement_price_minor: number | null
  settlement_bizday: string | null
}

/** `GET /tickets/:id`：列表行 + 详情独有的字段 + 附件（附件 URL 由服务端预签名，未配 ZOS 时为 null） */
export interface TicketDetail extends TicketListItem, TicketSettlement {
  submitter_openid: string
  /** numeric(14,6)（迁移 010）：建单时冻结的结算行数量；存量单为 0 */
  basic_quantity: number
  basic_unit_price_minor: number
  opinion: string
  watermark_at: string | null
  brand_code: string
  brand_name: string
  brand_source: string
  brand_origin: string
  store_level_code: string
  store_level_name: string
  store_level_source: string
  damage_amount_minor: number
  attachments: TicketAttachment[]
}

/**
 * `GET /tickets/counts`：状态全局计数 + 等级/品牌动态选项。
 * 层级：状态（全局）→ 搜索/时间 → 等级（只含上游）→ 品牌（最末级，含等级）。
 * `unclassified` 是 brand_code='' 的一等计数；`unleveled` 是 store_level_code='' 的一等计数；
 * `showFilter=false` 时 console 不渲染该行；`degraded=true` 表示对应视图不可用（其余照常）。
 */
export interface TicketCounts {
  status: { all: number; pending: number; completed: number; cancelled: number }
  brand: {
    options: BrandOption[]
    unclassified: number
    showFilter: boolean
    degraded: boolean
  }
  level?: {
    options: BrandOption[]
    unleveled: number
    showFilter: boolean
    degraded: boolean
  }
}

/** `GET /guest/settlement-orders` 的一行：选单页的两级选择面（单 → 行）。 */
export interface SettlementOrder {
  orderNo: string
  source: 'transfer' | 'wholesale'
  bizday: string
  createTime: string | null
  lines: {
    itemCode: string
    itemName: string | null
    lineKey: string
    quantity: number | null
    priceMinor: number
  }[]
}

export interface TicketAttachment {
  id: number
  objectKey: string
  contentType: string
  sizeBytes: number
  url: string | null
}

/** `GET /attachments/:id`：单附件元数据 + 当次预签名 GET URL（预览按需取用）。 */
export interface AttachmentDetail extends TicketAttachment {
  ticketId: number | null
  uploaderOpenid: string
  createdAt: string
}

/** 分页列表响应：`GET /tickets` / `/products` / `/guest/*`；#155 起 `/rules` / `/employees` / `/stores` 同形对齐 */
export interface Paged<T> {
  items: T[]
  total: number
  page: number
  size: number
}

/** `GET /employee-approvals` 的响应（**无 `total`** ⇒ 单页） */
export interface Unpaged<T> {
  items: T[]
}

export interface RuleItem {
  id: number
  name: string
  /** ⚠️ `number | null`：出口走的是 `toRatioOrNull`（不是 `toRatio`），null 是它的一种取值。
   *  这是**类型跟着实现走**的一处修正——初稿写成 `number`，被 typecheck 当场抓出（TS2322）。
   *  这正是「服务端与 console 共用一份类型」要买的东西：把「我以为的形状」与「真的形状」
   *  的差异**在编译期**暴露，而不是等到前端渲染出 undefined。 */
  refundRatio: number | null
  remark: string | null
  createdAt: string
}

export interface EmployeeItem {
  id: number
  name: string
  phone: string
  /** 主门店 = `data.dim_branch.code` 自然键（#476：门店消费源已切发布快照，不再是本地 id） */
  storeCode: string | null
  openId: string
  approveStatus: ApproveStatus
}

/**
 * `GET /stores` / `/guest/stores` 的一行——数据源 = `data.dim_branch` 发布快照
 * （#476 ADR 形状②：维表消费走 owner 发布的契约，不再自持副本）。
 * `code` 是自然键（ dim_branch.code，即源侧门店编号），提交侧（员工登记/工单）引用它。
 */
export interface StoreItem {
  code: string
  name: string
  /** 启用与否（任一账套启用即启用）——发布契约见 data.dim_branch */
  enable: boolean | null
  address: string | null
  phone: string | null
  // 门店画像（#2924，来自 data.v_store_profile；视图缺失时 null）
  brandCode?: string | null
  brandName?: string | null
  levelCode?: string | null
  levelName?: string | null
}

/** `GET /stores/profile-options`：门店页签的编辑选项 + 覆盖率。 */
export interface StoreProfileOptions {
  brands: { code: string; name: string; enabled: boolean; sort: number }[]
  levels: { code: string; name: string; enabled: boolean; sort: number }[]
  coverage: { stores: number; brandTagged: number; levelTagged: number }
  degraded: boolean
}

/** `GET /products` / `/guest/products` 的一行——数据源 = `data.dim_item`（同上）。 */
export interface ProductItem {
  code: string
  barCode: string | null
  name: string
  spec: string | null
  unitName: string | null
  /** 停售/淘汰标记（任一账套）： true ⇒ 建单选它可能无价可依 */
  saleCease: boolean | null
  eliminate: boolean | null
}

/**
 * `POST /tickets/:id/process` 的请求体（与服务端 `ProcessBody` 判别联合同形）。
 * 2026-11-26：`opinion`（售后意见，必填 ≤500）与 `watermarkAt`（水印日期，必填）替代 `remark`。
 */
export type ProcessBody =
  | { amountType: 'ratio'; refundRatio: number; opinion: string; watermarkAt: string }
  | { amountType: 'fixed'; amountMinor: number; opinion: string; watermarkAt: string }
  | { amountType: 'reject'; opinion: string; watermarkAt: string }

/** `POST /tickets/:id/quote` 的请求体（只关心金额三路，不要求意见/水印）。 */
export type QuoteBody =
  | { amountType: 'ratio'; refundRatio: number }
  | { amountType: 'fixed'; amountMinor: number }
  | { amountType: 'reject' }

/** 处理/预览共用的金额结果。`damageAmountMinor` 只有预览返回（固定金额的 UI 上限来源）。 */
export interface QuoteResult {
  status: TicketStatus
  amountType: 'ratio' | 'fixed' | 'reject'
  amountMinor: number
  refundRatio: number | null
  damageAmountMinor?: number
}

/** 处理成功响应。失败形如 `{ error: string }`（模块 API 约定），由 `lib/api.ts` 翻成 ApiError */
export interface ProcessResult {
  ok: true
  id: number
  status: TicketStatus
  amountType: AmountType
  amountMinor: number
  refundRatio?: number | null
}

/** `POST /tickets/batch-delete` 的逐单结果（请求合法就不因部分失败而整体 4xx）。 */
export interface BatchDeleteResult {
  deleted: number[]
  failed: { id: number; code: string; error: string }[]
}

/** `GET /tickets/export-manifest` 的一项附件（`url` 为对象存储预签名 GET，TTL 3600s）。 */
export interface ExportManifest {
  tickets: {
    id: number
    code: string
    attachments: TicketAttachment[]
  }[]
}

// ── 员工登记与审批（M3b-1，spec §2.5）─────────────────────────────────────────

/**
 * 提交登记/变更的**目标值**——客户端只表达「我要变成什么」，差异由服务端算（spec §2.5 纪律②）。
 *
 * ⚠️ 这里是**引用**域内核的定义、不是重定义：形状只有一份事实源
 * （`import type` ⇒ 编译期擦除，console 侧不会因此把域内核打进前端包）。
 */
export type { RegistrationTarget } from './domain/registration'
import type { RegistrationTarget } from './domain/registration'

/**
 * 绑定身份视图（账户统一 Task 9）：`status` 只声明 active|disputed——pending/revoked 对访客
 * 没有可展示的绑定语义，路由侧已收敛成 null。`accountMasked` 是服务端掩码，消费方不再自行掩码。
 */
export interface GuestIdentity {
  bound: boolean
  status: 'active' | 'disputed'
  boundVia: 'auto' | 'manual' | null
  accountMasked: string
}

/** `GET /guest/me/registration` 的响应（M3b-2 的移动端据此判断「有没有登记 / 我的门店」） */
export interface MyRegistration {
  registration: { name: string; phone: string; storeCodes: string[] } | null
  hasPendingApproval: boolean
  /** 绑定身份（账户统一 Task 9）：无服务/无行/非两态 ⇒ null */
  identity: GuestIdentity | null
}

/** `GET /employee-approvals` 的一行。`oldInfo`/`newInfo` **只含实际变了的字段** */
export interface EmployeeApprovalItem {
  id: number
  openId: string
  approveType: 'register' | 'change'
  status: 'pending' | 'approved' | 'rejected'
  oldInfo: Partial<RegistrationTarget>
  newInfo: Partial<RegistrationTarget>
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
}
