<template>
  <div class="min-h-screen bg-[#FAFBFC]">
    <!-- 骨架屏（2026-11-26）：首屏加载不用转圈——列表页的骨架比 spinner 更能说明「马上有什么」 -->
    <div v-if="loading" class="p-4 space-y-3">
      <div v-for="i in 3" :key="i" class="bg-white rounded-xl p-4 animate-pulse">
        <div class="h-4 bg-gray-100 rounded w-1/3 mb-3" />
        <div class="h-3 bg-gray-100 rounded w-full mb-2" />
        <div class="h-3 bg-gray-100 rounded w-2/3" />
      </div>
    </div>

    <!-- 未登记 ⇒ 引导注册（归属执法后，无档案看不到任何单） -->
    <div v-else-if="!employeeInfo" class="p-4">
      <t-card class="rounded-xl shadow-sm bg-[#EEF1FF]">
        <div class="flex items-start gap-3">
          <i class="fa fa-info-circle text-[#4D6BFE] text-xl mt-0.5" />
          <div class="text-sm text-gray-700">
            <p class="font-medium mb-1">还没有门店员工身份</p>
            <p class="text-gray-600">注册并通过审批后，就能提交售后单、查看本门店的工单。</p>
          </div>
        </div>
      </t-card>
      <t-button theme="primary" size="large" block class="mt-4" @click="goRegister">
        <i class="fa fa-user-plus mr-2" />去注册
      </t-button>
    </div>

    <div v-else class="p-4 pb-28">
      <!-- 门店：多店才给切换；单店是事实 -->
      <div v-if="myStores.length > 1" class="mb-3">
        <t-select v-model="selectedStore" class="w-full" @change="handleStoreChange">
          <t-option v-for="s in myStores" :key="s.code" :value="s.code" :label="s.name" />
        </t-select>
      </div>
      <div v-else-if="myStores.length === 1" class="mb-3 flex items-center gap-2 text-sm text-gray-500">
        <i class="fa fa-store" />{{ myStores[0].name }}
      </div>

      <!-- 筛选：折叠（默认收起，不占首屏） -->
      <div class="mb-3">
        <button class="text-xs text-gray-500 flex items-center gap-1" @click="showFilter = !showFilter">
          <i class="fa fa-filter" :class="{ 'rotate-180': showFilter }" />
          {{ showFilter ? '收起筛选' : '筛选' }}
          <span v-if="hasFilters" class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[#4D6BFE]" />
        </button>
        <div v-show="showFilter" class="mt-2 bg-white rounded-xl p-3 space-y-2">
          <t-input v-model="filterQ" placeholder="商品名称" clearable @enter="applyFilter" @clear="applyFilter" />
          <div class="flex gap-2">
            <t-date-picker v-model="filterFrom" placeholder="开始日期" clearable class="flex-1" @change="applyFilter" />
            <t-date-picker v-model="filterTo" placeholder="结束日期" clearable class="flex-1" @change="applyFilter" />
          </div>
          <t-button v-if="hasFilters" variant="outline" size="small" block @click="resetFilter">重置</t-button>
        </div>
      </div>

      <!-- 工单卡片：状态用「圆点 + 文字」，不铺色（DESIGN.md：颜色只出现在可操作与状态两处） -->
      <div v-if="tickets.length > 0" class="space-y-3">
        <div
          v-for="t in tickets"
          :key="t.id"
          class="bg-white rounded-xl shadow-sm p-4 active:bg-[#FAFBFC]"
          @click="openDetail(t.id)"
        >
          <!-- 头：单号 + 状态 -->
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-medium text-gray-800 tnum">{{ t.code }}</span>
            <span class="inline-flex items-center gap-1.5 text-xs" :style="{ color: statusColor(t.status) }">
              <i class="inline-block h-1.5 w-1.5 rounded-full" :style="{ background: statusColor(t.status) }" />
              {{ statusText(t.status) }}
            </span>
          </div>

          <!-- 商品块 -->
          <div class="rounded-lg bg-[#FAFBFC] px-3 py-2.5">
            <div class="text-sm text-gray-800 truncate">{{ t.product_name }}</div>
            <div class="mt-1.5 flex items-center justify-between text-xs text-gray-500">
              <span>报损数量</span>
              <span class="text-gray-800 font-medium tnum">×{{ t.damage_quantity }}</span>
            </div>
          </div>

          <!-- 底：金额 + 时间 -->
          <div class="mt-3 flex items-center justify-between text-xs">
            <span class="text-gray-500">
              退款 <span class="text-gray-800 font-medium tnum ml-1">{{ t.amount_minor === null ? '—' : formatMinor(t.amount_minor) }}</span>
            </span>
            <span class="text-gray-400 tnum">{{ formatTime(t.created_at) }}</span>
          </div>
        </div>
      </div>

      <!-- 空态：主副文案（有筛选 vs 真的没有，说不同的话） -->
      <div v-else class="flex flex-col items-center justify-center py-16">
        <i class="fa fa-file-text-o text-4xl text-gray-200 mb-3" />
        <p class="text-gray-500 text-sm">{{ hasFilters ? '没有符合条件的工单' : '本店还没有工单' }}</p>
        <p class="text-gray-400 text-xs mt-1">{{ hasFilters ? '换个条件再试' : '有商品问题可以提交售后单' }}</p>
      </div>

      <!-- 分页 -->
      <div v-if="total > size" class="flex items-center justify-center gap-4 mt-4 text-sm">
        <t-button size="small" variant="outline" :disabled="page <= 1" @click="changePage(page - 1)">上一页</t-button>
        <span class="text-gray-500 tnum">{{ page }} / {{ Math.ceil(total / size) }}</span>
        <t-button size="small" variant="outline" :disabled="page * size >= total" @click="changePage(page + 1)">下一页</t-button>
      </div>

      <t-button theme="primary" size="large" block class="mt-6" @click="goSubmit">
        <i class="fa fa-plus mr-2" />提交售后单
      </t-button>
    </div>

    <!-- 详情：弹窗（不跳页——回来时列表位置和筛选都还在） -->
    <t-dialog v-model:visible="detailVisible" header="工单详情" :footer="false" width="88%">
      <div v-if="detail" class="space-y-3 text-sm">
        <div v-for="row in detailRows" :key="row.label" class="flex items-start justify-between gap-4">
          <span class="text-gray-500 shrink-0">{{ row.label }}</span>
          <span class="text-gray-800 text-right tnum">{{ row.value }}</span>
        </div>
      </div>
      <div v-else class="py-8 text-center text-sm text-gray-400">加载中…</div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@wujibase/wuji'
import { after_sales_work_order, employee_info, store_info } from '@/shims/wuji-data'
import type { TicketDetailRow, TicketListRow } from '@/shims/wuji-data'
import dayjs from 'dayjs'

defineWujiPageMeta({
  title: '我的工单',
  description: '查看本门店的售后工单',
  metaKeywords: '售后,工单,门店',
})

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

// 筛选
const showFilter = ref(false)
const filterQ = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const hasFilters = computed(() => !!(filterQ.value || filterFrom.value || filterTo.value))

// 详情
const detailVisible = ref(false)
const detail = ref<TicketDetailRow | null>(null)
const detailRows = computed(() => {
  const d = detail.value
  if (!d) return []
  return [
    { label: '单号', value: d.code },
    { label: '商品', value: d.product_name },
    { label: '门店', value: d.store_name || d.store_code || '—' },
    { label: '数量', value: `×${d.damage_quantity}` },
    { label: '退款金额', value: d.amount_minor === null ? '—' : formatMinor(d.amount_minor) },
    { label: '关联单据', value: d.related_order || '—' },
    { label: '提交时间', value: dayjs(d.created_at).format('YYYY-MM-DD HH:mm') },
    { label: '处理时间', value: d.processed_at ? dayjs(d.processed_at).format('YYYY-MM-DD HH:mm') : '—' },
    { label: '备注', value: d.remark || '—' },
  ]
})

const storeCodesOf = (storeInfo: unknown): string[] => {
  if (!storeInfo) return []
  const arr = Array.isArray(storeInfo) ? storeInfo : String(storeInfo).split(',')
  return arr.map((x) => String(x).trim()).filter(Boolean)
}

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
      q: filterQ.value || undefined,
      from: filterFrom.value || undefined,
      to: filterTo.value || undefined,
    })
    tickets.value = body.items
    total.value = body.total
  } catch (e: any) {
    Message.error(e?.message || '加载工单失败')
  }
}

const applyFilter = async () => {
  page.value = 1
  await loadTickets()
}
const resetFilter = async () => {
  filterQ.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  await applyFilter()
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

const openDetail = async (id: number) => {
  detailVisible.value = true
  detail.value = null
  try {
    detail.value = await after_sales_work_order.get(id)
  } catch {
    // 跨店/不存在 ⇒ 与「不存在」同形：弹窗里显示提示，不炸
    Message.warning('工单不存在或不在你的门店')
    detailVisible.value = false
  }
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
    const emp = await employee_info.query({})
    employeeInfo.value = emp && emp.length > 0 ? emp[0] : null
    if (!employeeInfo.value) return

    const codes = storeCodesOf(employeeInfo.value.store_info)
    myStores.value = await loadMyStores(codes)

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
