/**
 * 售后工单提交逻辑（M3b-2：从 wuji-2 搬入后**改写**）
 *
 * 三处改写，每一处都对应 spec 对源侧的收窄：
 *   ① **删掉 `generateOrderNumber()`**：它走 `after_sales_work_order.count` 按前缀数单、
 *      自己拼 `YYMMDD+5位序号`，而域侧工单号由**服务端**生成（`AS-00000001`，spec §2.2 ③）——
 *      前端数单是**第二份编号源**（并发下还会撞号）。
 *   ② **payload 收成域侧要的键**：#500 段③ 起建单**挂原单**——`store_code/item_code/
 *      order_no/line_key` 四键锁行，金额由服务端按该行结算价**冻结**。源侧那 23 键里的
 *      金额（`damage_amount`）与档案字段全部不发。
 *   ③ **`clientRequestId` 语义③（成功后轮换）落在这里**，见 `submitWorkOrder` 内注。
 */

import { ref } from 'vue'
import { Message } from '@wujibase/wuji'
import { after_sales_work_order } from '@wujibase/wuji-data'
import { rotateClientRequestId } from '@/shims/client-request-id'
import type { SettlementLineRow } from '@wujibase/wuji-data'
import type { IWorkOrderFormData } from '@/types/afterSalesWorkOrder'

export type { IWorkOrderFormData }

/**
 * 提交侧只读附件的**一个**字段：`uploadStatus`（`attachmentId` 由 data shim 自己从行上认领）。
 * 它是 `IAttachment` 的**结构子集**——提交只依赖这一点，故不导入整型，免得把「预览怎么显示」
 * 也拖进提交侧。
 */
export interface SubmittableAttachment {
  uploadStatus?: string
  attachmentId?: number | null
}

/**
 * **提交口径**（F2）：只有 `uploadStatus === 'completed'` 的附件算「有附件」。
 *
 * 这份口径只在这里定义一次，闸门（提交页）与发送（`submitWorkOrder`）都来问它——两处各写一遍
 * 就是两份口径，而它们**已经分叉过一次**：闸门数的是 `attachments.length`（列表长度），
 * 发送按状态过滤。上传失败的行**留在列表里**（`useFileUpload` 的 failed 分支不删行）⇒
 * 闸门放行、过滤后 0 条 ⇒ data shim 的 `attachmentIds.length > 0 ? … : {}` **不发**
 * attachmentIds ⇒ 服务端 201 建单、**零附件**落库，而页面文案是「请至少上传一个附件」。
 */
export const isSubmittable = (a: SubmittableAttachment): boolean => a.uploadStatus === 'completed'

/** 可提交附件的条数——提交页闸门的判据（与 `submitWorkOrder` 同一口径）。 */
export const countSubmittable = (list: readonly SubmittableAttachment[]): number =>
  list.filter(isSubmittable).length

/**
 * 选中门店可能是**行对象**（页面绑 `:value="store"`，`id` = dim_branch.code），也可能是
 * 直接绑出来的**编码字符串**——两种都收。
 */
const pickStoreCode = (v: unknown): string => {
  if (v !== null && typeof v === 'object') {
    const code = (v as { id?: unknown }).id
    return typeof code === 'string' ? code : ''
  }
  return typeof v === 'string' ? v : ''
}

/**
 * 售后工单提交 hook
 *
 * 依赖（选中门店/结算单行与附件列表）由聚合器 `useAfterSalesWorkOrder` 从数据/上传两个
 * composable 传进来：提交要读的正是它们持有的那一份 ref，自己再建一份就是第二份事实。
 */
export function useWorkOrderSubmit(deps: {
  selectedStore: { value: unknown }
  /** 页面选中行 = 结算单行 + 其所属单号（选行时由页面把单号摊上来） */
  selectedLine: { value: (SettlementLineRow & { orderNo: string }) | null }
  attachments: { value: SubmittableAttachment[] }
}) {
  const { selectedStore, selectedLine, attachments } = deps

  const submitting = ref(false)

  /**
   * 只声明本 composable 真正读写的两个字段。`IWorkOrderFormData` 的其余字段属于页面的编排，
   * **不在这里拼全**——拼全了类型一收窄这里就编译不过。
   */
  const emptyForm = (): IWorkOrderFormData =>
    ({ damage_quantity: 1, damage_reason: '' }) as IWorkOrderFormData

  const formData = ref<IWorkOrderFormData>(emptyForm())

  /** 重置表单 */
  const resetForm = () => {
    formData.value = emptyForm()
  }

  /**
   * 提交工单。域侧 `POST /guest/tickets` 收自然键 + 挂原单行级三元组（#500 段③，spec §6.2）：
   * **工单号与金额都由服务端出**，前端一个都不算。
   */
  const submitWorkOrder = async (): Promise<boolean> => {
    const storeCode = pickStoreCode(selectedStore.value)
    if (!storeCode) {
      Message.warning('请选择门店')
      return false
    }
    const line = selectedLine.value
    if (!line) {
      Message.warning('请先选择结算单与商品行')
      return false
    }
    if (formData.value.damage_quantity === null || formData.value.damage_quantity === undefined || formData.value.damage_quantity <= 0) {
      Message.warning('请输入报损数量（支持两位小数）')
      return false
    }
    submitting.value = true
    try {
      await after_sales_work_order.create({
        store_code: storeCode,
        item_code: line.itemCode,
        order_no: line.orderNo,
        line_key: line.lineKey,
        damage_quantity: formData.value.damage_quantity,
        damage_reason: formData.value.damage_reason,
        // 只带**已完成**的附件：上传中的带上会被服务端按 id 认领，而对象可能还没落。
        // 判据取自 `isSubmittable`——与提交页闸门共用同一份口径（F2）。
        damage_images: attachments.value.filter(isSubmittable),
      })

      // ⚠️ 语义③：**成功后必须轮换幂等键**。不轮换的症状是——同一会话提交第二笔时服务端
      //    按幂等键判重、静默返回第一笔（`duplicated: true`），而前端显示「提交成功」：
      //    用户以为提交了新工单，落库的却是旧的那笔（spec §3.2）。
      //    `duplicated: true` 也算成功（这一笔确实已落库），故一并轮换。
      //    失败**不轮换**（catch 里没有这句）：同一笔重试要用同一个键，幂等才成立。
      rotateClientRequestId()
      return true
    } catch (error: any) {
      // 源侧那段 'Failed to resolve module specifier' 的特判是**无极宿主的**动态 import 失败，
      // 平台没有这条宿主路径 ⇒ 删掉，不要带着一段永不触发的死代码。
      Message.error(error?.message || '工单提交失败')
      return false
    } finally {
      submitting.value = false
    }
  }

  return {
    submitting,
    formData,
    resetForm,
    submitWorkOrder,
  }
}
