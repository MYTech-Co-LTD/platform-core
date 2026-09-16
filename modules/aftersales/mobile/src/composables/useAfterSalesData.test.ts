import { beforeEach, describe, expect, it, vi } from 'vitest'
import { employee_info, product_archive, store_info } from '@/shims/wuji-data'
import { useAfterSalesData } from './useAfterSalesData'

vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn() },
  employee_info: { query: vi.fn() },
  product_archive: { query: vi.fn() },
}))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const storeQuery = vi.mocked(store_info.query)
const empQuery = vi.mocked(employee_info.query)
const productQuery = vi.mocked(product_archive.query)

beforeEach(() => {
  storeQuery.mockReset().mockResolvedValue([{ id: 3, store_name: '城东店', store_number: '3', is_enabled: '1' }])
  empQuery.mockReset().mockResolvedValue([
    { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '3', status: '通过', _ctime: '', _mtime: '' },
  ])
  productQuery.mockReset().mockResolvedValue([{ id: 4, product_name: '螺栓', basic_quantity: 10, basic_unit_price_minor: 500 }])
})

describe('useAfterSalesData（M3b-2 裁剪后）', () => {
  it('loadEmployeeStores：按**我的登记**取门店（不是全量）', async () => {
    const d = useAfterSalesData()
    await d.loadEmployeeStores()
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ id__eq: 3 }] } })
    expect(d.storeList.value.map((s: { store_name: string }) => s.store_name)).toEqual(['城东店'])
  })

  it('loadEmployeeStores：没登记门店 ⇒ 空列表，且**不**发门店请求（不发等于不泄露全量）', async () => {
    empQuery.mockResolvedValue([
      { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '', status: '通过', _ctime: '', _mtime: '' },
    ])
    const d = useAfterSalesData()
    await d.loadEmployeeStores()
    expect(d.storeList.value).toEqual([])
    expect(storeQuery).not.toHaveBeenCalled()
  })

  it('loadProducts：搜索词只发**一次** query（域侧没有商品编码那一路）', async () => {
    const d = useAfterSalesData()
    await d.loadProducts('螺栓')
    expect(productQuery).toHaveBeenCalledTimes(1)
    expect(productQuery).toHaveBeenCalledWith({ filter: { status__eq: 1, product_name__contains: '螺栓' }, sort: 'product_name', pageSize: 1000 })
  })

  it('裁剪面的负例：不再暴露 loadOrders / orderList / currentUser（订单选择不做）', () => {
    const d = useAfterSalesData() as unknown as Record<string, unknown>
    expect(d.loadOrders).toBeUndefined()
    expect(d.orderList).toBeUndefined()
  })
})
