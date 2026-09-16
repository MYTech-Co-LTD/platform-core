// src/shims/wuji-data.ts —— `@wujibase/wuji-data` 的收窄替身（spec §3.2 三 shim 表）：
// **5 个表对象**，每个只实现保留页真正调到的方法，映射到具体域端点。
//
// 收窄的边界（写在这里免得后来者以为漏了）：
//   · `wechat_openid` —— 前端微信 OAuth 的 token 缓存，已由 M1 宿主路取代 ⇒ 不提供；
//   · `users` / `outbound_detail` —— 只出现在被裁掉的 loadUserStores / loadOrders 里 ⇒ 不提供；
//   · `after_sales_work_order.count` —— 源侧拿它按前缀数单生成工单号，而域侧工单号由服务端
//     生成（`AS-00000001`，spec §2.2 ③）⇒ 不提供，`generateOrderNumber` 一并删除。
import { ApiError, apiGet, apiSend } from './http'
import { currentClientRequestId } from './client-request-id'

// ── 源侧行形状：camelCase 的域响应 → snake_case 的源侧字段，页面/组件因此一行不改 ──
export interface StoreRow {
  id: number
  store_name: string
  store_number: string
  is_enabled: string
}
export interface EmployeeRow {
  id: number
  employee_name: string
  employee_phonenumber: string
  /** 逗号分隔的门店 id（源侧形态；平台侧已规范化成 employee_store 关联表，spec §2.5） */
  store_info: string
  status: string
  _ctime: string
  _mtime: string
}
export interface ApprovalRow {
  id: number
  openid: string
  status: string
}
export interface ProductRow {
  id: number
  product_name: string
  basic_quantity: number
  basic_unit_price_minor: number
}

interface StoreItem { id: number; name: string; regionId: number | null; address: string; phone: string }
interface ProductItem { id: number; name: string; spec: string | null; basicQuantity: number; basicUnitPriceMinor: number }
interface MyRegistration {
  registration: { name: string; phone: string; storeIds: number[] } | null
  hasPendingApproval: boolean
}

/** 域侧分页上界（`routes/context.ts` 的 `MAX_PAGE_SIZE`）——写在这里是这个数字的第二份来源，
 *  故旁边写明它的出处；改动后端上界时要一起改（Task 9 的收口清单里有这一条）。 */
const SERVER_MAX_PAGE_SIZE = 100
const MAX_PRODUCT_PAGES = 50

/**
 * 认 `store_info.query` 的**两种已知 filter 形状**，认不出就**抛**。
 *
 * 为什么抛而不是回落：静默回落成「不过滤」= 把**全量门店**回给访客（本仓反复批的静默降级）。
 * 调用点只有两个、都有测试，抛出去的是一条开发期就能撞见的错。
 */
function parseStoreFilter(filter: unknown): { kind: 'ids'; ids: number[] } | { kind: 'search'; text: string } {
  const or = (filter as { OR?: unknown } | null)?.OR
  if (Array.isArray(or)) {
    // 空 OR 数组 = **空 id 集**（真实调用点 `OR: storeIds.map(...)` 在集合为空时的形态）。
    // 显式走 `ids=`（服务端按空集处理），**不是**回落成「不带参数的不过滤」。
    if (or.length === 0) return { kind: 'ids', ids: [] }
    const ids: number[] = []
    let sawId = false
    let sawName = false
    let text = ''
    for (const cond of or) {
      const c = cond as { id__eq?: unknown; store_name__eq?: unknown } | null
      // 判据是**键存在**（不是 `!== undefined`）：`{id__eq: undefined}` 也是「给了一个 id 位」，
      // 但它不是有限数 ⇒ 下面抛，绝不当成「没给 id」而回落到名字搜索/全量。
      if (c && 'id__eq' in c) {
        sawId = true
        const n = Number(c.id__eq)
        if (!Number.isFinite(n)) {
          throw new Error(`store_info.query: OR 里的 id__eq 不是有限数：${JSON.stringify(c.id__eq)}`)
        }
        ids.push(n)
      }
      if (typeof c?.store_name__eq === 'string') {
        sawName = true
        if (c.store_name__eq !== '') text = c.store_name__eq
      }
    }
    if (sawId) return { kind: 'ids', ids }
    if (sawName) return { kind: 'search', text }
  }
  throw new Error(
    `store_info.query: 认不出的 filter（本 shim 只支持 id__eq / store_name__eq 两种形状）：${JSON.stringify(filter)}`,
  )
}

