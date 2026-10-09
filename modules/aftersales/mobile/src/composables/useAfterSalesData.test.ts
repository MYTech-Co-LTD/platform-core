import { beforeEach, describe, expect, it, vi } from 'vitest'
import { after_sales_work_order, employee_info, store_info } from '@/shims/wuji-data'
import { useAfterSalesData } from './useAfterSalesData'

vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn() },
  employee_info: { query: vi.fn() },
  after_sales_work_order: { create: vi.fn(), settlementOrders: vi.fn() },
}))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const storeQuery = vi.mocked(store_info.query)
const empQuery = vi.mocked(employee_info.query)
const settlementOrders = vi.mocked(after_sales_work_order.settlementOrders)

beforeEach(() => {
  storeQuery.mockReset().mockResolvedValue([{ id: '103', store_name: '城东店', store_number: '103', is_enabled: '1' }])
  empQuery.mockReset().mockResolvedValue([
    { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '3', status: '通过', _ctime: '', _mtime: '' },
  ])
  settlementOrders.mockReset().mockResolvedValue([
    { orderNo: 'MO3120992607050085', source: 'transfer', bizday: '2026-10-07', createTime: null, lines: [{ itemCode: 'I001', itemName: '测试商品', lineKey: '0', quantity: 30, priceMinor: 500 }] },
  ])
})

describe('useAfterSalesData（M3b-2 裁剪后）', () => {
  it('loadEmployeeStores：按**我的登记**取门店（不是全量）', async () => {
    const d = useAfterSalesData()
    await d.loadEmployeeStores()
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ id__eq: '3' }] } })
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

  it('loadSettlementOrders：按门店码拉结算单（#500 段③）', async () => {
    const d = useAfterSalesData()
    await d.loadSettlementOrders('103')
    expect(settlementOrders).toHaveBeenCalledWith('103')
    expect(d.settlementOrders.value).toHaveLength(1)
    expect(d.settlementOrders.value[0]!.orderNo).toBe('MO3120992607050085')
  })

  it('换店拉单 ⇒ 清空已选单/行（跨店残留是串店引用）', async () => {
    const d = useAfterSalesData()
    await d.loadSettlementOrders('103')
    d.selectedOrder.value = d.settlementOrders.value[0]!
    d.selectedLine.value = { ...d.settlementOrders.value[0]!.lines[0]!, orderNo: 'MO3120992607050085' }
    await d.loadSettlementOrders('104')
    // 选中项必须被清掉（列表本身会按新店 refill——mock 恒回同一行，断言选中态而非列表空）
    expect(d.selectedOrder.value).toBeNull()
    expect(d.selectedLine.value).toBeNull()
    expect(settlementOrders).toHaveBeenLastCalledWith('104')
  })

  it('空门店码 ⇒ **不**发请求（无店无可查）', async () => {
    const d = useAfterSalesData()
    await d.loadSettlementOrders('')
    expect(settlementOrders).not.toHaveBeenCalled()
    expect(d.settlementOrders.value).toEqual([])
  })

  it('裁剪面的负例：不再暴露 loadOrders / orderList / loadProducts / selectedProduct（商品选择已换选单选行）', () => {
    const d = useAfterSalesData() as unknown as Record<string, unknown>
    expect(d.loadOrders).toBeUndefined()
    expect(d.orderList).toBeUndefined()
    expect(d.loadProducts).toBeUndefined()
    expect(d.productList).toBeUndefined()
    expect(d.selectedProduct).toBeUndefined()
  })
})
