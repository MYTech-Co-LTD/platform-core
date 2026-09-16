import { ref } from 'vue'
import { Message } from '@wujibase/wuji'
import { store_info } from '@wujibase/wuji-data'
import { employee_info } from '@wujibase/wuji-data'
import { employee_info_approve } from '@wujibase/wuji-data'

export interface IEmployeeFormData {
  employee_name: string
  employee_phonenumber: string
  store_info: string | string[]
}

export type LoadStoresFunction = (searchText?: string) => Promise<void>

export function useStoreEmployeeApproval() {
  // 页面加载状态
  const pageLoading = ref(true)
  // 操作加载状态
  const loading = ref(false)
  // 员工信息
  const employeeInfo = ref<any>(null)
  // 门店列表
  const storeList = ref<any[]>([])
  // 表单数据
  const formData = ref<IEmployeeFormData>({
    employee_name: '',
    employee_phonenumber: '',
    store_info: '',
  })

  /**
   * 加载门店列表（精准搜索）
   * @param searchText 搜索关键词（门店名称或门店编号）
   */
  const loadStores = async (searchText?: string) => {
    try {
      loading.value = true

      // 如果没有搜索关键词，不加载门店列表
      if (!searchText || searchText.trim().length === 0) {
        storeList.value = []
        return
      }

      // 构建搜索条件 - 使用 OR 过滤器进行精准匹配门店名称或门店编号
      const filter: any = {
        OR: [
          { store_name__eq: searchText.trim() },
          { store_number__eq: searchText.trim() },
        ],
      }

      const stores = await store_info.query({
        filter,
        sort: 'store_name',
      })
      storeList.value = stores

      if (!stores || stores.length === 0) {
        console.warn('未找到完全匹配的门店')
      }
    } catch (error: any) {
      console.error('加载门店列表失败:', error)
      Message.error('加载门店列表失败')
    } finally {
      loading.value = false
    }
  }

  /** 取「我选中的门店」的明细。域侧 `/guest/stores?ids=` 支持批量 ⇒ **一次请求**，
   *  （源侧是 storeIds.map 并发 N 次单查，因为源数据源没有 id__in）。 */
  const loadSelectedStores = async (storeIds: string[]) => {
    if (storeIds.length === 0) {
      storeList.value = []
      return
    }
    try {
      storeList.value = await store_info.query({
        filter: { OR: storeIds.map((id) => ({ id__eq: Number(id) })) },
      })
    } catch (error: any) {
      Message.error(error?.message || '加载门店列表失败')
    }
  }

  /**
   * 加载员工信息（身份由 session 给，不再从 URL/localStorage 取 openid）
   */
  const loadEmployeeInfo = async () => {
    try {
      loading.value = true
      const employees = await employee_info.query({})

      if (employees && employees.length > 0) {
        employeeInfo.value = employees[0]
        console.log('员工信息:', employees[0])
        console.log('员工门店信息:', employees[0].store_info)
        console.log('门店信息类型:', typeof employees[0].store_info)
        console.log('门店信息是否为数组:', Array.isArray(employees[0].store_info))
      } else {
        employeeInfo.value = null
      }
    } catch (error: any) {
      console.error('加载员工信息失败:', error)
      Message.error('加载员工信息失败')
    } finally {
      loading.value = false
      pageLoading.value = false
    }
  }

  /**
   * 提交登记/变更。**只提交目标值**（spec §2.5 纪律②）——源侧在这里逐字段 diff 出
   * old_info/new_info，那是要消灭的前端编排；服务端本就知道当前行，由它算。
   * 「您没有修改任何信息」仍会出现，只不过现在由服务端回 400 + message
   * （shim 把它翻成 Error，下面的 catch 原样展示）。
   */
  const submitApproval = async (approveType: '注册' | '变更'): Promise<boolean> => {
    const name = String(formData.value.employee_name ?? '').trim()
    const phone = String(formData.value.employee_phonenumber ?? '').trim()
    if (name === '' || phone === '') {
      Message.warning('请填写员工姓名与手机号')
      return false
    }
    const storeInfoString = Array.isArray(formData.value.store_info)
      ? (formData.value.store_info as string[]).join(',')
      : String(formData.value.store_info ?? '')

    loading.value = true
    try {
      // 源侧行为：提交前先查一次「有没有待审批的申请」。这条判定并发下会漏，**服务端的
      // 409 才是权威兜底**（spec §2.5 纪律①，shim 里翻成源侧那句文案）——但它是源侧的
      // 真实形状，移植的契约是保持行为，故保留。身份已由 session 给，filter 里不再有 openid。
      const existingApprovals = await employee_info_approve.query({
        filter: { status__eq: '待审批' },
      })

      if (existingApprovals && existingApprovals.length > 0) {
        Message.warning('您已有待审批的申请，请等待当前申请完成后再提交')
        return false
      }

      await employee_info_approve.create({
        approvetype: approveType,
        approveinfo: {
          employee_name: name,
          employee_phonenumber: phone,
          store_info: storeInfoString,
        },
      })
      return true
    } catch (error: any) {
      // 409（已有待审批）与 400（没有修改任何信息）都在这条路上，文案来自服务端
      Message.error(error?.message || '提交失败')
      return false
    } finally {
      loading.value = false
    }
  }

  return {
    pageLoading,
    loading,
    employeeInfo,
    storeList,
    formData,
    loadStores: loadStores as LoadStoresFunction,
    loadSelectedStores,
    loadEmployeeInfo,
    submitApproval,
  }
}
