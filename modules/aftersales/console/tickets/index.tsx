// tickets/index.tsx — 售后工单列表（M3a）。
//
// **服务端真分页**：`GET /tickets` 回 `{ items, total, page, size }` ⇒ 用 `total` 驱动分页控件，
// 不在前端全量拉取再切页（§0.3「迁移即重构」：那正是要消灭的模式）。
//
// **金额一律来自服务端**：未处理工单的 `amount_minor` 就是 null，显示占位符而不是 ¥0.00
// （后者会让人以为算过、且结果是 0）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Select, Table, Tag, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import type { Paged, TicketListItem, TicketStatus } from '../../api-types'

const SIZE = 20

const STATUS_LABEL: Record<TicketStatus, string> = {
  pending: '待处理',
  completed: '已处理',
  cancelled: '已驳回',
}
const STATUS_COLOR: Record<TicketStatus, string> = {
  pending: 'orange',
  completed: 'green',
  cancelled: 'red',
}

export default function TicketsPage() {
  const [items, setItems] = useState<TicketListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'' | TicketStatus>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ page: String(page), size: String(SIZE) })
      if (status) qs.set('status', status)
      const body = await apiGet<Paged<TicketListItem>>(`/tickets?${qs.toString()}`)
      setItems(body.items)
      setTotal(body.total)
    } catch (e: unknown) {
      setItems([])
      setTotal(0)
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Select
          aria-label="状态筛选"
          value={status}
          style={{ width: 160 }}
          onChange={(v: '' | TicketStatus) => {
            setStatus(v)
            setPage(1) // 换筛选条件回到第 1 页——否则会停在一个可能已经不存在的页码上
          }}
          options={[
            { value: '', label: '全部状态' },
            ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Typography.Text type="secondary">共 {total} 条</Typography.Text>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Table<TicketListItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={{ current: page, pageSize: SIZE, total, showSizeChanger: false, onChange: setPage }}
        columns={[
          { title: '编号', dataIndex: 'code', width: 140 },
          { title: '商品', dataIndex: 'product_name' },
          { title: '门店', dataIndex: 'store_name' },
          { title: '数量', dataIndex: 'damage_quantity', width: 80 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (s: TicketStatus) => <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Tag>,
          },
          {
            title: '退款额',
            dataIndex: 'amount_minor',
            width: 120,
            // 未处理 ⇒ null ⇒ 占位符（不是 ¥0.00）
            render: (v: number | null) => formatMinor(v),
          },
          { title: '处理人', dataIndex: 'operator', width: 120, render: (v: string | null) => v ?? '—' },
          {
            title: '创建时间',
            dataIndex: 'created_at',
            width: 180,
            render: (v: string) => v.replace('T', ' ').slice(0, 19),
          },
        ]}
      />
    </div>
  )
}
