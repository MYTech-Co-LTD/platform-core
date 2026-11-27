// DetailDialog.tsx — 工单详情（五段：工单 / 报损 / 附件 / 处理 / 时间）。2026-11-26 / #2884，spec §3.6。
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Card, Descriptions, Modal, Space, Spin, Typography } from 'antd'
import type { TicketAttachment, TicketDetail } from '../../api-types'
import { apiGet, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import { AFFIL_LABEL, STATUS_LABEL } from './lib/labels'

const fmtTime = (v: string | null | undefined): string => (v ? v.replace('T', ' ').slice(0, 16) : '—')

function Section(props: { title: string; children: ReactNode }) {
  return <Card size="small" title={props.title} style={{ marginBottom: 12 }}>{props.children}</Card>
}

export function DetailDialog(props: {
  ticketId: number
  open: boolean
  onClose: () => void
  onPreview: (attachments: TicketAttachment[], index: number) => void
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.open) return
    let alive = true
    setLoading(true)
    setError(null)
    setDetail(null)
    apiGet<TicketDetail>(`/tickets/${props.ticketId}`)
      .then((d) => { if (alive) setDetail(d) })
      .catch((e: unknown) => { if (alive) setError(messageOf(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [props.open, props.ticketId])

  return (
    <Modal title={detail ? `工单 ${detail.code}` : `工单 #${props.ticketId}`} open={props.open} width={720} footer={null} onCancel={props.onClose}>
      {loading ? <Spin /> : null}
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {detail ? (
        <Space orientation="vertical" size={0} style={{ width: '100%' }}>
          <Section title="工单信息">
            <Descriptions size="small" column={2} items={[
              { key: 'code', label: '编号', children: detail.code },
              { key: 'status', label: '状态', children: STATUS_LABEL[detail.status] },
              { key: 'brand', label: '品牌', children: detail.brand_name || detail.brand_code || '—' },
              { key: 'level', label: '门店等级', children: detail.store_level_name || detail.store_level_code || '—' },
              { key: 'product', label: '商品', children: detail.product_name },
              { key: 'store', label: '门店', children: detail.store_name },
              { key: 'order', label: '关联订单', children: detail.related_order || '—' },
              { key: 'submitter', label: '提交人', children: detail.submitter_openid || '—' },
              { key: 'arrival', label: '到货时间', children: fmtTime(detail.arrival_at) },
            ]} />
          </Section>

          <Section title="报损信息">
            <Descriptions size="small" column={2} items={[
              { key: 'qty', label: '报损数量', children: detail.damage_quantity },
              { key: 'base', label: '基本数量', children: detail.basic_quantity },
              { key: 'price', label: '基本单价', children: formatMinor(detail.settlement_price_minor ?? detail.basic_unit_price_minor) },
              { key: 'damage', label: '报损金额', children: formatMinor(detail.damage_amount_minor) },
              { key: 'remark', label: '报损原因', children: detail.remark || '—' },
            ]} />
          </Section>

          <Section title="附件">
            {detail.attachments.length === 0 ? <Typography.Text type="secondary">无附件</Typography.Text> : (
              <Space wrap>
                {detail.attachments.map((a, i) => (
                  <Typography.Link key={a.id} onClick={() => props.onPreview(detail.attachments, i)}>
                    {a.contentType.startsWith('image/') ? `图片 ${i + 1}` : `附件 ${i + 1}`}
                  </Typography.Link>
                ))}
              </Space>
            )}
          </Section>

          <Section title="处理信息">
            <Descriptions size="small" column={2} items={[
              {
                key: 'type', label: '售后类型',
                children: detail.amount_type === 'ratio' ? '按比例' : detail.amount_type === 'fixed' ? '固定金额' : detail.amount_type ? '驳回' : '—',
              },
              {
                key: 'ratio', label: '比例',
                children: detail.refund_ratio === null || detail.refund_ratio === undefined
                  ? '—' : `${(detail.refund_ratio * 100).toFixed(2)}%`,
              },
              { key: 'amount', label: '赔付金额', children: formatMinor(detail.amount_minor) },
              { key: 'operator', label: '处理人', children: detail.operator || '—' },
              { key: 'opinion', label: '售后意见', children: detail.opinion || '—' },
              { key: 'watermark', label: '水印时间', children: detail.watermark_at || '—' },
            ]} />
          </Section>

          <Section title="时间信息">
            <Descriptions size="small" column={2} items={[
              { key: 'created', label: '提交时间', children: fmtTime(detail.created_at) },
              { key: 'processed', label: '处理时间', children: fmtTime(detail.processed_at) },
              {
                key: 'affil', label: '归属',
                children: detail.store_affiliation ? AFFIL_LABEL[detail.store_affiliation]?.label ?? '—' : '—',
              },
            ]} />
          </Section>
        </Space>
      ) : null}
    </Modal>
  )
}
