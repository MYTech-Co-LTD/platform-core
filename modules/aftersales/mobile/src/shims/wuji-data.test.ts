import { beforeEach, describe, expect, it, vi } from 'vitest'
// ApiError 也从被 mock 的模块里取（下面的工厂把它换成了一个最小实现）——测试断言的是
// 「409 APPROVAL_PENDING 被翻成中文文案」这个行为，不是 ApiError 的实现。
import { ApiError, apiGet, apiSend } from './http'
import { after_sales_work_order, employee_info, employee_info_approve, product_archive, store_info } from './wuji-data'

vi.mock('./http', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  ApiError: class MockApiError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code) }
  },
}))

const get = vi.mocked(apiGet)
const send = vi.mocked(apiSend)

beforeEach(() => {
  get.mockReset()
  send.mockReset()
})

describe('store_info.query', () => {
  it('登记页形状（OR 里是名字）⇒ 转成 q 搜索，行翻成源侧 snake_case', async () => {
    get.mockResolvedValue({ items: [{ id: 7, name: '城东店', regionId: null, address: 'a', phone: 'p' }], total: 1, page: 1, size: 20 })
    const rows = await store_info.query({ filter: { OR: [{ store_name__eq: '城东' }, { store_number__eq: '城东' }] }, sort: 'store_name' })
    expect(get).toHaveBeenCalledWith('/guest/stores?q=%E5%9F%8E%E4%B8%9C')
    expect(rows[0]).toMatchObject({ id: 7, store_name: '城东店', is_enabled: '1' })
  })

  it('提交页形状（OR 里是 id）⇒ 转成 ids（不是「不过滤」）', async () => {
    get.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 })
    await store_info.query({ filter: { is_enabled__eq: '1', OR: [{ id__eq: 3 }, { id__eq: 5 }] } })
    expect(get).toHaveBeenCalledWith('/guest/stores?ids=3%2C5')
  })

  it('OR 为空数组（集合为空的真实形态）⇒ 仍然走 ids=，绝不回落成「查全部」', async () => {
    get.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 })
    await store_info.query({ filter: { OR: [] } })
    // 空集：`ids=`（服务端按空集处理），**不是**不带参数的「不过滤」
    expect(get).toHaveBeenCalledWith('/guest/stores?ids=')
  })

  it('OR 里的 id__eq 不是有限数 ⇒ 抛（坏值不被静默吞掉）', async () => {
    await expect(store_info.query({ filter: { OR: [{ id__eq: 'abc' }] } })).rejects.toThrow(/不是有限数/)
  })

  it('OR 里的 store_name__eq 是空串 ⇒ 抛（空搜索词会退化成「查全部」，不猜、不静默降级）', async () => {
    await expect(store_info.query({ filter: { OR: [{ store_name__eq: '' }] } })).rejects.toThrow(/空搜索词/)
    // 「抛」还要配上「没发请求」：只断 reject 的话，一个「先发了全量请求再抛」的实现照样绿。
    expect(get).not.toHaveBeenCalled()
  })

  it('认不出的 filter ⇒ 抛（不猜、不静默降级成全量）', async () => {
    await expect(store_info.query({ filter: { foo__eq: 1 } })).rejects.toThrow(/认不出的 filter/)
  })
})

describe('employee_info.query', () => {
  it('未登记 ⇒ 空数组（源侧靠 employees[0] 为空判「没登记」）', async () => {
    get.mockResolvedValue({ registration: null, hasPendingApproval: false })
    expect(await employee_info.query({ filter: { openId__eq: 'o1' } })).toEqual([])
  })

  it('已登记 ⇒ 一行，门店 id 用逗号串（源侧就是这个形状）', async () => {
    get.mockResolvedValue({ registration: { name: '张三', phone: '138', storeIds: [3, 5] }, hasPendingApproval: false })
    const rows = await employee_info.query({ filter: { openId__eq: 'o1' } })
    expect(rows[0]).toMatchObject({ employee_name: '张三', employee_phonenumber: '138', store_info: '3,5', status: '通过' })
  })

  it('filter 里的 openid 被忽略——身份只由 session 给', async () => {
    get.mockResolvedValue({ registration: null, hasPendingApproval: false })
    await employee_info.query({ filter: { openId__eq: '别人的-openid' } })
    expect(get).toHaveBeenCalledWith('/guest/me/registration')
  })
})

