<template>
  <div class="min-h-screen bg-[#FAFBFC]">
    <div v-if="loading" class="flex items-center justify-center py-20">
      <t-loading theme="circular" size="40px" text="加载中..." />
    </div>

    <div v-else-if="!detail" class="p-4">
      <t-card class="rounded-xl shadow-sm">
        <div class="py-8 text-center text-sm text-gray-400">工单不存在或不在你的门店</div>
      </t-card>
    </div>

    <div v-else class="p-4 pb-24">
      <t-card class="mb-4 rounded-xl shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-lg font-medium text-gray-800">{{ detail.product_name }}</h2>
            <p class="text-xs text-gray-400 mt-1 tnum">{{ detail.code }}</p>
          </div>
          <span class="inline-flex items-center gap-1.5 text-sm" :style="{ color: statusColor(detail.status) }">
            <i class="inline-block h-1.5 w-1.5 rounded-full" :style="{ background: statusColor(detail.status) }" />
            {{ statusText(detail.status) }}
          </span>
        </div>

        <div class="space-y-3">
          <div v-for="row in rows" :key="row.label" class="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
            <span class="text-gray-500 text-sm shrink-0">{{ row.label }}</span>
            <span class="text-gray-800 text-sm text-right tnum">{{ row.value }}</span>
          </div>
        </div>
      </t-card>

      <!-- 附件：服务端已按工单归属放行，签不出 URL 的逐项降级（url=null 不整页 503） -->
      <t-card v-if="(detail.attachments ?? []).length > 0" class="mb-4 rounded-xl shadow-sm">
        <p class="text-sm font-medium text-gray-700 mb-3">损坏照片</p>
        <div class="grid grid-cols-3 gap-2">
          <template v-for="a in detail.attachments" :key="a.id">
            <img v-if="a.url" :src="a.url" class="w-full h-24 object-cover rounded-lg" alt="附件" />
            <div v-else class="w-full h-24 rounded-lg bg-gray-100 flex items-center justify-center text-xs text-gray-400">
              暂不可用
            </div>
          </template>
        </div>
      </t-card>

      <t-button theme="default" variant="outline" size="large" block @click="goBack">
        <i class="fa fa-arrow-left mr-2"></i>返回列表
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Message } from '@wujibase/wuji'
import { after_sales_work_order } from '@/shims/wuji-data'
import type { TicketDetailRow } from '@/shims/wuji-data'
import dayjs from 'dayjs'

defineWujiPageMeta({
  title: '工单详情',
  description: '查看售后工单状态与处理结果',
  metaKeywords: '售后,工单,详情',
})

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const detail = ref<TicketDetailRow | null>(null)

const statusText = (s: string) => ({ pending: '待处理', completed: '已处理', cancelled: '已驳回' }[s] ?? s)
const statusColor = (s: string) =>
  ({ pending: '#E08A00', completed: '#0FA958', cancelled: '#E5484D' }[s] ?? '#C9CDD4')
const formatTime = (t?: string | null) => (t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '—')
const formatMinor = (m?: number | null) => (m === null || m === undefined ? '—' : `¥${(m / 100).toFixed(2)}`)

const rows = computed(() => {
  const d = detail.value
  if (!d) return []
  return [
    { label: '门店', value: d.store_name || d.store_code || '—' },
    { label: '数量', value: `×${d.damage_quantity}` },
    { label: '退款金额', value: formatMinor(d.amount_minor) },
    { label: '关联单据', value: d.related_order || '—' },
    { label: '提交时间', value: formatTime(d.created_at) },
    { label: '处理时间', value: formatTime(d.processed_at) },
    { label: '备注', value: d.remark || '—' },
  ]
})

const goBack = () => router.push({ name: 'myTickets' })

onMounted(async () => {
  try {
    const id = Number(route.params.id)
    if (!Number.isSafeInteger(id) || id <= 0) {
      detail.value = null
      return
    }
    detail.value = await after_sales_work_order.get(id)
  } catch (e: any) {
    // 跨店/不存在 ⇒ 404 与「不存在」同形：页面按「无此单」展示，不报错轰炸
    detail.value = null
    Message.warning(e?.message || '工单不存在或不在你的门店')
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.tnum { font-variant-numeric: tabular-nums; }
</style>
