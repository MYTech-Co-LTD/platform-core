// ProcessDialog.tsx — 处理弹窗（2026-11-26 / #2884 重写）。
//
// ★ 金额仍**只来自服务端**：比例/固定金额变化后调 `POST /tickets/:id/quote`（300ms 防抖），
//   前端**不写任何乘法公式**。预览失败只提示，提交仍由服务端重算——服务端是唯一真相。
// ★ 新增两件必填事实：`opinion`（售后意见，≤500 字）与 `watermarkAt`（水印日期）。
//   处理不再写 `remark`（那是店员填的报损原因）。
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, DatePicker, Descriptions, Input, InputNumber, Modal, Radio, Select, Space, Spin, Typography,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type {
  Paged, ProcessBody, ProcessResult, QuoteBody, QuoteResult, RuleItem, TicketAttachment, TicketDetail,
} from '../../api-types'
import { ApiError, apiGet, apiSend, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import { STATUS_LABEL } from './lib/labels'

/** 规则表可能是多页（`size` 上限 100）——按 total 翻完，别只读第一页就断定「没有比例」。 */
async function fetchAllRules(): Promise<RuleItem[]> {
  const out: RuleItem[] = []
  for (let page = 1; page <= 20; page++) {
    const body = await apiGet<Paged<RuleItem>>(`/rules?page=${page}&size=100`)
    out.push(...body.items)
    if (out.length >= body.total || body.items.length === 0) break
  }
  return out
}

const ratioText = (r: number): string =>
  r === 0 ? '全额赔付（0%）' : `${(r * 100).toFixed(2).replace(/\.?0+$/, '')}%`

export function ProcessDialog(props: {
  ticketId: number
  open: boolean
  onClose: () => void
  onDone: (result: ProcessResult) => void
  onConflict?: () => void
  onPreview?: (attachments: TicketAttachment[], index: number) => void
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [rules, setRules] = useState<RuleItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [amountType, setAmountType] = useState<'ratio' | 'fixed' | 'reject'>('ratio')
  const [ratio, setRatio] = useState<number | null>(null)
  const [yuan, setYuan] = useState<number | null>(null)
  const [opinion, setOpinion] = useState('')
  const [watermark, setWatermark] = useState<Dayjs | null>(dayjs())
  const [quote, setQuote] = useState<QuoteResult | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!props.open) return
    setAmountType('ratio')
    setRatio(null)
    setYuan(null)
    setOpinion('')
    setWatermark(dayjs())
    setQuote(null)
    setQuoteError(null)
    setError(null)
  }, [props.open, props.ticketId])

  useEffect(() => {
    if (!props.open) return
    let alive = true
    setLoading(true)
    setLoadError(null)
    Promise.all([apiGet<TicketDetail>(`/tickets/${props.ticketId}`), fetchAllRules()])
      .then(([d, r]) => {
        if (!alive) return
        setDetail(d)
        setRules(r)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(messageOf(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [props.open, props.ticketId])

  const ratios = useMemo(
    () => [...new Set(rules.map((r) => r.refundRatio).filter((v): v is number => v !== null))]
      .sort((a, b) => a - b),
    [rules],
  )

  // 预览：只走服务端。reject 恒 0，不必打网络。
  useEffect(() => {
    if (!props.open) return
    setQuoteError(null)
    if (amountType === 'reject') {
      setQuote({ status: 'cancelled', amountType: 'reject', amountMinor: 0, refundRatio: null })
      return
    }
    if (amountType === 'ratio' && ratio === null) { setQuote(null); return }
    if (amountType === 'fixed' && yuan === null) { setQuote(null); return }

    const body: QuoteBody = amountType === 'ratio'
      ? { amountType: 'ratio', refundRatio: ratio as number }
      : { amountType: 'fixed', amountMinor: Math.round((yuan as number) * 100) }
    let alive = true
    const timer = setTimeout(() => {
      apiSend<QuoteResult>(`/tickets/${props.ticketId}/quote`, 'POST', body)
        .then((q) => { if (alive) setQuote(q) })
        .catch((e: unknown) => {
          if (!alive) return
          setQuote(null)
          setQuoteError(messageOf(e))
        })
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [props.open, props.ticketId, amountType, ratio, yuan])

  const opinionOk = opinion.trim().length > 0 && opinion.length <= 500
  const ratioOk = amountType !== 'ratio' || (ratio !== null && ratios.length > 0)
  const fixedOk = amountType !== 'fixed' || yuan !== null
  const canSubmit = !busy && !loading && opinionOk && watermark !== null && ratioOk && fixedOk

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    const watermarkAt = (watermark as Dayjs).format('YYYY-MM-DD')
    const body: ProcessBody = amountType === 'ratio'
      ? { amountType: 'ratio', refundRatio: ratio as number, opinion: opinion.trim(), watermarkAt }
      : amountType === 'fixed'
        ? { amountType: 'fixed', amountMinor: Math.round((yuan as number) * 100), opinion: opinion.trim(), watermarkAt }
        : { amountType: 'reject', opinion: opinion.trim(), watermarkAt }
    setBusy(true)
    setError(null)
    try {
      const result = await apiSend<ProcessResult>(`/tickets/${props.ticketId}/process`, 'POST', body)
      props.onDone(result)
      props.onClose()
    } catch (e: unknown) {
      if (e instanceof ApiError && e.code === 'ALREADY_PROCESSED') {
        // 刷新列表，但**不关弹窗**：用户要看见「已被他人处理」这句，而不是弹窗凭空消失。
        props.onConflict?.()
        setError(messageOf(e))
        return
      }
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const maxYuan = detail ? detail.damage_amount_minor / 100 : undefined
  const images = detail?.attachments ?? []

  return (
    <Modal
      title={detail ? `处理工单 ${detail.code}` : `处理工单 #${props.ticketId}`}
      open={props.open}
      width={720}
      onCancel={props.onClose}
      onOk={() => void submit()}
      okText="提交"
      cancelText="取消"
      okButtonProps={{ disabled: !canSubmit }}
      confirmLoading={busy}
      destroyOnHidden
    >
      {loading ? <Spin /> : null}
      {loadError ? <Alert type="error" showIcon title={loadError} style={{ marginBottom: 12 }} /> : null}

      {detail ? (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions
            size="small"
            column={2}
            bordered
            items={[
              { key: 'status', label: '状态', children: STATUS_LABEL[detail.status] },
              { key: 'store', label: '门店', children: detail.store_name },
              { key: 'product', label: '商品', children: detail.product_name },
              { key: 'qty', label: '报损数量', children: detail.damage_quantity },
              { key: 'price', label: '单价', children: formatMinor(detail.settlement_price_minor ?? detail.basic_unit_price_minor) },
              { key: 'damage', label: '报损金额', children: formatMinor(detail.damage_amount_minor) },
              { key: 'order', label: '关联订单', children: detail.related_order || '—' },
              { key: 'arrival', label: '到货时间', children: detail.arrival_at ? detail.arrival_at.replace('T', ' ').slice(0, 16) : '—' },
            ]}
          />

          {images.length > 0 ? (
            <Space wrap>
              {images.map((a, i) =>
                a.url === null ? (
                  // 预签名签不出来时**不要**渲染 <img src=undefined>（浏览器会画一个破图标）。
                  <Typography.Text key={a.id} type="secondary">附件 {i + 1}（不可预览）</Typography.Text>
                ) : a.contentType.startsWith('image/') ? (
                  <img
                    key={a.id}
                    src={a.url}
                    alt={`附件 ${i + 1}`}
                    style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, cursor: 'pointer', border: '1px solid #EBEDF0' }}
                    onClick={() => props.onPreview?.(images, i)}
                  />
                ) : (
                  <Typography.Link key={a.id} onClick={() => props.onPreview?.(images, i)}>
                    视频 {i + 1}
                  </Typography.Link>
                ),
              )}
            </Space>
          ) : null}

          <Radio.Group
            value={amountType}
            onChange={(e) => setAmountType(e.target.value as 'ratio' | 'fixed' | 'reject')}
            options={[
              { label: '按比例', value: 'ratio' },
              { label: '固定金额', value: 'fixed' },
              { label: '驳回', value: 'reject' },
            ]}
            optionType="button"
          />

          {amountType === 'ratio' ? (
            ratios.length === 0
              ? <Alert type="warning" showIcon title="规则表为空，请先在规则页添加规则" />
              : (
                <Select
                  aria-label="售后比例"
                  style={{ width: 240 }}
                  placeholder="选择比例"
                  value={ratio}
                  onChange={setRatio}
                  options={ratios.map((r) => ({ value: r, label: ratioText(r) }))}
                />
              )
          ) : null}

          {amountType === 'fixed' ? (
            <InputNumber
              aria-label="固定金额"
              style={{ width: 200 }}
              min={0}
              max={maxYuan}
              precision={2}
              prefix="¥"
              placeholder="赔付金额"
              value={yuan}
              onChange={(v) => setYuan(typeof v === 'number' ? v : null)}
            />
          ) : null}

          <Space orientation="vertical" size={4}>
            <Typography.Text type="secondary">预计赔付</Typography.Text>
            <Typography.Text strong style={{ fontSize: 18 }}>
              {quoteError ? '—' : quote ? formatMinor(quote.amountMinor) : '—'}
            </Typography.Text>
            {quoteError ? <Alert type="warning" showIcon title={quoteError} /> : null}
          </Space>

          <div>
            <Typography.Text>水印时间</Typography.Text>
            <div><DatePicker value={watermark} onChange={setWatermark} style={{ width: 200 }} /></div>
          </div>

          <div>
            <Typography.Text>售后意见</Typography.Text>
            <Input.TextArea
              aria-label="售后意见"
              value={opinion}
              onChange={(e) => setOpinion(e.target.value)}
              maxLength={500}
              showCount
              rows={3}
              placeholder="必填，最多 500 字"
            />
          </div>

          {error ? <Alert type="error" showIcon title={error} /> : null}
        </Space>
      ) : null}
    </Modal>
  )
}
