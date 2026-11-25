<template>
  <div class="min-h-screen bg-[#FAFBFC]">
    <!-- 加载 -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <t-loading theme="circular" size="40px" text="加载中..." />
    </div>

    <!-- 未登记 ⇒ 引导去注册（归属执法后，无档案看不到任何单） -->
    <div v-else-if="!employeeInfo" class="p-4">
      <t-card class="rounded-xl shadow-sm bg-[#EEF1FF]">
        <div class="flex items-start gap-3">
          <i class="fa fa-info-circle text-[#4D6BFE] text-xl mt-0.5"></i>
          <div class="text-sm text-gray-700">
            <p class="font-medium mb-1">还没有门店员工身份</p>
            <p class="text-gray-600">注册并通过审批后，就能提交售后单、查看本门店的工单。</p>
          </div>
        </div>
      </t-card>
      <t-button theme="primary" size="large" block class="mt-4" @click="goRegister">
        <i class="fa fa-user-plus mr-2"></i>去注册
      </t-button>
    </div>

    <!-- 主内容 -->
    <div v-else class="p-4 pb-24">
      <!-- 门店切换：只在多店时有意义；单店隐藏（不制造无意义的选择） -->
      <div v-if="myStores.length > 1" class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">查看门店</label>
        <t-select v-model="selectedStore" class="w-full" @change="handleStoreChange">
          <t-option
            v-for="s in myStores"
            :key="s.code"
            :value="s.code"
            :label="s.name"
          />
        </t-select>
      </div>
      <div v-else-if="myStores.length === 1" class="mb-4 flex items-center gap-2 text-sm text-gray-500">
        <i class="fa fa-store"></i>{{ myStores[0].name }}
      </div>

      <!-- 列表 -->
      <t-card v-if="tickets.length > 0" class="rounded-xl shadow-sm">
        <div
          v-for="t in tickets"
          :key="t.id"
          class="flex items-start justify-between gap-3 py-3 border-b border-gray-100 last:border-b-0"
          @click="goDetail(t.id)"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-medium text-gray-800 truncate">{{ t.product_name }}</span>
              <span class="text-xs text-gray-400 shrink-0 tnum">{{ t.code }}</span>
            </div>
            <div class="text-xs text-gray-500">
              ×{{ t.damage_quantity }} · {{ formatTime(t.created_at) }}
            </div>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <span class="inline-flex items-center gap-1.5 text-sm" :style="{ color: statusColor(t.status) }">
              <i class="inline-block h-1.5 w-1.5 rounded-full" :style="{ background: statusColor(t.status) }" />
              {{ statusText(t.status) }}
            </span>
            <span v-if="t.amount_minor !== null" class="text-sm text-gray-700 tnum">{{ formatMinor(t.amount_minor) }}</span>
          </div>
        </div>
      </t-card>
      <t-card v-else class="rounded-xl shadow-sm">
        <div class="py-10 text-center text-sm text-gray-400">
          该门店还没有工单
        </div>
      </t-card>

      <!-- 分页（服务端真分页） -->
      <div v-if="total > size" class="flex items-center justify-center gap-4 mt-4 text-sm">
        <t-button size="small" variant="outline" :disabled="page <= 1" @click="changePage(page - 1)">上一页</t-button>
        <span class="text-gray-500 tnum">{{ page }} / {{ Math.ceil(total / size) }}</span>
        <t-button size="small" variant="outline" :disabled="page * size >= total" @click="changePage(page + 1)">下一页</t-button>
      </div>

      <t-button theme="primary" size="large" block class="mt-6" @click="goSubmit">
        <i class="fa fa-plus mr-2"></i>提交售后单
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@wujibase/wuji'
import { after_sales_work_order, employee_info, store_info } from '@/shims/wuji-data'
import type { TicketListRow } from '@/shims/wuji-data'
import dayjs from 'dayjs'

defineWujiPageMeta({
  title: '我的工单',
  description: '查看本门店的售后工单',
  metaKeywords: '售后,工单,门店',
})

/** 「记住上次选择」的键（人定口径：多店员工默认回到上次看的店） */
const LAST_STORE_KEY = 'aftersales:lastStoreCode'

const router = useRouter()

const loading = ref(true)
const employeeInfo = ref<any>(null)
const myStores = ref<Array<{ code: string; name: string }>>([])
const selectedStore = ref('')
const tickets = ref<TicketListRow[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(20)

const storeCodesOf = (storeInfo: unknown): string[] => {
  if (!storeInfo) return []
  const arr = Array.isArray(storeInfo) ? storeInfo : String(storeInfo).split(',')
  return arr.map((x) => String(x).trim()).filter(Boolean)
}

/** 门店名从发布快照取（code 是自然键，id 也是 code——见 shim 映射） */
const loadMyStores = async (codes: string[]) => {
  if (codes.length === 0) return []
  const rows = await store_info.query({ filter: { OR: codes.map((c) => ({ id__eq: c })) } })
  return codes.map((code) => ({
    code,
    name: rows.find((r: any) => r.id === code)?.store_name ?? code,
  }))
}

const loadTickets = async () => {
  try {
    const body = await after_sales_work_order.query({
      storeCode: selectedStore.value || undefined,
      page: page.value,
      size: size.value,
    })
    tickets.value = body.items
    total.value = body.total
  } catch (e: any) {
    Message.error(e?.message || '加载工单失败')
  }
}

const handleStoreChange = async (code: string) => {
  selectedStore.value = code
  localStorage.setItem(LAST_STORE_KEY, code)
  page.value = 1
  await loadTickets()
}

const changePage = async (p: number) => {
  page.value = p
  await loadTickets()
}

const goDetail = (id: number) => {
  router.push({ name: 'ticketDetail', params: { id } })
}
const goSubmit = () => router.push({ name: 'submit' })
const goRegister = () => router.push({ name: 'register' })

const statusText = (s: string) => ({ pending: '待处理', completed: '已处理', cancelled: '已驳回' }[s] ?? s)
const statusColor = (s: string) =>
  ({ pending: '#E08A00', completed: '#0FA958', cancelled: '#E5484D' }[s] ?? '#C9CDD4')
const formatTime = (t: string) => (t ? dayjs(t).format('MM-DD HH:mm') : '-')
const formatMinor = (m: number) => `¥${(m / 100).toFixed(2)}`

onMounted(async () => {
  try {
    const [emp] = await Promise.all([employee_info.query({})])
    employeeInfo.value = emp && emp.length > 0 ? emp[0] : null
    if (!employeeInfo.value) return

    const codes = storeCodesOf(employeeInfo.value.store_info)
    myStores.value = await loadMyStores(codes)

    // 默认门店：上次选择（仍在资格集合内）→ 否则第一个
    const last = localStorage.getItem(LAST_STORE_KEY) ?? ''
    selectedStore.value = codes.includes(last) ? last : (codes[0] ?? '')

    await loadTickets()
  } catch (e: any) {
    Message.error(e?.message || '加载失败')
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.tnum { font-variant-numeric: tabular-nums; }
</style>