describe('employee_info_approve', () => {
  it('query：hasPendingApproval=true ⇒ 非空（源侧据此提示「已有待审批」）', async () => {
    get.mockResolvedValue({ registration: null, hasPendingApproval: true })
    expect(await employee_info_approve.query({ filter: { openid__eq: 'o1', status__eq: '待审批' } })).toHaveLength(1)
  })

  it('create：把表单目标值映射成域端点的 {name, phone, storeIds}', async () => {
    send.mockResolvedValue({ id: 1 })
    await employee_info_approve.create({
      approvetype: '注册',
      approveinfo: { employee_name: '张三', employee_phonenumber: '138', store_info: '3,5' },
    })
    expect(send).toHaveBeenCalledWith('/guest/employee-approvals', 'POST', {
      name: '张三', phone: '138', storeIds: [3, 5],
    })
  })

  it('create：只提交目标值（**不发 old_info/new_info**——差异由服务端算，spec §2.5 纪律②）', async () => {
    send.mockResolvedValue({ id: 1 })
    await employee_info_approve.create({ approveinfo: { employee_name: '张三', employee_phonenumber: '138', store_info: '3' } })
    const body = send.mock.calls[0]![2] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['name', 'phone', 'storeIds'])
  })

  it('create：服务端 409 APPROVAL_PENDING ⇒ 翻成源侧那句文案（页面 catch 分支不用改）', async () => {
    send.mockRejectedValue(new ApiError(409, 'APPROVAL_PENDING'))
    await expect(
      employee_info_approve.create({ approveinfo: { employee_name: '张', employee_phonenumber: '1', store_info: '' } }),
    ).rejects.toThrow('您已有待审批的申请')
  })
})

describe('product_archive.query', () => {
  it('把域侧分页翻成源侧「一次拿完」：按 page 循环直到收齐 total', async () => {
    get
      .mockResolvedValueOnce({ items: [{ id: 1, name: 'P1', spec: null, basicQuantity: 10, basicUnitPriceMinor: 500 }], total: 2, page: 1, size: 100 })
      .mockResolvedValueOnce({ items: [{ id: 2, name: 'P2', spec: null, basicQuantity: 20, basicUnitPriceMinor: 600 }], total: 2, page: 2, size: 100 })
    const rows = await product_archive.query({ filter: { status__eq: 1 }, sort: 'product_name', pageSize: 1000 })
    expect(rows.map((r) => r.product_name)).toEqual(['P1', 'P2'])
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('搜索词走 q（域侧没有「商品编码」这一路，源侧的双分支合并因此收成一路）', async () => {
    get.mockResolvedValue({ items: [], total: 0, page: 1, size: 100 })
    await product_archive.query({ filter: { product_name__contains: '螺栓', status__eq: 1 } })
    // ⚠️ 断言**不锁参数顺序**：`q` 与 `page`/`size` 谁在前是实现细节（URLSearchParams 的
    // 插入序），把它钉进测试只会在重构时无谓地红。钉「带上了这两个参数」才是契约。
    const url = get.mock.calls[0]![0] as string
    expect(url.startsWith('/guest/products?')).toBe(true)
    expect(url).toContain('q=%E8%9E%BA%E6%A0%93')
    expect(url).toContain('size=100')
  })
})

describe('after_sales_work_order.create', () => {
  it('只映射域端点收的那几个字段，且带上 sessionStorage 里的幂等键', async () => {
    sessionStorage.clear()
    send.mockResolvedValue({ id: 9, code: 'AS-00000009', status: 'pending', duplicated: false })
    await after_sales_work_order.create({
      product_id: 4, store_selection: 7, damage_quantity: 2, damage_reason: '破损',
      damage_images: [{ attachmentId: 11 }, { attachmentId: 12 }],
      // 下面这些源侧字段域端点**不收**，必须被丢掉（不是拼进 body）
      order_number: 'YYMMDD00001', related_order: 3, damage_amount: 1000,
    })
    const body = send.mock.calls[0]![2] as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['attachmentIds', 'clientRequestId', 'damageQuantity', 'productId', 'remark', 'storeId'])
    expect(body).toMatchObject({ productId: 4, storeId: 7, damageQuantity: 2, remark: '破损', attachmentIds: [11, 12] })
    expect(typeof body.clientRequestId).toBe('string')
  })

  it('server 回 duplicated:true ⇒ 视为「已落库」（调用方据此也轮换幂等键）', async () => {
    sessionStorage.clear()
    send.mockResolvedValue({ id: 9, duplicated: true })
    await expect(after_sales_work_order.create({ product_id: 4, damage_quantity: 1 })).resolves.toMatchObject({ duplicated: true })
  })
})
