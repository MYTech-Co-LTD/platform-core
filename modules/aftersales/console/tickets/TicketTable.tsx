// TicketTable.tsx — 工单表格。2026-11-26 / #2884，spec §3.4。
//
// 两条旧纪律保留：
//   · 服务端真分页（`total` 驱动，前端不切页）；
//   · 金额只显示服务端算好的整数分：赔付额 pending 为 `—`（不是 ¥0.00），报损金额（毛额）恒有值。
import { Button, Table, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { TicketListItem } from '../../api-types'
import { formatMinor } from '../lib/format'
import { Status } from '../lib/ui'
import { AFFIL_LABEL, STATUS_LABEL, STATUS_TONE } from './lib/labels'

const fmtTime = (v: string | null | undefined): string => (v ? v.replace('T', ' ').slice(0, 16) : '—')

function attachmentsText(r: TicketListItem): string {
  const img = r.image_count ?? 0
  const vid = r.video_count ?? 0
  if (img === 0 && vid === 0) return '—'
  return `${img > 0 ? `图片 ${img}` : ''}${img > 0 && vid > 0 ? ' · ' : ''}${vid > 0 ? `视频 ${vid}` : ''}`
}

export function TicketTable(props: {
  items: TicketListItem[]
  total: number
  page: number
  size: number
  loading: boolean
  selected: number[]
  onSelectedChange: (keys: number[]) => void
  onPageChange: (page: number, size: number) => void
  onProcess: (id: number) => void
  onDetail: (id: number) => void
  onPreview: (row: TicketListItem) => void
}) {
  const columns: ColumnsType<TicketListItem> = [
    {
      title: '序号',
      key: 'index',
      width: 60,
      fixed: 'left',
      render: (_v, _r, i) => (props.page - 1) * props.size + i + 1,
    },
    {
      title: '工单编号',
      dataIndex: 'code',
      width: 150,
      fixed: 'left',
      render: (v: string, r) => <Typography.Link onClick={() => props.onDetail(r.id)}>{v}</Typography.Link>,
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'left',
      render: (_v, r) => (
        <Button
          size="small"
          type={r.status === 'pending' ? 'primary' : 'link'}
          onClick={() => (r.status === 'pending' ? props.onProcess(r.id) : props.onDetail(r.id))}
        >
          {r.status === 'pending' ? '处理' : '查看'}
        </Button>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: TicketListItem['status']) => <Status tone={STATUS_TONE[s]}>{STATUS_LABEL[s]}</Status>,
    },
    {
      title: '品牌',
      dataIndex: 'brand_name',
      width: 100,
      // 品牌/等级是分类维度，不是状态——用中性文字，不套语义色。
      render: (_v, r) => {
        const text = r.brand_name || r.brand_code || ''
        return text || <Typography.Text type="secondary">—</Typography.Text>
      },
    },
    {
      title: '门店等级',
      dataIndex: 'store_level_name',
      width: 100,
      render: (_v, r) => {
        const text = r.store_level_name || r.store_level_code || ''
        return text || <Typography.Text type="secondary">—</Typography.Text>
      },
    },
    { title: '商品', dataIndex: 'product_name', width: 180 },
    { title: '门店', dataIndex: 'store_name', width: 160 },
    { title: '关联订单', dataIndex: 'related_order', width: 150, render: (v: string | null) => v || '—' },
    { title: '到货时间', dataIndex: 'arrival_at', width: 150, render: fmtTime },
    { title: '报损数量', dataIndex: 'damage_quantity', width: 100 },
    {
      title: '报损金额',
      dataIndex: 'damage_amount_minor',
      width: 110,
      render: (v: number | undefined) => formatMinor(v ?? null),
    },
    {
      title: '赔付金额',
      dataIndex: 'amount_minor',
      width: 110,
      render: (v: number | null) => formatMinor(v),
    },
    {
      title: '售后类型',
      dataIndex: 'amount_type',
      width: 100,
      render: (v: TicketListItem['amount_type']) => (v === 'ratio' ? '按比例' : v === 'fixed' ? '固定金额' : v ? '驳回' : '—'),
    },
    {
      title: '比例',
      dataIndex: 'refund_ratio',
      width: 90,
      render: (v: number | null) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`),
    },
    {
      title: '附件',
      key: 'attachments',
      width: 130,
      render: (_v, r) => {
        const text = attachmentsText(r)
        return text === '—'
          ? <Typography.Text type="secondary">—</Typography.Text>
          : <Typography.Link onClick={() => props.onPreview(r)}>{text}</Typography.Link>
      },
    },
    {
      title: '售后意见',
      dataIndex: 'opinion',
      width: 200,
      render: (v: string | undefined) => (
        <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 180 }}>{v || '—'}</Typography.Text>
      ),
    },
    { title: '水印时间', dataIndex: 'watermark_at', width: 120, render: (v: string | null) => v || '—' },
    { title: '处理人', dataIndex: 'operator', width: 120, render: (v: string | null) => v || '—' },
    { title: '提交时间', dataIndex: 'created_at', width: 150, render: fmtTime },
    { title: '处理时间', dataIndex: 'processed_at', width: 150, render: fmtTime },
    {
      title: '归属',
      dataIndex: 'store_affiliation',
      width: 110,
      render: (v: TicketListItem['store_affiliation']) =>
        v && AFFIL_LABEL[v]
          ? <Status tone={AFFIL_LABEL[v].tone}>{AFFIL_LABEL[v].label}</Status>
          : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ]

  return (
    <Table<TicketListItem>
      rowKey="id"
      size="small"
      dataSource={props.items}
      loading={props.loading}
      columns={columns}
      locale={{ emptyText: '没有符合条件的工单。' }}
      scroll={{ x: 2450 }}
      rowSelection={{
        selectedRowKeys: props.selected,
        onChange: (keys) => props.onSelectedChange(keys.map(Number)),
        fixed: true,
        columnWidth: 40,
      }}
      pagination={{
        current: props.page,
        pageSize: props.size,
        total: props.total,
        showSizeChanger: true,
        pageSizeOptions: [20, 50, 100],
        showTotal: (n) => `共 ${n} 条`,
        onChange: props.onPageChange,
      }}
    />
  )
}
