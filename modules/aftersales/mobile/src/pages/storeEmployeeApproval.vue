<template>
  <div class="min-h-screen bg-gray-50">
    <!-- 加载状态 -->
    <div v-if="pageLoading" class="flex items-center justify-center py-20">
      <t-loading theme="circular" size="40px" text="加载中..." />
    </div>

    <!-- 主内容 -->
    <div v-else class="p-4 pb-24">
      <!-- 员工信息展示卡片（已注册员工） -->
      <div v-if="employeeInfo && !isEditing">
        <t-card class="mb-4 rounded-xl shadow-sm">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-medium text-gray-800">
              <i class="fa fa-user mr-2 text-blue-600"></i>员工信息
            </h2>
            <t-tag :theme="getApprovalStatusTheme(employeeInfo.status)">
              {{ getApprovalStatusText(employeeInfo.status) }}
            </t-tag>
          </div>

          <div class="space-y-4">
            <div class="flex items-center py-2 border-b border-gray-100">
              <span class="text-gray-500 w-24 shrink-0">姓名</span>
              <span class="text-gray-800 font-medium">{{ employeeInfo.employee_name }}</span>
            </div>
            <div class="flex items-center py-2 border-b border-gray-100">
              <span class="text-gray-500 w-24 shrink-0">联系电话</span>
              <span class="text-gray-800 font-medium">{{ employeeInfo.employee_phonenumber }}</span>
            </div>
            <div class="flex flex-col py-2 border-b border-gray-100">
              <span class="text-gray-500 mb-2">所属门店</span>
              <div class="flex flex-wrap gap-2">
                <t-tag
                  v-for="storeName in getStoreNames(employeeInfo.store_info)"
                  :key="storeName"
                  theme="primary"
                  size="small"
                >
                  {{ storeName }}
                </t-tag>
              </div>
            </div>
            <div class="flex items-center py-2">
              <span class="text-gray-500 w-24 shrink-0">注册时间</span>
              <span class="text-gray-800 text-sm">{{ formatTime(employeeInfo._ctime) }}</span>
            </div>
            <div class="flex items-center py-2">
              <span class="text-gray-500 w-24 shrink-0">修改时间</span>
              <span class="text-gray-800 text-sm">{{ formatTime(employeeInfo._mtime) }}</span>
            </div>
          </div>
        </t-card>

        <!-- 审批状态说明 -->
        <t-card v-if="employeeInfo.status === '待审批'" class="mb-4 rounded-xl shadow-sm bg-yellow-50 border-yellow-200">
          <div class="flex items-start gap-3">
            <i class="fa fa-clock text-yellow-600 text-xl mt-0.5"></i>
            <div class="text-sm text-gray-700">
              <p class="font-medium mb-1">您的信息正在审批中</p>
              <p class="text-gray-600">管理员将在1-3个工作日内完成审批，请耐心等待。</p>
            </div>
          </div>
        </t-card>

        <!-- 审批通过说明 -->
        <t-card v-else-if="employeeInfo.status === '通过'" class="mb-4 rounded-xl shadow-sm bg-green-50 border-green-200">
          <div class="flex items-start gap-3">
            <i class="fa fa-check-circle text-green-600 text-xl mt-0.5"></i>
            <div class="text-sm text-gray-700">
              <p class="font-medium mb-1">您的信息已审核通过</p>
              <p class="text-gray-600">您的门店员工身份已生效，可以正常使用系统功能。</p>
            </div>
          </div>
        </t-card>

        <!-- 审批驳回说明 -->
        <t-card v-else-if="employeeInfo.status === '驳回'" class="mb-4 rounded-xl shadow-sm bg-red-50 border-red-200">
          <div class="flex items-start gap-3">
            <i class="fa fa-times-circle text-red-600 text-xl mt-0.5"></i>
            <div class="text-sm text-gray-700">
              <p class="font-medium mb-1">您的信息审核未通过</p>
              <p class="text-gray-600">请检查填写的信息是否正确，重新提交申请。</p>
            </div>
          </div>
        </t-card>

        <!-- 编辑按钮 -->
        <t-button
          v-if="employeeInfo.status !== '待审批'"
          theme="primary"
          size="large"
          block
          @click="handleEdit"
        >
          <i class="fa fa-edit mr-2"></i>编辑信息
        </t-button>
      </div>

      <!-- 注册/编辑表单 -->
      <div v-else>
        <!-- 表单标题 -->
        <t-card class="mb-4 rounded-xl shadow-sm bg-gradient-to-r from-blue-50 to-blue-100">
          <div class="flex items-center gap-3">
            <i class="fa fa-info-circle text-blue-600 text-xl"></i>
            <div class="text-sm text-gray-700">
              <p class="font-medium">{{ isEditing ? '编辑员工信息' : '注册成为门店员工' }}</p>
              <p class="text-gray-600">{{ isEditing ? '修改后需要重新提交审批' : '提交后需要等待管理员审批' }}</p>
            </div>
          </div>
        </t-card>

        <!-- 员工姓名 -->
        <t-card class="mb-4 rounded-xl shadow-sm">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-red-500">*</span>员工姓名
            </label>
            <t-input
              v-model="formData.employee_name"
              placeholder="请输入员工姓名"
              clearable
              size="large"
              class="w-full"
            />
          </div>
        </t-card>

        <!-- 联系电话 -->
        <t-card class="mb-4 rounded-xl shadow-sm">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-red-500">*</span>联系电话
            </label>
            <t-input
              v-model="formData.employee_phonenumber"
              placeholder="请输入联系电话"
              clearable
              size="large"
              class="w-full"
              maxlength="11"
            />
          </div>
        </t-card>

        <!-- 所属门店 -->
        <t-card class="mb-4 rounded-xl shadow-sm">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              <span class="text-red-500">*</span>所属门店（可多选）
            </label>
            <t-select
              v-model="formData.store_info"
              placeholder="请输入门店名称或编号搜索"
              filterable
              clearable
              multiple
              size="large"
              :loading="loading"
              :reserve-keyword="true"
              class="w-full"
              @search="handleStoreSearch"
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
            <p class="text-xs text-gray-400 mt-2">
              <i class="fa fa-info-circle mr-1"></i>可选择多个门店，最多5个
            </p>
          </div>
        </t-card>

        <!-- 提交按钮 -->
        <t-button
          theme="primary"
          size="large"
          :loading="submitting"
          :disabled="submitting"
          block
          @click="handleSubmit"
        >
          <i class="fa fa-paper-plane mr-2"></i>{{ isEditing ? '提交修改' : '提交注册' }}
        </t-button>

        <!-- 取消按钮（仅编辑模式显示） -->
        <t-button
          v-if="isEditing"
          theme="default"
          size="large"
          variant="outline"
          class="mt-3"
          block
          @click="handleCancel"
        >
          <i class="fa fa-times mr-2"></i>取消编辑
        </t-button>
      </div>
    </div>

    <!-- 底部安全区域 -->
    <div class="safe-area-inset-bottom" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { Message } from '@wujibase/wuji'