export const store_info = {
  async query(args: { filter?: unknown; sort?: string; pageSize?: number } = {}): Promise<StoreRow[]> {
    const f = parseStoreFilter(args.filter)
    const params = new URLSearchParams()
    if (f.kind === 'ids') {
      // 空集显式写成 `ids=`（服务端按空集处理），**不是**省略参数——省略等于「不过滤」
      params.set('ids', f.ids.join(','))
    } else if (f.text !== '') {
      params.set('q', f.text)
    }
    if (args.pageSize) params.set('size', String(Math.min(args.pageSize, SERVER_MAX_PAGE_SIZE)))
    const qs = params.toString()
    const body = await apiGet<{ items: StoreItem[] }>(`/guest/stores${qs ? `?${qs}` : ''}`)
    return body.items.map((s) => ({
      id: s.id,
      store_name: s.name,
      // 域侧门店**没有「编号」列**（spec §3.2）：退化成 id 的字符串，让源侧按编号搜那条路
      // 仍有确定行为（服务端只按名字搜）。这是**已知落差**，不是本 shim 的 bug。
      store_number: String(s.id),
      is_enabled: '1',
    }))
  },
}

export const employee_info = {
  /**
   * 源侧一律 `{filter: {openId__eq}}` ⇒ `GET /guest/me/registration`。
   * **filter 里的 openid 被忽略**：访客身份由 session（HttpOnly cookie）给，前端传什么都不改变
   * 服务端收窄的口径——这正是「身份只有一份来源」的落地（spec §3.2 摘 OAuth 块的同一条理由）。
   */
  async query(_args: { filter?: unknown; pageSize?: number } = {}): Promise<EmployeeRow[]> {
    const body = await apiGet<MyRegistration>('/guest/me/registration')
    if (body.registration === null) return []
    return [
      {
        id: 0,
        employee_name: body.registration.name,
        employee_phonenumber: body.registration.phone,
        store_info: body.registration.storeIds.join(','),
        // 能读到快照 ⇒ 档案已是 approved（服务端只回 approved 的）。状态词表按源侧
        // `employee_info` 那一套（中文；spec §5 #9 记的三套并存），展示层保持原样。
        status: '通过',
        _ctime: '',
        _mtime: '',
      },
    ]
  },
}

