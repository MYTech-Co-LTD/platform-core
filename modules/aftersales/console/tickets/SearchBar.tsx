// SearchBar.tsx — 五个搜索项 + 处理时间范围。2026-11-26 / #2884，spec §3.3。
//
// 输入是**草稿**：只有回车/点搜索才生效（每敲一个字就查会把服务端打成筛子）；
// 重置清空全部条件（含状态/品牌，由父组件的 onReset 处理）并回第 1 页。
import { useEffect, useState } from 'react'
import { Button, DatePicker, Input, Space } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { TicketFilters } from './lib/query'

const INPUTS = [
  { key: 'code', placeholder: '工单编号' },
  { key: 'product', placeholder: '商品' },
  { key: 'store', placeholder: '门店' },
  { key: 'relatedOrder', placeholder: '关联订单号' },
  { key: 'opinion', placeholder: '售后意见' },
] as const

export function SearchBar(props: {
  filters: TicketFilters
  onSearch: (next: TicketFilters) => void
  onReset: () => void
}) {
  const [draft, setDraft] = useState<TicketFilters>(props.filters)
  // 父组件重置/外部改条件时跟随（draft 只在自己输入时领先一步）。
  useEffect(() => setDraft(props.filters), [props.filters])

  const range: [Dayjs | null, Dayjs | null] | null =
    draft.processedFrom || draft.processedTo
      ? [draft.processedFrom ? dayjs(draft.processedFrom) : null,
         draft.processedTo ? dayjs(draft.processedTo) : null]
      : null

  return (
    <Space wrap style={{ marginBottom: 12 }}>
      {INPUTS.map((it) => (
        <Input
          key={it.key}
          allowClear
          placeholder={it.placeholder}
          value={draft[it.key]}
          style={{ width: 150 }}
          onChange={(e) => setDraft({ ...draft, [it.key]: e.target.value })}
          onPressEnter={() => props.onSearch(draft)}
        />
      ))}
      <DatePicker.RangePicker
        allowEmpty={[true, true]}
        value={range}
        placeholder={['处理开始日', '处理结束日']}
        onChange={(v) => setDraft({
          ...draft,
          processedFrom: v?.[0]?.format('YYYY-MM-DD') ?? '',
          processedTo: v?.[1]?.format('YYYY-MM-DD') ?? '',
        })}
      />
      <Button type="primary" onClick={() => props.onSearch(draft)}>搜索</Button>
      <Button onClick={() => props.onReset()}>重置</Button>
    </Space>
  )
}
