/**
 * 售后工单数据查询和管理（M3b-2：从 wuji-2 搬入后**裁剪**）
 *
 * 裁掉的三块与理由——都是「域侧没有对应能力」或「已定不做」，**不是漏搬**：
 *   ① `loadUserStores` + `users`：死码（保留页的解构清单里没有它）；
 *   ② `loadOrders` + `outbound_detail` + `orderList`/`selectedOrder`/`clearOrders`：
 *      订单选择**不做**（spec §3.2：域侧 `SubmitBody` 不收 `relatedOrder`）；
 *   ③ `getCurrentUser()`：裁剪后无调用点（shim 也不提供，见 `shims/wuji.ts` 头注）。
 *
 * 保留面里的两处改动：
 *   · `loadEmployeeStores` 收成**我的登记门店**（ids 形状，提交页口径，见函数注）；
 *   · `loadProducts` 的「名字 + 编码」双分支合并成一路（域侧没有编码那一路）——**有意的行为收窄**。
 */

import { ref } from 'vue'
import { Message } from '@wujibase/wuji'
import { employee_info, product_archive, store_info } from '@wujibase/wuji-data'
import type { IStoreInfo } from '@/types/store'

/**
 * 售后工单数据管理 hook
 */
export function useAfterSalesData() {
  const loading = ref(false)
  const productLoading = ref(false)
  const storeList = ref<IStoreInfo[]>([])
  const productList = ref<any[]>([])
  /** 门店：页面 `:value="store.id"` 绑的是主键；提交侧两种形状都收（见 `useWorkOrderSubmit`） */
  const selectedStore = ref<any>(null)
  /** 商品：同上。Task 8 的页面要读 `selectedProduct.value?.basic_quantity` ⇒ 终态是行对象 */
  const selectedProduct = ref<any>(null)

  /**
   * 加载「我的登记门店」（**不是全量门店**——那是登记页的口径，spec §3.2）。
   *
   * 源侧这里自己拼 `OR: [{id__eq}…]`；域侧 `/guest/stores` 直接收 `ids=`，
   * 但 shim 认的正是 OR 形状 ⇒ 调用点保持源侧写法（映射在 `shims/wuji-data.ts`）。
   *
   * ⚠️ 未登记（`store_info` 空）时**直接返回空列表、不发门店请求**：发出去就等于把
   * **全量门店**回给一个尚未登记的访客（shim 里空 OR = 空 id 集，这里索性连请求都不发）。
   */
  const loadEmployeeStores = async () => {
    loading.value = true
    try {
      const snap = await employee_info.query({ filter: { openId__eq: '' } })
      const allowedIds = snap[0]?.store_info ? snap[0].store_info.split(',').filter(Boolean) : []
      if (allowedIds.length === 0) {
        storeList.value = []
        return
      }
      // shim 只回窄行（id/name/number/is_enabled），原型是 IStoreInfo ⇒ 收口处 cast
      storeList.value = (await store_info.query({
        filter: { OR: allowedIds.map((id) => ({ id__eq: Number(id) })) },
      })) as unknown as IStoreInfo[]
    } catch (error: any) {
      console.error('加载员工门店列表失败:', error)
      Message.error('加载门店列表失败')
    } finally {
      loading.value = false
    }
  }

  /**
   * 商品搜索。源侧发**两次** query（`product_name__contains` + `id__startswith`）再按 id 去重合并
   * ——域侧 `/guest/products` **没有「商品编码」这一路**（spec §3.2），故收成一次按名字搜。
   * **这是有意的行为收窄**，不是漏搬。
   *
   * `status__eq: 1`（上下架）域侧无对应列 ⇒ shim 忽略它，但调用点保留——将来域侧加了上下架
   * 再加映射，比现在删掉更好找。
   */
  const loadProducts = async (searchText = '') => {
    productLoading.value = true
    try {
      productList.value = await product_archive.query({
        filter: { status__eq: 1, ...(searchText ? { product_name__contains: searchText } : {}) },
        sort: 'product_name',
        pageSize: 1000,
      })
    } catch (error: any) {
      Message.error(error?.message || '加载商品列表失败')
    } finally {
      productLoading.value = false
    }
  }

  return {
    loading,
    productLoading,
    storeList,
    productList,
    selectedStore,
    selectedProduct,
    loadEmployeeStores,
    loadProducts,
  }
}
