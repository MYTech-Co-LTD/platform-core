<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 验证中 -->
    <div v-if="!employeeVerified" class="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <t-loading theme="circular" size="large" />
      <p class="mt-4 text-gray-600">正在验证员工信息...</p>
    </div>

    <!-- 主表单 -->
    <div v-else class="p-4 pb-24">
      <!-- 商品名称选择 -->
      <t-card class="mb-4 rounded-xl shadow-sm" hover-shadow>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">
            <span class="text-red-500">*</span>商品名称
          </label>
          <t-select
            v-model="selectedProduct"
            placeholder="请输入商品名称或代码搜索"
            :loading="productLoading"
            filterable
            clearable
            class="w-full"
            @search="handleProductSearch"
          >
            <t-option
              v-for="product in productList"
              :key="product.id"
              :value="product"
              :label="product.product_name"
            >
              <div class="flex items-center justify-between min-w-0 gap-2">
                <span class="font-medium truncate">{{ product.product_name }}</span>
                <span class="text-xs text-gray-400 shrink-0">{{ product.id }}</span>
              </div>
            </t-option>
          </t-select>
        </div>
      </t-card>

      <!-- 门店选择 -->
      <t-card class="mb-4 rounded-xl shadow-sm" hover-shadow>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">
            <span class="text-red-500">*</span>选择门店
          </label>
          <t-select
            v-model="selectedStore"
            placeholder="请选择门店"
            :loading="loading"
            filterable
            clearable
            class="w-full"
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
      </t-card>

      <!-- 售后信息 -->
      <t-card class="mb-4 rounded-xl shadow-sm" title="售后信息">
        <div class="space-y-5">
          <!-- 报损数量 -->
          <div class="flex items-center">
            <label class="text-sm font-medium text-gray-700 min-w-[80px]">
              <span class="text-red-500">*</span>报损数量
            </label>
            <div class="ml-4">
              <t-input
                v-model="damageQuantityDisplay"
                type="number"
                :placeholder="`请输入报损数量（最大${selectedProduct?.basic_quantity || 0}）`"
                size="small"
                class="damage-number-input"
                @blur="handleDamageQuantityBlur"
              />
            </div>
          </div>

          <!-- 报损原因 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-3">
              <span class="text-red-500">*</span>报损原因
            </label>
            <t-textarea
              v-model="formData.damage_reason"
              placeholder="请详细描述报损原因"
              :autosize="{ minRows: 4, maxRows: 8 }"
              maxlength="500"
              class="w-full"
            />
          </div>
        </div>
      </t-card>

      <!-- 附件上传 -->
      <t-card class="mb-4 rounded-xl shadow-sm" title="上传图片/视频">
        <label class="block text-sm font-medium text-gray-700 mb-3">
          <span class="text-red-500">*</span>附件上传
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
                class="absolute inset-0 bg-red-500/80 flex items-center justify-center"
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
                class="absolute top-1 right-1 w-5 h-5 bg-black/50 text-white rounded-full flex items-center justify-center hover:bg-red-500 transition-colors"
                style="z-index: 100 !important;"
              >
                <i class="fa fa-times text-xs"></i>
              </button>
            </div>

            <!-- 添加按钮 - 始终显示在最后 -->
            <div
              class="aspect-square rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center bg-gray-50 hover:border-blue-400 transition-colors cursor-pointer relative"
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

          <!-- 提示文本 -->
          <p class="text-xs text-gray-400 mt-2">
            <i class="fa fa-info-circle mr-1"></i>
            可选择多张图片或视频上传，单个文件不超过2G
          </p>
        </div>
      </t-card>
    </div>

    <!-- 底部提交按钮 -->
    <div v-if="employeeVerified" class="fixed bottom-0 left-0 right-0 bg-white border-t p-4 safe-area-inset-bottom z-10">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@wujibase/wuji'
import { useAfterSalesWorkOrder } from '@/composables/useAfterSalesWorkOrder'
import { employee_info } from '@wujibase/wuji-data'

/**
 * 售后工单提交页（M3b-2：从 wuji-2 搬入后按 Task 8 改造）
 *
 * 相对源侧的六处改动：
 *   ① **登记闸门**：`onMounted` 先读「我的登记快照」，未登记 ⇒ 提示 + 跳 `register`，
 *      并**直接 return**（未登记的人不该看到可选门店，故后续门店/商品请求一个都不发）；
 *   ② **订单选择整块换成商品选择**：商品下拉扛起全部选择职责，报损数量的上界改取
 *      **选中商品**的基本数量（源侧取的是选中订单的）；
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
 * 这是 ② 的前提：`selectedProduct` 的终态是**商品行**，页面才能读它的 `basic_quantity`。
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
const productLoading = composable.productLoading
const storeList = composable.storeList
const productList = composable.productList
const selectedStore = composable.selectedStore
const selectedProduct = composable.selectedProduct
const attachments = composable.attachments
const formData = composable.formData
const loadEmployeeStores = composable.loadEmployeeStores
const loadProducts = composable.loadProducts
const addAttachment = composable.addAttachment
const removeAttachment = composable.removeAttachment
const submitWorkOrder = composable.submitWorkOrder
const resetForm = composable.resetForm

// 提交中状态，防止重复提交
const isSubmitting = ref(false)

// 防抖定时器
let productSearchTimer: any = null

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

  // 验证不超过最大数量（上界取自**选中的商品**）
  const max = selectedProduct.value?.basic_quantity || 0
  if (formatted > max) {
    Message.warning(`报损数量不能超过基本数量 ${max}`)
    formData.value.damage_quantity = max
  } else {
    formData.value.damage_quantity = formatted
  }
}

// 商品搜索（防抖处理）
const handleProductSearch = (searchText: string) => {
  // 清除之前的定时器
  if (productSearchTimer) {
    clearTimeout(productSearchTimer)
  }

  // 防抖300ms后执行搜索
  productSearchTimer = setTimeout(() => {
    loadProducts(searchText)
  }, 300)
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
const handleSubmit = async () => {
  const data = formData.value

  // 防止重复提交
  if (isSubmitting.value) {
    return
  }

  // 验证必填项
  if (!selectedProduct.value) {
    Message.warning('请选择商品')
    return
  }

  if (!selectedStore.value) {
    Message.warning('请选择门店')
    return
  }

  if (!data.damage_quantity || data.damage_quantity <= 0) {
    Message.warning('请输入报损数量（支持两位小数）')
    return
  }

  // 验证报损数量不超过基本数量（上界取自**选中的商品**）
  const maxQuantity = selectedProduct.value?.basic_quantity || 0
  if (data.damage_quantity > maxQuantity) {
    Message.warning(`报损数量不能超过基本数量 ${maxQuantity}`)
    return
  }

  if (!data.damage_reason || data.damage_reason.trim().length < 2) {
    Message.warning('请输入报损原因（至少2个字符）')
    return
  }

  // 验证附件上传
  if (attachments.value.length === 0) {
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
    // 重置表单，确保每次进入页面时都是清空状态
    resetForm()

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

    // 加载页面数据
    await loadEmployeeStores() // 根据登记档里的门店 id 串加载「我的门店」
    // 加载初始商品列表（放在最后，避免报错）
    loadProducts('').catch((err: any) => {
      console.error('加载商品列表失败:', err)
    })
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
