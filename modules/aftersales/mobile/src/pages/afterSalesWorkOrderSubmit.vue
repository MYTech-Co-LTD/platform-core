<template>
  <div class="min-h-screen bg-[#FAFBFC]">
    <!-- 验证中 -->
    <div v-if="!employeeVerified" class="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <t-loading theme="circular" size="large" />
      <p class="mt-4 text-gray-600">正在验证员工信息...</p>
    </div>

    <!-- 主表单 -->
    <div v-else class="p-4 pb-24">
      <!-- 报损对象（2026-11-26 产品重构）：商品/门店/订单合成一张卡。
           密度优先：三行紧凑排列，一屏内完成选择；单店员工不给他做无意义的选择。 -->
      <t-card class="mb-3 rounded-xl shadow-sm">
        <div class="space-y-4">
          <!-- 门店：单店 ⇒ 只读标签（他只有这一家）；多店 ⇒ 下拉切换 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">门店</label>
            <div v-if="storeList.length <= 1" class="flex items-center gap-2 py-2">
              <i class="fa fa-store text-[#4D6BFE]"></i>
              <span class="text-gray-800 font-medium">{{ storeList[0]?.store_name ?? '—' }}</span>
              <span class="text-xs text-gray-400 tnum">{{ storeList[0]?.store_number }}</span>
            </div>
            <t-select
              v-else
              v-model="selectedStore"
              placeholder="请选择门店"
              :loading="loading"
              class="w-full"
              @change="handleStoreChange"
            >
              <t-option
                v-for="store in storeList"
                :key="store.id"
                :value="store.id"
                :label="store.store_name"
              >
                <div class="flex items-center justify-between min-w-0 gap-2">
                  <span class="font-medium truncate">{{ store.store_name }}</span>
                  <span class="text-xs text-gray-400 shrink-0">{{ store.store_number }}</span>
                </div>
              </t-option>
            </t-select>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-[#E5484D]">*</span>商品
            </label>
            <t-select
              v-model="selectedProduct"
              placeholder="搜索商品名称或编码"
              :loading="productLoading"
              filterable
              clearable
              class="w-full"
              @search="handleProductSearch"
              @change="handleProductChange"
            >
              <t-option
                v-for="product in productList"
                :key="product.id"
                :value="product.id"
                :label="product.product_name"
              >
                <div class="flex items-center justify-between min-w-0 gap-2">
                  <span
                    class="font-medium truncate"
                    :title="product.aliases?.length
                      ? `曾用名：${product.aliases.filter((a) => a !== product.product_name).join('、')}`
                      : undefined"
                  >{{ product.product_name }}</span>
                  <span class="text-xs text-gray-400 shrink-0 tnum">{{ product.id }}</span>
                </div>
              </t-option>
              <template #empty>
                <div class="py-3 text-center text-xs text-gray-400">
                  {{ productLoading ? '搜索中…' : '没有匹配的商品' }}
                </div>
              </template>
            </t-select>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-[#E5484D]">*</span>订单
            </label>
            <t-select
              v-model="selectedOrderNo"
              placeholder="选择进货单"
              :loading="settlementLoading"
              filterable
              :disabled="!selectedStore && !selectedProduct"
              class="w-full"
            >
              <t-option
                v-for="order in settlementOrders"
                :key="order.orderNo"
                :value="order.orderNo"
                :label="order.orderNo"
              >
                <div class="flex items-center justify-between min-w-0 gap-2">
                  <span class="font-medium truncate tnum">{{ order.orderNo }}</span>
                  <span class="text-xs text-gray-400 shrink-0 tnum">
                    {{ order.bizday }} · {{ order.lines[0]?.quantity ?? '—' }} 件
                  </span>
                </div>
              </t-option>
              <template #empty>
                <div class="py-3 text-center text-xs text-gray-400">
                  {{ settlementLoading ? '加载中…' : (selectedProduct ? '该商品近期没有进货单' : '没有可选的进货单') }}
                </div>
              </template>
            </t-select>
          </div>
        </div>
      </t-card>

      <!-- 商品信息卡（选中订单行后显示；对齐 wuji 的「商品信息」卡） -->
      <t-card v-if="selectedLine" class="mb-4 rounded-xl shadow-sm" title="商品信息">
        <div class="space-y-2 text-sm">
          <div class="flex justify-between">
            <span class="text-gray-600">单据号：</span>
            <span class="font-medium tnum">{{ selectedOrder?.orderNo }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">商品名称：</span>
            <span class="font-medium">{{ selectedLine.itemName ?? selectedLine.itemCode }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">基本数量：</span>
            <span class="tnum">{{ selectedLine.quantity ?? '—' }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">基本单价：</span>
            <span class="text-[#4D6BFE] tnum">¥{{ (selectedLine.priceMinor / 100).toFixed(2) }}<span class="text-xs text-gray-400 ml-1">（随单冻结）</span></span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">订货时间：</span>
            <span class="tnum">{{ selectedOrder?.bizday }}</span>
          </div>
        </div>
        <!-- 多行时让用户确认报的是哪一行（按单分只显示匹配行，通常只有 1 行） -->
        <div v-if="(selectedOrder?.lines?.length ?? 0) > 1" class="mt-3">
          <label class="block text-sm font-medium text-gray-700 mb-2">行（该单含多个匹配商品）</label>
          <t-select v-model="selectedLineKey" class="w-full">
            <t-option
              v-for="line in selectedOrder?.lines ?? []"
              :key="line.lineKey"
              :value="line.lineKey"
              :label="line.itemName ?? line.itemCode"
            />
          </t-select>
        </div>
      </t-card>

      <!-- 售后信息 -->
      <t-card class="mb-4 rounded-xl shadow-sm" title="售后信息">
        <div class="space-y-5">
          <!-- 到货日期 / 到货时间（2026-11-25 对齐 wuji 源交互）：售后判责的关键事实 ——
               什么时候到的货、什么时候坏的。提交时拼成 ISO 字符串进 `arrivalAt`。 -->
          <div class="flex flex-col sm:flex-row sm:items-center">
            <label class="text-sm font-medium text-gray-700 min-w-[80px]">
              <span class="text-[#E5484D]">*</span>到货日期
            </label>
            <div class="mt-2 sm:mt-0 sm:ml-4 flex-1">
              <t-date-picker
                v-model="arrivalDate"
                type="date"
                placeholder="请选择到货日期"
                format="YYYY-MM-DD"
                :clearable="false"
                size="small"
                class="w-full"
              />
            </div>
          </div>

          <div class="flex flex-col sm:flex-row sm:items-center">
            <label class="text-sm font-medium text-gray-700 min-w-[80px]">
              <span class="text-[#E5484D]">*</span>到货时间
            </label>
            <div class="mt-2 sm:mt-0 sm:ml-4 flex-1">
              <t-time-picker
                v-model="arrivalTime"
                placeholder="请选择到货时间"
                format="HH:mm"
                :clearable="false"
                size="small"
                class="w-full"
              />
            </div>
          </div>

          <!-- 报损数量（上界 = 该行数量；选中行后直接显示「共 N 件」） -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-[#E5484D]">*</span>报损数量
              <span v-if="selectedLine?.quantity" class="ml-2 text-xs font-normal text-gray-400 tnum">
                本单共 {{ selectedLine.quantity }} 件
              </span>
            </label>
            <div class="flex items-center gap-3">
              <t-input
                v-model="damageQuantityDisplay"
                type="number"
                placeholder="数量"
                size="small"
                class="damage-number-input w-28"
                @blur="handleDamageQuantityBlur"
              />
              <span v-if="selectedLine?.priceMinor" class="text-xs text-gray-400 tnum">
                预估退款 ¥{{ ((Number(formData.damage_quantity ?? 0)) * selectedLine.priceMinor / 100).toFixed(2) }}
              </span>
            </div>
          </div>

          <!-- 报损原因：常见原因一键选（这是高频输入），下方再补文字 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-[#E5484D]">*</span>报损原因
            </label>
            <div class="flex flex-wrap gap-2 mb-2">
              <button
                v-for="tag in REASON_TAGS"
                :key="tag"
                type="button"
                class="px-3 py-1 rounded-full text-xs border transition-colors"
                :style="reasonHas(tag)
                  ? { background: '#4D6BFE', color: '#fff', borderColor: '#4D6BFE' }
                  : { background: '#fff', color: '#6B7280', borderColor: '#EBEDF0' }"
                @click="toggleReasonTag(tag)"
              >
                {{ tag }}
              </button>
            </div>
            <t-textarea
              v-model="formData.damage_reason"
              placeholder="补充说明（可选）"
              :autosize="{ minRows: 2, maxRows: 6 }"
              maxlength="500"
              class="w-full"
            />
          </div>
        </div>
      </t-card>

      <!-- 附件上传 -->
      <t-card class="mb-4 rounded-xl shadow-sm" title="上传图片/视频">
        <label class="block text-sm font-medium text-gray-700 mb-3">
          <span class="text-[#E5484D]">*</span>附件上传
        </label>
        <div class="upload-wrapper">
          <!-- 图片网格 -->
          <div class="grid grid-cols-4 gap-2">
            <!-- 已上传的缩略图 -->
            <div
              v-for="(attachment, index) in attachments"
              :key="index"
              class="relative aspect-square rounded-lg overflow-hidden bg-gray-100"
              style="transform: translateZ(0)"
            >
              <!-- 图片缩略图 -->
              <img
                v-if="attachment.type === 'image'"
                :src="attachment.previewUrl"
                :alt="attachment.name"
                class="w-full h-full object-cover"
              />
              <!-- 视频缩略图 -->
              <div v-else class="relative w-full h-full bg-gray-200">
                <video
                  :src="attachment.previewUrl"
                  class="w-full h-full object-cover"
                  muted
                  playsinline
                  preload="metadata"
                />
                <div v-if="attachment.uploadStatus !== 'uploading'" class="absolute inset-0 flex items-center justify-center bg-black/40">
                  <div class="w-10 h-10 bg-white/90 rounded-full flex items-center justify-center">
                    <i class="fa fa-play text-gray-700 text-sm ml-0.5"></i>
                  </div>
                </div>
              </div>

              <!-- 上传进度蒙版 -->
              <div
                v-if="attachment.uploadStatus === 'uploading' || (attachment.uploadProgress !== undefined && attachment.uploadProgress < 100)"
                class="absolute inset-0 bg-black/60 flex items-center justify-center"
                style="z-index: 50;"
              >
                <!-- 圆形进度条 -->
                <div class="relative w-12 h-12">
                  <svg class="w-12 h-12 transform -rotate-90" viewBox="0 0 36 36">
                    <!-- 背景圆 -->
                    <circle
                      cx="18"
                      cy="18"
                      r="14"
                      fill="none"
                      stroke="rgba(255, 255, 255, 0.2)"
                      stroke-width="3"
                    />
                    <!-- 进度圆 -->
                    <circle
                      cx="18"
                      cy="18"
                      r="14"
                      fill="none"
                      :stroke-dasharray="`${attachment.uploadProgress || 0}, 100`"
                      stroke="#fff"
                      stroke-width="3"
                      stroke-linecap="round"
                      style="transition: stroke-dasharray 0.2s ease;"
                    />
                  </svg>
                  <!-- 进度文字 -->
                  <div class="absolute inset-0 flex items-center justify-center">
                    <span class="text-white text-xs font-bold">{{ attachment.uploadProgress || 0 }}%</span>
                  </div>
                </div>
              </div>

              <!-- 上传失败状态 -->
              <div
                v-if="attachment.uploadStatus === 'failed'"
                class="absolute inset-0 bg-[#E5484D]/80 flex items-center justify-center"
                style="z-index: 50;"
              >
                <div class="text-white text-center">
                  <i class="fa fa-exclamation-triangle text-2xl mb-1"></i>
                  <p class="text-xs">上传失败</p>
                </div>
              </div>

              <!-- 删除按钮 -->
              <button
                @click="handleRemoveAttachment(index)"
                class="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full flex items-center justify-center hover:bg-[#E5484D] transition-colors"
                style="z-index: 100 !important;"
              >
                <i class="fa fa-times text-xs"></i>
              </button>
            </div>

            <!-- 添加按钮 - 始终显示在最后 -->
            <div
              class="aspect-square rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center bg-gray-50 hover:border-[#4D6BFE] transition-colors cursor-pointer relative"
            >
              <i class="fa fa-plus text-2xl text-gray-400"></i>
              <!-- 隐藏的原生文件输入 -->
              <input
                ref="fileInputRef"
                type="file"
                multiple
                accept="image/*,video/*"
                class="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                style="font-size: 999px"
                @change="handleFileInputChange"
              />
            </div>
          </div>

          <!-- 只留上限，不留教程（DESIGN.md Copy Discipline） -->
          <p class="text-xs text-gray-400 mt-2">单个文件不超过 2G</p>
        </div>
      </t-card>
    </div>

    <!-- 底部提交按钮 -->
    <div v-if="employeeVerified" class="fixed bottom-0 left-0 right-0 bg-white border-t p-4 safe-area-inset-bottom z-10">
      <!-- 提交前摘要（2026-11-26）：按提交的那一刻，一眼确认「报的是什么」 -->
      <div v-if="selectedLine" class="flex items-center justify-between mb-2 px-1 text-xs text-gray-500">
        <span class="truncate">
          {{ selectedLine.itemName ?? selectedLine.itemCode }} × {{ formData.damage_quantity ?? 0 }}
        </span>
        <span class="shrink-0 tnum">{{ selectedOrder?.orderNo }}</span>
      </div>
      <t-button
        theme="primary"
        size="large"
        :loading="loading || isSubmitting"
        :disabled="isSubmitting"
        block
        @click="handleSubmit"
      >
        <i class="fa fa-paper-plane mr-2"></i>提交工单
      </t-button>
      <!-- 2026-11-25：本店工单列表入口（多店员工进列表页切换门店查看） -->
      <t-button theme="default" variant="text" size="small" block class="mt-2" @click="goMyTickets">
        <i class="fa fa-list mr-1"></i>查看我的工单
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@wujibase/wuji'
import { useAfterSalesWorkOrder } from '@/composables/useAfterSalesWorkOrder'
import { countSubmittable } from '@/composables/useWorkOrderSubmit'
import { employee_info, product_archive } from '@wujibase/wuji-data'
import dayjs from 'dayjs'

/**
 * 售后工单提交页（M3b-2：从 wuji-2 搬入后按 Task 8 改造）
 *
 * 相对源侧的六处改动：
 *   ① **登记闸门**：`onMounted` 先读「我的登记快照」，未登记 ⇒ 提示 + 跳 `register`，
 *      并**直接 return**（未登记的人不该看到可选门店，故后续门店/商品请求一个都不发）；
 *   ② **商品/订单两块换成「选店 → 选结算单 → 选商品行」三级**（#500 段③，2026-10-10）：
 *      金额依据 = 所选行的结算价（服务端按行冻结，页面上锁形提示）；报损数量上界改取
 *      **选中行**的数量（源侧取的是选中订单的）；
 *   ③ 删掉订单那一行与其派生的展示/写入（订单信息卡、前端算金额卡、到货日期/时间两个控件）
 *      ——域侧 `SubmitBody` 不收 `relatedOrder`，也不收到货时间；金额由服务端按规则快照算
 *      （spec §0.3 把「前端算金额」列为要消灭的模式）；
 *   ④ **摘除页内前端微信 OAuth**：访客身份由 session（HttpOnly cookie）给（spec §3.2），
 *      页面不再自持访客标识、不拼授权链接、不落 localStorage；
 *   ⑤ 提交成功后的提示与返回**保持源侧形状**（`Message.success({content,duration,onClose})`，
 *      `onClose` 里 `router.back()`）——`onClose` 由 Task 5 的 shim 保证会被调用；
 *   ⑥ 附件预览改用 `previewUrl`：域侧附件行没有可读 url（预签名 **PUT** 地址不是可读地址，
 *      spec §2.3），源侧那两处渲染已完成附件的写法会渲染成空白。
 *
 * `TDesign` 的下拉**认对象值**（`t-option :value` 直接绑行对象，实测标签正常回显），
 * 这是 ② 的前提：`selectedLine` 的终态是**结算单行 + 所属单号**，页面才能展示冻结价并把
 * 提交四键（store_code/item_code/order_no/line_key）凑齐。
 */

defineWujiPageMeta({
  title: '售后工单提交',
  description: '移动端售后工单提交页面',
  metaKeywords: '售后工单,提交,移动端',
})

const router = useRouter()

// 清除可能的缓存
console.info('售后工单提交页面已加载', new Date().toISOString())

// 员工信息验证
const employeeVerified = ref(false)

// 文件输入框引用
const fileInputRef = ref<HTMLInputElement | null>(null)

// 上传中状态
const isUploading = ref(false)

// 使用售后工单 composable
const composable = useAfterSalesWorkOrder() as any

const loading = composable.loading
const settlementLoading = composable.settlementLoading
const storeList = composable.storeList
const settlementOrders = composable.settlementOrders
const selectedStore = composable.selectedStore
const selectedOrder = composable.selectedOrder
const selectedLine = composable.selectedLine

// 2026-11-25：`t-option` 的 value 改用**稳定字符串**（orderNo / lineKey）。
// 原来直接绑对象（商品行还是每次渲染新建的对象）⇒ TDesign 的选中匹配靠值比较，
// 对象引用每次都变，选中态与 v-model 都不可靠——现象就是「选了单/行，商品信息带不出来」。
// 这里用字符串做 UI 值，再同步回 composable 的对象 ref（提交逻辑读的仍是对象）。
const selectedOrderNo = ref('')
const selectedLineKey = ref('')

// 商品选择（2026-11-25 对齐 wuji）：远程搜索，不做全量预载
const selectedProduct = ref('')
const productList = ref<Array<{ id: string; product_name: string; aliases?: string[] }>>([])
const productLoading = ref(false)
let productSearchTimer: ReturnType<typeof setTimeout> | null = null

const handleProductSearch = (q: string): void => {
  if (productSearchTimer) clearTimeout(productSearchTimer)
  if (!q || q.trim() === '') {
    productList.value = []
    return
  }
  productSearchTimer = setTimeout(async () => {
    productLoading.value = true
    try {
      const rows = await product_archive.query({
        filter: { product_name__contains: q.trim() },
        storeCode: selectedStore.value || undefined,
      })
      productList.value = rows as any
    } catch (e: any) {
      Message.error(e?.message || '加载商品失败')
    } finally {
      productLoading.value = false
    }
  }, 300)
}

// 商品变化 ⇒ 若已选门店，按「门店 + 商品」重拉订单（双过滤对齐 wuji）
const handleProductChange = (): void => {
  if (selectedStore.value) {
    loadSettlementOrders(selectedStore.value, selectedProduct.value || undefined)
  }
}

watch(selectedOrderNo, (no) => {
  const o = settlementOrders.value.find((x: any) => x.orderNo === no) ?? null
  selectedOrder.value = o
  // 按单分只显示匹配行 ⇒ 选中订单后**自动选中第一行**（多数单只有一行匹配）
  const first = o?.lines?.[0] ?? null
  selectedLineKey.value = first?.lineKey ?? ''
  selectedLine.value = first ? { ...first, orderNo: o!.orderNo } : null
  // 源系统同款：选单后把到货日期预填成该单的业务日期（用户仍可改）
  if (o?.bizday) arrivalDate.value = String(o.bizday).slice(0, 10)
})

// 报损原因快捷标签（2026-11-26 产品重构）：店员高频输入就是这几个词。
// 标签与文本框**共用同一个字段**——点标签即在文本里增删该词，用户仍可自由编辑，
// 高亮态由「文本是否包含该词」推出（不做第二份状态，避免两者漂移）。
const REASON_TAGS = ['压伤', '腐烂', '过期', '破损', '少件'] as const
const reasonHas = (tag: string): boolean =>
  String(formData.value.damage_reason ?? '').split('、').map((x) => x.trim()).includes(tag)
const toggleReasonTag = (tag: string): void => {
  const parts = String(formData.value.damage_reason ?? '')
    .split('、')
    .map((x) => x.trim())
    .filter(Boolean)
  formData.value.damage_reason = parts.includes(tag)
    ? parts.filter((x) => x !== tag).join('、')
    : [...parts, tag].join('、')
}

// 到货日期 / 时间（对齐 wuji 的两个必填控件）
const arrivalDate = ref<string>(dayjs().format('YYYY-MM-DD'))
const arrivalTime = ref<string>(dayjs().format('HH:mm'))

watch(selectedLineKey, (key) => {
  const line = selectedOrder.value?.lines?.find((l: any) => l.lineKey === key) ?? null
  selectedLine.value = line ? { ...line, orderNo: selectedOrder.value.orderNo } : null
})
const attachments = composable.attachments
const formData = composable.formData
const loadEmployeeStores = composable.loadEmployeeStores
const loadSettlementOrders = composable.loadSettlementOrders
const addAttachment = composable.addAttachment
const removeAttachment = composable.removeAttachment
const submitWorkOrder = composable.submitWorkOrder
const resetForm = composable.resetForm

// 提交中状态，防止重复提交
const isSubmitting = ref(false)

// 选店变化 ⇒ 拉该店的结算单（loadSettlementOrders 内部会清空已选单/行，防串店残留）
const handleStoreChange = (storeCode: unknown) => {
  // 换了门店，上一店的商品候选/已选商品不再可信（新搜索面按门店历史订单，跨店残留会错配）
  selectedProduct.value = ''
  productList.value = []
  loadSettlementOrders(
    typeof storeCode === 'string' ? storeCode : '',
  )
}
// 选单变化后的清理由 selectedOrderNo 的 watch 负责（见上），此处不再重复

// 报损数量显示值（支持两位小数）
const damageQuantityDisplay = computed({
  get: () => {
    const val = formData.value.damage_quantity
    return val === null || val === undefined ? '' : String(val)
  },
  set: (val: string) => {
    // 允许用户输入，在失去焦点时再验证和格式化
    const num = parseFloat(val)
    if (!isNaN(num)) {
      formData.value.damage_quantity = num
    } else if (val === '') {
      formData.value.damage_quantity = null
    }
  }
})

// 报损数量失去焦点时的处理
const handleDamageQuantityBlur = () => {
  const val = formData.value.damage_quantity
  if (val === null || val === undefined || val === 0) {
    formData.value.damage_quantity = null
    return
  }

  // 格式化为两位小数
  const formatted = Math.round(val * 100) / 100

  // 验证不超过该行数量（上界取自**选中的结算单行**——报损不得大于进货；行数量为空则不设上限）
  const max = selectedLine.value?.quantity
  if (max !== null && max !== undefined && formatted > max) {
    Message.warning(`报损数量不能超过该行数量 ${max}`)
    formData.value.damage_quantity = max
  } else {
    formData.value.damage_quantity = formatted
  }
}

// 删除附件
const handleRemoveAttachment = (index: number) => {
  try {
    removeAttachment(index)
  } catch (error) {
    Message.error('删除附件失败')
  }
}

// 文件选择变化处理
const handleFileInputChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])

  if (files.length === 0) {
    return
  }

  // 防止重复上传
  if (isUploading.value) {
    return
  }

  // 检查文件大小限制
  const maxSize = 2 * 1024 * 1024 * 1024 // 2G
  for (const file of files) {
    if (file.size > maxSize) {
      Message.warning(`文件 ${file.name} 超过2G限制`)
      setTimeout(() => {
        input.value = ''
      }, 100)
      return
    }
  }

  isUploading.value = true

  try {
    for (const file of files) {
      try {
        await addAttachment(file)
      } catch (error) {
        Message.error(`文件 ${file.name} 上传失败`)
      }
    }
  } finally {
    isUploading.value = false
    // 使用 setTimeout 延迟清空，避免影响移动端体验
    setTimeout(() => {
      input.value = ''
    }, 100)
  }
}

// 提交表单
const goMyTickets = () => router.push({ name: 'myTickets' })

const handleSubmit = async () => {
  const data = formData.value

  // 防止重复提交
  if (isSubmitting.value) {
    return
  }

  // 验证必填项（#500 段③：挂原单——选店 + 选单选行是取价前提，缺一不给提交）
  if (!selectedStore.value) {
    Message.warning('请选择门店')
    return
  }

  if (!selectedLine.value) {
    Message.warning('请选择订单（金额按该行结算价冻结）')
    return
  }

  // 到货日期 / 时间（2026-11-25 对齐 wuji：源侧两个必填控件）
  if (!arrivalDate.value || !arrivalTime.value) {
    Message.warning('请选择到货日期与到货时间')
    return
  }
  // 拼成带时区的 ISO 串（Asia/Shanghai）——服务端列是 timestamptz
  formData.value.arrival_time = dayjs(`${arrivalDate.value} ${arrivalTime.value}`).toISOString()

  if (!data.damage_quantity || data.damage_quantity <= 0) {
    Message.warning('请输入报损数量（支持两位小数）')
    return
  }

  // 验证报损数量不超过该行数量（上界取自**选中的结算单行**；行数量为空则不设上限）
  const maxQuantity = selectedLine.value?.quantity
  if (maxQuantity !== null && maxQuantity !== undefined && data.damage_quantity > maxQuantity) {
    Message.warning(`报损数量不能超过该行数量 ${maxQuantity}`)
    return
  }

  if (!data.damage_reason || data.damage_reason.trim().length < 2) {
    Message.warning('请输入报损原因（至少2个字符）')
    return
  }

  // 验证附件上传：**与发送同口径**——数「可提交的附件」（completed），不是数列表长度。
  // 列表里可能只有上传失败的行（失败行按实现留在列表里）⇒ 数长度的写法会放行，而发送侧
  // 过滤后是 0 条 ⇒ 服务端 201 建单、**零附件**落库，页面却提示「至少上传一个附件」（评审 F2）。
  // 口径定义在 `useWorkOrderSubmit`（`countSubmittable`），此处不另写一遍。
  if (countSubmittable(attachments.value) === 0) {
    Message.warning('请至少上传一个附件')
    return
  }

  // 开始提交
  isSubmitting.value = true

  try {
    // 提交
    const success = await submitWorkOrder()
    if (success) {
      // 重置表单
      resetForm()

      Message.success({
        content: '工单提交成功！',
        duration: 2000,
        onClose: () => {
          router.back()
        },
      })
    }
  } finally {
    isSubmitting.value = false
  }
}

// 初始化
onMounted(async () => {
  try {
    // 重置表单，确保每次进入页面时都是清空状态（含 UI 侧的字符串选择值）
    resetForm()
    selectedOrderNo.value = ''
    selectedLineKey.value = ''
    selectedProduct.value = ''
    productList.value = []

    // ① 闸门：先读「我的登记快照」。未登记 ⇒ 提示 + 跳登记页，**并且直接 return**——
    //    后面两句（门店 / 商品）一个都不发：未登记的人不该看到可选门店（spec §3.2）。
    //    注意这里**不 catch**：查询失败走外层 catch 的「初始化失败」提示，不要静默当成"未登记"
    //    而被误导去重填登记（那是把故障伪装成业务态）。
    const employees = await employee_info.query({ filter: { openId__eq: '' } })
    if (!employees || employees.length === 0) {
      Message.warning('请先完成员工登记')
      router.replace({ name: 'register' })
      return
    }

    employeeVerified.value = true

    // 源系统同款（2026-11-25）：进页面先预加载一页商品做**首屏候选**——点开下拉就有东西，
    // 不必先输关键词（此前漏了这步，用户点开是空的，被当成「没有商品」）。
    void product_archive
      .query({ pageSize: 100, singlePage: true })
      .then((rows) => { productList.value = rows as any })
      .catch(() => { /* 首屏预加载失败不阻断：用户输入时仍会按关键词搜 */ })

    // 加载页面数据（结算单在选店后按店拉取——handleStoreChange）
    await loadEmployeeStores() // 根据登记档里的门店 id 串加载「我的门店」

    // 单店员工：门店不是「选择」，是他所在的店——直接选定并拉该店订单，
    // 省掉一次无意义的点击（2026-11-26 产品重构）。多店仍由他选。
    if (storeList.value.length === 1) {
      selectedStore.value = storeList.value[0]!.id
      await loadSettlementOrders(selectedStore.value, selectedProduct.value || undefined)
    }
  } catch (error: any) {
    console.error('初始化失败:', error)
    Message.error(error?.message || '初始化失败，请稍后重试')
  }
})
</script>

<style scoped>
/* 底部安全区域适配 */
.safe-area-inset-bottom {
  padding-bottom: calc(1rem + env(safe-area-inset-bottom));
}

/* 滚动优化 */
:deep(.t-card) {
  overflow: visible;
}

/* 输入框和数字框样式 */
:deep(.t-input-number) {
  width: 100%;
}

/* 日期选择器样式 */
:deep(.t-date-picker) {
  width: 100%;
}

/* 时间选择器样式 */
:deep(.t-time-picker) {
  width: 100%;
}

/* 文本域样式 */
:deep(.t-textarea__inner) {
  width: 100%;
  transition: border-color 0.2s ease;
}

/* 上传区域样式优化 */
.upload-wrapper :deep(.t-upload__draggable) {
  border: none;
  padding: 0;
}

/* 下拉选项样式优化 */
:deep(.t-select-option) {
  padding: 8px 12px;
}

:deep(.t-select-option__content) {
  width: 100%;
}

/* 下拉框弹出层宽度限制 - 移动端不撑满屏幕 */
:deep(.t-popup__content) {
  max-width: 100vw;
}

/* 选择器下拉面板宽度限制 */
:deep(.t-select__dropdown) {
  max-width: calc(100vw - 2rem);
  left: 1rem !important;
  width: auto !important;
}

/* 移动端优化 */
@media (max-width: 640px) {
  :deep(.t-select__dropdown) {
    max-width: calc(100vw - 2rem);
  }

  /* 优化文件上传按钮在移动端的点击区域 */
  .upload-wrapper input[type="file"] {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    z-index: 100;
    -webkit-tap-highlight-color: transparent;
  }
}

/* 确保视频缩略图正确显示 */
:deep(video) {
  object-fit: cover;
  width: 100%;
  height: 100%;
}

/* 上传组件 overflow 修复 */
.upload-wrapper {
  isolation: isolate;
  overflow: visible;
}

.upload-wrapper .grid {
  isolation: isolate;
}

/* 缩略图卡片使用 GPU 加速 */
.upload-wrapper .aspect-square {
  isolation: isolate;
  contain: content;
  overflow: hidden;
  position: relative;
}

/* 删除按钮样式 */
.upload-wrapper .aspect-square button {
  isolation: isolate;
  z-index: 20 !important;
}
</style>
