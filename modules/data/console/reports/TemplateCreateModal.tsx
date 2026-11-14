// TemplateCreateModal.tsx — 从内置模板新建报表（R2 收尾：console 模板选择入口）。
//
// 为什么需要：模板此前只有 HTTP/MCP 入口，业务人员在 console 里建报表仍然要「自由写 spec」
// ——正是 R2 想收窄的那条路。这里把流程变成「选模板 → 填指标 → 建草稿」：
//   · 模板与槽位由 `GET /reports/templates` 提供（仓内数据，前端不复制）；
//   · 编译走 `POST /reports/templates/:id/compile`（与 MCP 同一条校验）；
//   · 创建仍走 `POST /reports` 的既有权限/校验链（本组件不碰发布，也不改页门）。
// 必填槽在前端先拦一次（省一次往返），服务端仍是最终判据（缺槽 ⇒ 400 MISSING_REQUIRED_SLOT）。
import { useEffect, useState } from 'react'
import { Alert, Input, Modal, Select, Space, Tag, Typography } from 'antd'
import { ApiError, apiGet, apiSend, messageOf } from '../lib/api'

interface Slot {
  key: string
  label: string
  chart: string
  required?: boolean
  title?: string
}

interface Template {
  id: string
  title: string
  description: string
  slots: Slot[]
}

export function TemplateCreateModal({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  /** 创建成功回调（报表 id）；调用方负责刷新清单。 */
  onCreated: (id: string) => void
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tplId, setTplId] = useState<string | null>(null)
  const [reportTitle, setReportTitle] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setTemplates(null)
    setLoadError(null)
    setError(null)
    apiGet('/reports/templates')
      .then((b) => {
        if (!alive) return
        const list = (b as { templates?: Template[] }).templates ?? []
        setTemplates(list)
        const first = list[0]
        if (first !== undefined) {
          setTplId(first.id)
          setReportTitle(first.title)
          setValues({})
        }
      })
      .catch((e) => { if (alive) setLoadError(messageOf(e)) })
    return () => { alive = false }
  }, [open])

  const tpl = templates?.find((t) => t.id === tplId) ?? null
  // ai_text 槽不需要指标（focus 已声明在模板里），不出输入框。
  const metricSlots = tpl?.slots.filter((s) => s.chart !== 'ai_text') ?? []

  const switchTemplate = (id: string): void => {
    const next = templates?.find((t) => t.id === id)
    setTplId(id)
    if (next !== undefined) setReportTitle(next.title)
    setValues({})
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (tpl === null) return
    const missing = metricSlots.filter((s) => s.required === true && (values[s.key] ?? '').trim() === '')
    if (missing.length > 0) {
      setError(`还缺必填指标：${missing.map((s) => s.label).join('、')}`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      // 只提交填了的槽：空槽交给服务端按「必填/可选」判（可选槽缺省即可）。
      const filled = Object.fromEntries(
        Object.entries(values).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]),
      )
      const compiled = await apiSend(`/reports/templates/${tpl.id}/compile`, 'POST', { values: filled })
      const spec = (compiled as { spec?: unknown }).spec
      if (spec === undefined) throw new ApiError(0, 'TEMPLATE_COMPILE_EMPTY')
      const created = await apiSend('/reports', 'POST', {
        title: reportTitle.trim() === '' ? tpl.title : reportTitle.trim(),
        renderer: 'platform',
        spec,
      })
      const id = (created as { id?: string }).id
      if (typeof id !== 'string' || id === '') throw new ApiError(0, 'HTTP_201')
      onCreated(id)
      onClose()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="从模板新建报表"
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="创建"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: tpl === null || templates === null }}
      width={560}
    >
      {loadError !== null && <Alert type="warning" showIcon message={`模板暂不可用：${loadError}`} />}
      {templates === null && loadError === null && <Typography.Text type="secondary">正在加载模板…</Typography.Text>}
      {templates !== null && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>模板</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={tplId ?? undefined}
              onChange={switchTemplate}
              options={templates.map((t) => ({ value: t.id, label: t.title }))}
            />
            {tpl !== null && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
                {tpl.description}
              </Typography.Paragraph>
            )}
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>报表标题</Typography.Text>
            <Input
              value={reportTitle}
              maxLength={120}
              onChange={(e) => setReportTitle(e.target.value)}
              placeholder={tpl?.title ?? '报表标题'}
            />
          </div>
          {metricSlots.map((s) => (
            <div key={s.key}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {s.title ?? s.label}
                {s.required === true ? <Tag color="red" style={{ marginLeft: 6 }}>必填</Tag> : <Tag style={{ marginLeft: 6 }}>可选</Tag>}
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>{s.chart}</Typography.Text>
              </Typography.Text>
              <Input
                value={values[s.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                placeholder="指标 id，如 lemeng:retail:net_sales"
                data-testid={`slot-${s.key}`}
              />
            </div>
          ))}
          {error !== null && <Alert type="warning" showIcon message={error} />}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            创建为未发布草稿（只有你和管理员可见）；确认无误后再在清单里发布。
          </Typography.Text>
        </Space>
      )}
    </Modal>
  )
}
