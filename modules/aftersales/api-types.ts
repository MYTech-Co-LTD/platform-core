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
// ⚠️ 另一条：`GET /rules` / `/employees` / `/stores` 有服务端上限（`MAX_RULES` /
//    `MAX_EMPLOYEES` / `MAX_STORES`，见各路由），**回 `{items}` 但不回 `total`** ⇒ console 侧
//    只能单页展示，**不要摆一个假的页码**（spec §3.1 的已知边界）。`GET /tickets` 与
//    `/products` 回 `total`，可真分页。

export type TicketStatus = 'pending' | 'completed' | 'cancelled'
export type AmountType = 'ratio' | 'fixed'
export type ApproveStatus = 'pending' | 'approved' | 'rejected'

/**
 * `GET /tickets` 的一行。
 * 以 **snake_case 那份为准**（`normalizeTicketRow` 摊平 DB 行后必然存在）；
 * 末尾 4 个 camelCase 别名是同一批值的重复出口，可选。
 */
export interface TicketListItem {
  id: number
  code: string
  product_id: number
  product_name: string
  store_id: number
  store_name: string
  damage_quantity: number
  status: TicketStatus
  amount_type: AmountType | null
  amount_minor: number | null
  refund_ratio: number | null
  operator: string | null
  remark: string | null
  related_order: string | null
  created_at: string
  processed_at: string | null
  // —— `normalizeTicketRow` 额外挂的 camelCase 别名（同值）——
  productId?: number
  storeId?: number
  amountMinor?: number
  refundRatio?: number | null
}

/** `GET /tickets/:id`：列表行 + 详情独有的字段 + 附件（附件 URL 由服务端预签名，未配 ZOS 时为 null） */
export interface TicketDetail extends TicketListItem {
  submitter_openid: string
  basic_quantity: number
  basic_unit_price_minor: number
  attachments: TicketAttachment[]
}

export interface TicketAttachment {
  id: number
  objectKey: string
  contentType: string
  sizeBytes: number
  url: string | null
}

/** `GET /tickets` 与 `GET /products` 的响应（**这两个端点回 `total`**） */
export interface Paged<T> {
  items: T[]
  total: number
  page: number
  size: number
}

/** `GET /rules` / `/employees` / `/stores` 的响应（**无 `total`** ⇒ 单页） */
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
  storeId: number | null
  openId: string
  approveStatus: ApproveStatus
}

export interface StoreItem {
  id: number
  name: string
  regionId: number | null
  address: string
  phone: string
}

export interface ProductItem {
  id: number
  name: string
  spec: string | null
  basicQuantity: number
  basicUnitPriceMinor: number
}

/** `POST /tickets/:id/process` 的请求体（与路由的 `ProcessBody` 判别联合同形） */
export type ProcessBody =
  | { amountType: 'ratio'; refundRatio: number; remark?: string }
  | { amountType: 'fixed'; amountMinor: number; remark?: string }
  | { amountType: 'reject'; remark?: string }

/** 处理成功响应。失败形如 `{ error: string }`（模块 API 约定），由 `lib/api.ts` 翻成 ApiError */
export interface ProcessResult {
  ok: true
  id: number
  status: TicketStatus
  amountType: AmountType
  amountMinor: number
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

/** `GET /guest/me/registration` 的响应（M3b-2 的移动端据此判断「有没有登记 / 我的门店」） */
export interface MyRegistration {
  registration: { name: string; phone: string; storeIds: number[] } | null
  hasPendingApproval: boolean
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
