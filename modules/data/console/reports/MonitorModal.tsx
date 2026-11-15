// MonitorModal.tsx — 报表页「给这个面板挂监控」入口（Wave 7 V1，spec §2/§15）。
//
// V1 只做**影子期**：创建后 dry_run=true，只求值落台账、不发送；开闸（dry_run=false）
// 走管理面 PATCH（本波不在页面上开放一键开闸——影子期是硬门，spec §7）。
// 收件人 V1 只收用户名（逗号分隔）：部门收件人需要组织同步到位，先用最小面打通链路。
import { useState } from 'react'
import { Alert, Button, Input, InputNumber, Modal, Select, Space, Typography, message } from 'antd'

export interface MonitorButtonProps {
  reportId: string
  panelIndex: number
  panelTitle: string
}

const CADENCE_OPTIONS = [
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
  { value: 1800, label: '30 分钟' },
  { value: 3600, label: '1 小时' },
  { value: 21600, label: '6 小时' },
]

export function MonitorButton({ reportId, panelIndex, panelTitle }: MonitorButtonProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(`${panelTitle}监控`)
  const [verdict, setVerdict] = useState<'missing' | 'stale' | 'threshold'>('missing')
  const [op, setOp] = useState<'gt' | 'gte' | 'lt' | 'lte' | 'eq'>('gt')
  const [thresholdValue, setThresholdValue] = useState<number>(0)
  const [windowDays, setWindowDays] = useState(1)
  const [cadenceSecs, setCadenceSecs] = useState(3600)
  const [minBreach, setMinBreach] = useState(1)
  const [recipients, setRecipients] = useState('')
  const [saving, setSaving] = useState(false)
  // antd 6：静态 message 不是持有者，走 useMessage + 就地 holder。
  const [messageApi, ctx] = message.useMessage()

  const reset = () => {
    setName(`${panelTitle}监控`)
    setVerdict('missing')
    setOp('gt')
    setThresholdValue(0)
    setWindowDays(1)
    setCadenceSecs(3600)
    setMinBreach(1)
    setRecipients('')
  }

  const submit = async () => {
    const refs = recipients.split(/[,，\s]+/).map((x) => x.trim()).filter((x) => x !== '')
    if (refs.length === 0) {
      messageApi.error('至少填一个收件人（用户名，逗号分隔）')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/modules/data/monitors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          targetKind: 'report_panel',
          reportId,
          panelIndex,
          verdict,
          ...(verdict === 'threshold' ? { operator: op, threshold: thresholdValue } : {}),
          windowDays,
          cadenceSecs,
          minBreachEvals: minBreach,
          recipients: refs.map((ref) => ({ kind: 'user', ref })),
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
      if (!res.ok) {
        messageApi.error(`创建失败：${body.error === 'MONITOR_METRIC_NOT_ADDITIVE' ? '该指标不可加，暂不支持阈值' : (body.error ?? res.status)}${body.detail ? `（${body.detail}）` : ''}`)
        return
      }
      messageApi.success('已创建（影子期：先只记录、不发送）')
      setOpen(false)
      reset()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {ctx}
      <Button size="small" onClick={() => setOpen(true)}>挂监控</Button>
      <Modal
        open={open}
        title={`给「${panelTitle}」挂监控`}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="创建"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            title="默认影子期：只记录判定结果，确认误报可接受后再开启发送。"
          />
          <div>
            <Typography.Text>名称</Typography.Text>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </div>
          <Space size={12} wrap>
            <div>
              <Typography.Text>判据</Typography.Text>
              <Select
                value={verdict}
                onChange={setVerdict}
                style={{ width: 160 }}
                options={[
                  { value: 'missing', label: '窗口内没有数据' },
                  { value: 'stale', label: '数据水位过期' },
                  { value: 'threshold', label: '阈值越界（仅可加指标）' },
                ]}
              />
            </div>
            {verdict === 'threshold' ? (
              <Space size={8}>
                <Select
                  value={op}
                  onChange={setOp}
                  style={{ width: 90 }}
                  options={[
                    { value: 'gt', label: '>' }, { value: 'gte', label: '>=' },
                    { value: 'lt', label: '<' }, { value: 'lte', label: '<=' },
                    { value: 'eq', label: '=' },
                  ]}
                />
                <InputNumber value={thresholdValue} onChange={(v) => setThresholdValue(v ?? 0)} />
              </Space>
            ) : null}
            <div>
              <Typography.Text>窗口（天）</Typography.Text>
              <InputNumber min={1} max={30} value={windowDays} onChange={(v) => setWindowDays(v ?? 1)} />
            </div>
            <div>
              <Typography.Text>连续</Typography.Text>
              <InputNumber min={1} max={10} value={minBreach} onChange={(v) => setMinBreach(v ?? 1)} />
              <Typography.Text type="secondary"> 次越界才触发</Typography.Text>
            </div>
            <div>
              <Typography.Text>检查周期</Typography.Text>
              <Select value={cadenceSecs} onChange={setCadenceSecs} style={{ width: 120 }} options={CADENCE_OPTIONS} />
            </div>
          </Space>
          <div>
            <Typography.Text>收件人（用户名，逗号分隔）</Typography.Text>
            <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="例如 alice, bob" />
          </div>
        </Space>
      </Modal>
    </>
  )
}
