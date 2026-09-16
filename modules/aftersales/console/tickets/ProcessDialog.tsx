// ProcessDialog.tsx — 工单处理弹窗（M3a）。
//
// ★ **不显示预估金额**（spec §3.1）：`POST /tickets/:id/process` 只在**提交之后**返回服务端算出的
//   `amountMinor`，没有预览端点；而 §0.3 把「前端算金额」列为**要消灭的模式**
//   ⇒ `ratio` 路**盲提交**，**前端不引入第二份金额公式**（两份实现必然漂移）。
//   `fixed` 路的金额是操作员自己填的输入（服务端把它当入参），所以那一栏要显示。
import { useState } from 'react'
import { Alert, Input, InputNumber, Modal, Radio, Space, Typography } from 'antd'
import { apiSend, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import type { AmountType, ProcessBody, ProcessResult } from '../../api-types'

export function ProcessDialog(props: {
  ticketId: number
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [amountType, setAmountType] = useState<AmountType | 'reject'>('ratio')
  const [ratio, setRatio] = useState<number | null>(null)
  const [yuan, setYuan] = useState<number | null>(null)
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<ProcessResult | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const body: ProcessBody =
      amountType === 'ratio'
        ? { amountType: 'ratio', refundRatio: ratio ?? 0, ...(remark ? { remark } : {}) }
        : amountType === 'fixed'
          ? { amountType: 'fixed', amountMinor: Math.round((yuan ?? 0) * 100), ...(remark ? { remark } : {}) }
          : { amountType: 'reject', ...(remark ? { remark } : {}) }
    try {
      setDone(await apiSend<ProcessResult>(`/tickets/${props.ticketId}/process`, 'POST', body))
    } catch (e: unknown) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`处理工单 #${props.ticketId}`}
      open={props.open}
      onCancel={props.onClose}
      onOk={() => {
        if (done) {
          props.onDone()
          props.onClose()
        } else {
          void submit()
        }
      }}
      okText={done ? '完成' : '提交'}
      cancelText="取消"
      confirmLoading={busy}
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: '100%' }}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {done ? (
          <Alert
            type="success"
            showIcon
            title={`处理完成：${done.status}`}
            // 这个金额是**服务端返回的**，不是前端算的
            description={`服务端核定退款额 ${formatMinor(done.amountMinor)}`}
          />
        ) : (
          <>
            <Radio.Group
              aria-label="处理方式"
              value={amountType}
              onChange={(e) => setAmountType(e.target.value as AmountType | 'reject')}
            >
              <Radio.Button value="ratio">按比例退款</Radio.Button>
              <Radio.Button value="fixed">固定金额退款</Radio.Button>
              <Radio.Button value="reject">驳回</Radio.Button>
            </Radio.Group>

            {amountType === 'ratio' ? (
              <div>
                <label htmlFor="ratio">退款比例</label>
                <InputNumber
                  id="ratio"
                  min={0}
                  max={1}
                  step={0.01}
                  value={ratio}
                  onChange={setRatio}
                  style={{ width: '100%' }}
                />
                <Typography.Text type="secondary">退款金额由服务端按比例计算，提交后显示。</Typography.Text>
              </div>
            ) : null}

            {amountType === 'fixed' ? (
              <div>
                <label htmlFor="yuan">退款金额（元）</label>
                <InputNumber id="yuan" min={0} step={0.01} value={yuan} onChange={setYuan} style={{ width: '100%' }} />
              </div>
            ) : null}

            <div>
              <label htmlFor="remark">备注</label>
              <Input.TextArea
                id="remark"
                rows={2}
                maxLength={2000}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>
          </>
        )}
      </Space>
    </Modal>
  )
}
