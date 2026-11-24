// tickets/index.tsx — 售后工单列表（M3a）。
//
// **服务端真分页**：`GET /tickets` 回 `{ items, total, page, size }` ⇒ 用 `total` 驱动分页控件，
// 不在前端全量拉取再切页（§0.3「迁移即重构」：那正是要消灭的模式）。
//
// **金额一律来自服务端**：未处理工单的 `amount_minor` 就是 null，显示占位符而不是 ¥0.00
// （后者会让人以为算过、且结果是 0）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Select, Table, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import { ProcessDialog } from './ProcessDialog'
import { ListCard, Status } from '../lib/ui'
import type { Paged, StoreAffiliation, TicketListItem, TicketStatus } from '../../api-types'

const SIZE = 20

const STATUS_LABEL: Record<TicketStatus, string> = {
  pending: '待处理',
  completed: '已处理',
  cancelled: '已驳回',
}
/** 归属一致性（ADR 2026-11-24 §7 P1-a）：**信息性展示**，不参与任何放行判定。
 *  `matched` 是常态，用弱色以免每行都在喊；异常两态才上语义色。 */
const AFFIL: Record<StoreAffiliation, { label: string; tone: 'warn' | 'ok' | 'danger' }> = {
  matched: { label: '一致', tone: 'ok' },
  mismatch: { label: '门店不一致', tone: 'danger' },
  unregistered: { label: '未登记', tone: 'warn' },
}
const STATUS_TONE: Record<TicketStatus, 'warn' | 'ok' | 'danger'> = {
  pending: 'warn',
  completed: 'ok',
  cancelled: 'danger',
}

export default function TicketsPage() {
  const [items, setItems] = useState<TicketListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'' | TicketStatus>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 正在处理的工单 id（null = 弹窗关着） */
  const [processing, setProcessing] = useState<number | null>(null)

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
    <ListCard>
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
        size="small"
        dataSource={items}
        loading={loading}
        locale={{ emptyText: '还没有工单。员工在公众号提交后会出现在这里。' }}
        pagination={{ current: page, pageSize: SIZE, total, showSizeChanger: false, onChange: setPage }}
        // 列宽总和超出容器时横向滚动，而不是把无宽度列压成竖排
        scroll={{ x: 1180 }}
        columns={[
          { title: '编号', dataIndex: 'code', width: 140 },
          // 这两列**必须有宽度**：不给宽度时 antd 会把它俩压到剩余空间（加了「提交人归属」
          // 之后实测被挤成竖排——2026-11-24 真机截图）。数值与其它列同档，总量走 scroll.x。
          { title: '商品', dataIndex: 'product_name', width: 180 },
          { title: '门店', dataIndex: 'store_name', width: 150 },
          {
            title: '提交人归属',
            dataIndex: 'store_affiliation',
            width: 110,
            render: (v: StoreAffiliation | null | undefined) =>
              v && AFFIL[v] ? <Status tone={AFFIL[v].tone}>{AFFIL[v].label}</Status>
                            : <Typography.Text type="secondary">—</Typography.Text>,
          },
          { title: '数量', dataIndex: 'damage_quantity', width: 80 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (s: TicketStatus) => <Status tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Status>,
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
          {
            title: '操作',
            width: 90,
            // 待处理 ⇒ 可处理；已处理/已驳回 ⇒ 只读查看（同一个弹窗，退回只显示结果态）
            render: (_: unknown, r: TicketListItem) => (
              <Button size="small" type={r.status === 'pending' ? 'primary' : 'link'} onClick={() => setProcessing(r.id)}>
                {r.status === 'pending' ? '处理' : '查看'}
              </Button>
            ),
          },
        ]}
      />
      {processing !== null ? (
        <ProcessDialog
          ticketId={processing}
          open
          onClose={() => setProcessing(null)}
          // 处理完刷新列表：状态与「服务端核定的退款额」都要重新取，不在前端就地改
          onDone={() => void load()}
        />
      ) : null}
    </ListCard>
  )
}
