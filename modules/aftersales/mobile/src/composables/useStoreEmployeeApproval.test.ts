import { beforeEach, describe, expect, it, vi } from 'vitest'
import { employee_info, employee_info_approve, store_info } from '@/shims/wuji-data'
import { useStoreEmployeeApproval } from './useStoreEmployeeApproval'

vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn() },
  employee_info: { query: vi.fn() },
  employee_info_approve: { query: vi.fn(), create: vi.fn() },
}))
vi.mock('@wujibase/wuji', () => ({
  Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  Confirm: vi.fn(),
}))

const storeQuery = vi.mocked(store_info.query)
const empQuery = vi.mocked(employee_info.query)
const approvalQuery = vi.mocked(employee_info_approve.query)
const approvalCreate = vi.mocked(employee_info_approve.create)

const STORES = [
  { id: 3, store_name: '城东店', store_number: '3', is_enabled: '1' },
  { id: 5, store_name: '城西店', store_number: '5', is_enabled: '1' },
  { id: 7, store_name: '城南店', store_number: '7', is_enabled: '1' },
]

beforeEach(() => {
  storeQuery.mockReset().mockResolvedValue(STORES)
  empQuery.mockReset().mockResolvedValue([])
  approvalQuery.mockReset().mockResolvedValue([])
  approvalCreate.mockReset().mockResolvedValue({ id: 1 })
})

describe('useStoreEmployeeApproval', () => {
  it('loadEmployeeInfo：未登记 ⇒ employeeInfo 为 null（页面据此进「注册」态）', async () => {
    const c = useStoreEmployeeApproval()
    await c.loadEmployeeInfo()
    expect(c.employeeInfo.value).toBeNull()
    // ⚠️ 「有没有待审批」**不在这里查**：源侧那次查询在 submitApproval 开头（见下），
    // 断言也从这里搬走了——给 loadEmployeeInfo 加查询会让页面加载多发一次请求。
  })

  it('loadEmployeeInfo：已登记 ⇒ 档案回填（门店串的回填属页面的 handleEdit，见页面测试）', async () => {
    empQuery.mockResolvedValue([
      { id: 1, employee_name: '张三', employee_phonenumber: '138', store_info: '3,5', status: '通过', _ctime: '', _mtime: '' },
    ])
    const c = useStoreEmployeeApproval()
    await c.loadEmployeeInfo()
    expect(c.employeeInfo.value?.employee_name).toBe('张三')
  })

  it('loadSelectedStores：**一次** query 取回全部门店（不是 N 次并发）', async () => {
    const c = useStoreEmployeeApproval()
    await c.loadSelectedStores(['3', '5'])
    expect(storeQuery).toHaveBeenCalledTimes(1)
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ id__eq: 3 }, { id__eq: 5 }] } })
    // 取回即赋值。**不再断言「按请求 id 收窄」**：收窄是服务端 `?ids=` 的事，客户端收窄
    // 拿 mock 返回多余行去"证明"它，测的是不存在的情形。
    expect(c.storeList.value).toEqual(STORES)
  })

  it('loadStores(搜索词)：把词翻成 store_name__eq 的 OR 形状（shim 认这个形状）', async () => {
    const c = useStoreEmployeeApproval()
    await c.loadStores('城东')
    expect(storeQuery).toHaveBeenCalledWith({ filter: { OR: [{ store_name__eq: '城东' }, { store_number__eq: '城东' }] }, sort: 'store_name' })
  })

  it('submitApproval：提交**完整目标值**（不做前端 diff——差异由服务端算，spec §2.5 纪律②）', async () => {
    const c = useStoreEmployeeApproval()
    c.formData.value.employee_name = '张三'
    c.formData.value.employee_phonenumber = '138'
    c.formData.value.store_info = ['3', '5']
    await c.submitApproval('注册')
    // 源侧真实形状：**提交前先查一次待审批**（这次查询在源侧就落在 submitApproval 开头）
    expect(approvalQuery).toHaveBeenCalledTimes(1)
    expect(approvalQuery.mock.invocationCallOrder[0]!).toBeLessThan(approvalCreate.mock.invocationCallOrder[0]!)
    expect(approvalCreate).toHaveBeenCalledWith({
      approvetype: '注册',
      approveinfo: { employee_name: '张三', employee_phonenumber: '138', store_info: '3,5' },
    })
  })

  it('submitApproval：已存在待审批 ⇒ 不发提交请求，提示并返回 false', async () => {
    approvalQuery.mockResolvedValue([{ id: 1, openid: '', status: '待审批' }])
    const c = useStoreEmployeeApproval()
    c.formData.value.employee_name = '张三'
    c.formData.value.employee_phonenumber = '138'
    await expect(c.submitApproval('注册')).resolves.toBe(false)
    expect(approvalCreate).not.toHaveBeenCalled()
  })

  it('submitApproval：服务端 409（已有待审批）⇒ 返回 false 且提示（不是抛给页面）', async () => {
    approvalCreate.mockRejectedValue(new Error('您已有待审批的申请，请等待审批'))
    const c = useStoreEmployeeApproval()
    c.formData.value.employee_name = '张三'
    await expect(c.submitApproval('注册')).resolves.toBe(false)
  })

  it('submitApproval：未填姓名/电话时不发请求（源侧的必填闸门）', async () => {
    const c = useStoreEmployeeApproval()
    c.formData.value.employee_name = ''
    c.formData.value.employee_phonenumber = ''
    await expect(c.submitApproval('注册')).resolves.toBe(false)
    expect(approvalCreate).not.toHaveBeenCalled()
  })
})