import { useStoreEmployeeApproval } from '@/composables/useStoreEmployeeApproval'
import dayjs from 'dayjs'

// 常量
const STORE_SEARCH_DEBOUNCE_MS = 300
const MAX_STORE_COUNT = 5

// 防抖定时器
let storeSearchTimer: ReturnType<typeof setTimeout> | null = null

defineWujiPageMeta({
  title: '门店员工信息',
  description: '门店员工信息注册和编辑页面',
  metaKeywords: '门店,员工,注册,审批',
})

const route = useRoute()

// 使用 composable
const composable = useStoreEmployeeApproval()

const pageLoading = composable.pageLoading
const loading = composable.loading
const employeeInfo = composable.employeeInfo
const storeList = composable.storeList
const formData = composable.formData
const loadStores = composable.loadStores
const loadSelectedStores = composable.loadSelectedStores
const loadEmployeeInfo = composable.loadEmployeeInfo
const submitApproval = composable.submitApproval

const isEditing = ref(false)
const submitting = ref(false)

/**
 * 获取多个门店名称
 */
const getStoreNames = (storeInfo: string): string[] => {
  if (!storeInfo) return []

  const storeIds = storeInfo.split(',').filter(id => id.trim())

  return storeIds.map(storeId => {
    const store = storeList.value.find((s: any) => s.id === storeId.trim())
    return store?.store_name || storeId
  })
}

/**
 * 获取审批状态主题
 */
