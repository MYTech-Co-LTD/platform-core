/**
 * 售后工单主 composable（M3b-2：聚合数据/上传/提交三个子 composable）
 *
 * 聚合面**裁掉了订单那一行**（`orderList` / `loadOrders` / `clearOrders` 与 `currentOrder`）：
 * 旧「订单选择」不做（spec §3.2：域侧 `SubmitBody` 不收 `relatedOrder`）。`loadUserStores`
 * 同样不在面上——它是死码（见 `useAfterSalesData.ts` 头注）。
 *
 * #500 段③（2026-10-10）：选单选行回归，但**换了数据面**——不是旧的 `outbound_detail`
 * 出库明细，而是结算单取价面（`/guest/settlement-orders`，按单实际结算价）。
 *
 * 三个子 composable 之间只有**一条**接线：`useWorkOrderSubmit` 读数据面的选中门店/选中行与
 * 上传面的附件列表，因此这里把这三个 ref 传进去，而不是让提交侧自己再建一份。
 */

import { useAfterSalesData } from './useAfterSalesData'
import { useFileUpload } from './useFileUpload'
import { useWorkOrderSubmit } from './useWorkOrderSubmit'
import { formatTimeDisplay } from '@/utils/afterSalesHelpers'

export function useAfterSalesWorkOrder() {
  // 使用各个子模块
  const dataComposable = useAfterSalesData()
  const uploadComposable = useFileUpload()
  const submitComposable = useWorkOrderSubmit({
    selectedStore: dataComposable.selectedStore,
    selectedLine: dataComposable.selectedLine,
    attachments: uploadComposable.attachments,
  })

  // 从数据模块导出
  const {
    loading,
    storeList,
    settlementLoading,
    settlementOrders,
    selectedStore,
    selectedOrder,
    selectedLine,
    loadEmployeeStores,
    loadSettlementOrders,
  } = dataComposable

  // 从上传模块导出
  const { isUploading, attachments, addAttachment, removeAttachment, clearAttachments } = uploadComposable

  // 从提交模块导出
  const { submitting, formData, resetForm: resetSubmitForm, submitWorkOrder } = submitComposable

  /**
   * 源侧的「把附件从 temp 文件夹改名到工单号文件夹」在这里**没有可做的事情**，保留函数是
   * 为了让调用点与源侧同形：
   *   · shim 的 `uploadFile/uploadImage` **没有 copyFile**；
   *   · 更要紧的是这个动作的前提已经没了——对象的 key 由**服务端**在预签名时按
   *     `objectKeyFor(org, clientRequestId)` 决定（spec §2.3），客户端拼的那条 `temp/…`
   *     路径没有消费方，工单号也改由服务端生成（`AS-00000001`）。
   */
  const renameAttachments = async (_orderNumber: string): Promise<void> => {
    return
  }

  /**
   * 提交工单（包装提交逻辑）
   *
   * 源侧这里要先从 `orderList`/`storeList` 里查出选中的行再传进提交函数；改写后
   * `useWorkOrderSubmit` 直接持有选中项，故只剩「改名附件 → 提交」两步。
   */
  const handleSubmitWorkOrder = async () => {
    // 重命名附件（不再需要工单号）
    await renameAttachments('')

    return await submitWorkOrder()
  }

  /**
   * 完整重置表单
   */
  const resetForm = () => {
    selectedStore.value = null
    selectedOrder.value = null
    selectedLine.value = null
    settlementOrders.value = []
    clearAttachments()
    resetSubmitForm()
  }

  return {
    // 加载状态
    loading,
    settlementLoading,
    isUploading,
    submitting,

    // 数据列表
    storeList,
    settlementOrders,

    // 选中的值
    selectedStore,
    selectedOrder,
    selectedLine,

    // 附件
    attachments,

    // 表单数据
    formData,

    // 方法
    loadEmployeeStores,
    loadSettlementOrders,
    addAttachment,
    removeAttachment,
    submitWorkOrder: handleSubmitWorkOrder,
    resetForm,
    formatTime: formatTimeDisplay,
  }
}

// 导出类型（从类型文件导出，保持向后兼容）
export type { IWorkOrderFormData } from '@/types/afterSalesWorkOrder'