export const employee_info_approve = {
  /**
   * 源侧 `{filter: {openid__eq, status__eq: '待审批'}}` ⇒ 读 `hasPendingApproval`。
   * ⚠️ 源侧这里是小写 `openid__eq`（`employee_info` 那边是 `openId__eq`）——**源里就不一致**，
   * 本 shim 不纠：纠了反而与源侧调用点对不上，而它本来就只用来判「有没有」。
   */
  async query(_args: { filter?: unknown } = {}): Promise<ApprovalRow[]> {
    const body = await apiGet<MyRegistration>('/guest/me/registration')
    return body.hasPendingApproval ? [{ id: 0, openid: '', status: '待审批' }] : []
  },

  /**
   * 域端点收的是**目标值** `{name, phone, storeIds}`（spec §2.5 纪律②：差异由服务端算）。
   * 源侧 payload 里的 `approvetype` / `openid` / `status` / `old_info` **一律不发**——
   * `old_info` 尤其不能发：服务端本来就知道当前行，发过去只会变成第二份事实。
   */
  async create(data: { approveinfo?: unknown } = {}): Promise<unknown> {
    const info = (data.approveinfo ?? {}) as {
      employee_name?: unknown
      employee_phonenumber?: unknown
      store_info?: unknown
    }
    const raw = info.store_info
    const storeIds = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
    try {
      return await apiSend('/guest/employee-approvals', 'POST', {
        name: String(info.employee_name ?? ''),
        phone: String(info.employee_phonenumber ?? ''),
        storeIds,
      })
    } catch (e) {
      // 「已有待审批」在**服务端**是 409 APPROVAL_PENDING（部分唯一索引兜底，spec §2.5 纪律①）。
      // 源侧靠提交前查一次提示——那个判定并发下会漏，所以服务端的才算数；这里翻成源侧那句
      // 文案，页面的 catch 分支因此不用改。
      if (e instanceof ApiError && e.code === 'APPROVAL_PENDING') {
        throw new Error('您已有待审批的申请，请等待审批')
      }
      // 「您没有修改任何信息」由服务端 400 带 message 回（computeRegistration 抛的）——
      // 原样透出，与源侧那句提示一致。
      if (e instanceof ApiError && e.message !== '') throw new Error(e.message)
      throw e
    }
  },
}

export const product_archive = {
  /**
   * 源侧要「一次拿完」（`pageSize: 1000`），而域侧 `/guest/products` 的 `size` 上界是 100
   * ⇒ 这里**按页循环收齐**。上界 `MAX_PRODUCT_PAGES` 是防御：服务端 total 若因并发变动
   * 让我们永远收不齐，也不能把移动端拖进死循环。
   */
  async query(args: { filter?: unknown; sort?: string; pageSize?: number } = {}): Promise<ProductRow[]> {
    const f = (args.filter ?? {}) as { product_name__contains?: unknown }
    const q = typeof f.product_name__contains === 'string' ? f.product_name__contains : ''
    const size = Math.min(args.pageSize ?? SERVER_MAX_PAGE_SIZE, SERVER_MAX_PAGE_SIZE)

    const out: ProductRow[] = []
    for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
      const params = new URLSearchParams({ page: String(page), size: String(size) })
      if (q !== '') params.set('q', q)
      const body = await apiGet<{ items: ProductItem[]; total: number }>(`/guest/products?${params}`)
      out.push(...body.items.map((p) => ({
        id: p.id,
        product_name: p.name,
        basic_quantity: p.basicQuantity,
        basic_unit_price_minor: p.basicUnitPriceMinor,
      })))
      if (out.length >= body.total || body.items.length === 0) break
    }
    return out
  },
}

export const after_sales_work_order = {
  /**
   * 源侧 payload 有 23 个键（含 `order_number` / `related_order` / `damage_amount` /
   * `damage_images` / `damage_video` …），而域端点 `POST /guest/tickets` 只收 6 个
   * （spec §2.2）。**只映射这 6 个，其余丢掉**——不是"以后再补"：
   * 工单号服务端生成、金额由服务端按规则快照算（§0.3 把「前端算金额」列为要消灭的模式）。
   */
  async create(payload: {
    product_id?: unknown
    store_selection?: unknown
    damage_quantity?: unknown
    damage_reason?: unknown
    damage_images?: unknown
  } = {}): Promise<{ id: number; code?: string; duplicated?: boolean }> {
    const attachments = Array.isArray(payload.damage_images) ? payload.damage_images : []
    const attachmentIds = attachments
      .map((a) => Number((a as { attachmentId?: unknown } | null)?.attachmentId))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
    return apiSend('/guest/tickets', 'POST', {
      clientRequestId: currentClientRequestId(),
      productId: Number(payload.product_id),
      ...(payload.store_selection === undefined || payload.store_selection === null
        ? {}
        : { storeId: Number(payload.store_selection) }),
      damageQuantity: Number(payload.damage_quantity),
      remark: String(payload.damage_reason ?? ''),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })
  },
}