const getApprovalStatusTheme = (status: string): 'warning' | 'success' | 'danger' | 'default' => {
  const statusMap: Record<string, 'warning' | 'success' | 'danger' | 'default'> = {
    待审批: 'warning',
    通过: 'success',
    驳回: 'danger',
  }
  return statusMap[status] || 'default'
}

/**
 * 获取审批状态文本
 */
const getApprovalStatusText = (status: string): string => {
  const textMap: Record<string, string> = {
    待审批: '待审批',
    通过: '已通过',
    驳回: '已驳回',
  }
  return textMap[status] || status
}

/**
 * 格式化时间
 */
const formatTime = (time: string): string => {
  if (!time) return '-'
  return dayjs(time).format('YYYY-MM-DD HH:mm')
}

/**
 * 门店搜索（防抖处理）
 */
const handleStoreSearch = (searchText: string): void => {
  if (storeSearchTimer) {
    clearTimeout(storeSearchTimer)
  }

  if (!searchText || searchText.trim().length === 0) {
    storeList.value = []
    return
  }

  storeSearchTimer = setTimeout(() => {
    loadStores(searchText)
  }, STORE_SEARCH_DEBOUNCE_MS)
}

/**
 * 进入编辑模式
 */
const handleEdit = (): void => {
  if (!employeeInfo.value) return

  isEditing.value = true

  const storeInfoArray = employeeInfo.value.store_info
    ? employeeInfo.value.store_info.split(',').map((id: string) => id.trim()).filter((id: string) => id)
    : []

  formData.value = {
    employee_name: employeeInfo.value.employee_name,
    employee_phonenumber: employeeInfo.value.employee_phonenumber,
    store_info: storeInfoArray,
  }
}

/**
 * 取消编辑
 */
const handleCancel = (): void => {
  isEditing.value = false
  formData.value = {
    employee_name: '',
    employee_phonenumber: '',
    store_info: '',
  }
}

/**
 * 提交表单
 */
const handleSubmit = async (): Promise<void> => {
  const data = formData.value

  // 验证必填项
  if (!data.employee_name?.trim()) {
    Message.warning('请输入员工姓名')
    return
  }

  if (!data.employee_phonenumber?.trim()) {
    Message.warning('请输入联系电话')
    return
  }

  // 验证手机号格式
  const phoneReg = /^1[3-9]\d{9}$/
  if (!phoneReg.test(data.employee_phonenumber)) {
    Message.warning('请输入正确的手机号码')
    return
  }

  // 验证门店选择
  if (!data.store_info || (Array.isArray(data.store_info) && data.store_info.length === 0)) {
    Message.warning('请选择所属门店')
    return
  }

  // 验证门店数量限制
  if (Array.isArray(data.store_info) && data.store_info.length > MAX_STORE_COUNT) {
    Message.warning(`最多只能选择${MAX_STORE_COUNT}个门店`)
    return
  }

  submitting.value = true

  try {
    const approveType = isEditing.value ? '变更' : '注册'

    const success = await submitApproval(approveType)

    if (success) {
      Message.success({
        content: isEditing.value ? '信息修改已提交，等待审批' : '注册已提交，等待审批',
        duration: 2000,
        onClose: () => {
          loadEmployeeInfo()
          isEditing.value = false
        },
      })
    }
  } catch (error: any) {
    console.error('提交失败:', error)
    Message.error(error?.message || '提交失败，请稍后重试')
  } finally {
    submitting.value = false
  }
}

/**
 * 初始化页面：身份由 session 给（宿主已保证访客已登录），页面不再自持 openid。
 */
onMounted(async () => {
  pageLoading.value = true

  await loadEmployeeInfo()

  if (!employeeInfo.value) {
    isEditing.value = false
  } else if (employeeInfo.value.store_info) {
    // 已登记 ⇒ 门店 id 串换数组，交给「已选门店」那条批量取回（域侧 `/guest/stores?ids=` 一次请求）
    await loadSelectedStores(
      String(employeeInfo.value.store_info)
        .split(',')
        .map((id: string) => id.trim())
        .filter((id: string) => id),
    )
  }

  pageLoading.value = false
})
</script>

<style scoped>
/* 底部安全区域适配 */
.safe-area-inset-bottom {
  height: calc(env(safe-area-inset-bottom));
}
</style>
