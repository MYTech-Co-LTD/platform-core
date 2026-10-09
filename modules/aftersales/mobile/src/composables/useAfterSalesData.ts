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
 *
 * #500 段③（2026-10-10）：**商品选择整块换成「选单选行」**——金额依据 = 所选结算单行
 * （data.dim_settlement_order_line，按单实际结算价）。原 `loadProducts`/`productList`/
 * `selectedProduct` 随商品下拉一并退役：商品身份由所选行携带（行里就有 item_code），
 * 再留一份商品列表就是第二份选择事实。
 */

import { ref } from 'vue'
import { Message } from '@wujibase/wuji'
import { after_sales_work_order, employee_info, store_info } from '@wujibase/wuji-data'
import type { SettlementLineRow, SettlementOrderRow } from '@wujibase/wuji-data'
import type { IStoreInfo } from '@/types/store'

/**
 * 售后工单数据管理 hook
 */
export function useAfterSalesData() {
  const loading = ref(false)
  const storeList = ref<IStoreInfo[]>([])
  /** 门店：页面绑的是**行对象**（`id` = dim_branch.code 自然键，提交侧取它当 storeCode） */
  const selectedStore = ref<any>(null)
  /** 选单选行（#500 段③）：选单 → 单内行两级；行里带 itemCode/orderNo/lineKey/priceMinor */
  const settlementLoading = ref(false)
  const settlementOrders = ref<SettlementOrderRow[]>([])
  const selectedOrder = ref<SettlementOrderRow | null>(null)
  /** 选中行 = 结算单行 + 所属单号（页面选行时摊上来；提交侧四键之一） */
  const selectedLine = ref<(SettlementLineRow & { orderNo: string }) | null>(null)

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
        filter: { OR: allowedIds.map((id) => ({ id__eq: id })) },
      })) as unknown as IStoreInfo[]
    } catch (error: any) {
      console.error('加载员工门店列表失败:', error)
      Message.error('加载门店列表失败')
    } finally {
      loading.value = false
    }
  }

  /**
   * 拉选中门店的近期结算单（#500 段③：建单挂原单的选单数据面）。
   * 门店变化必须**清空已选单/行**——跨店残留的选中行是串店引用（服务端 400 ORDER_STORE_MISMATCH）。
   */
  const loadSettlementOrders = async (storeCode: string) => {
    settlementLoading.value = true
    settlementOrders.value = []
    selectedOrder.value = null
    selectedLine.value = null
    if (!storeCode) return
    try {
      settlementOrders.value = await after_sales_work_order.settlementOrders(storeCode)
    } catch (error: any) {
      console.error('加载结算单列表失败:', error)
      Message.error(error?.message || '加载结算单列表失败')
    } finally {
      settlementLoading.value = false
    }
  }

  return {
    loading,
    storeList,
    selectedStore,
    settlementLoading,
    settlementOrders,
    selectedOrder,
    selectedLine,
    loadEmployeeStores,
    loadSettlementOrders,
  }
}
