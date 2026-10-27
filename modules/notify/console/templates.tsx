// templates.tsx — 模板管理：编辑（按通道）/ 预览 / 版本 / 发布（含回滚）
// AI 只能 draft；发布必须由持 notify:publish 的人点（服务端门卫兜底）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Input, Space, Table, Tag, Typography, message } from 'antd'
import { get, post, type TemplateDetailView, type TemplateView } from './api'

type Contents = Record<string, Record<string, string>>

export default function TemplatesTab() {
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [detail, setDetail] = useState<TemplateDetailView | null>(null)
  const [contents, setContents] = useState<Contents>({})
  const [payloadText, setPayloadText] = useState('{}')
  const [rendered, setRendered] = useState<Record<string, Record<string, string>> | null>(null)
  const [issues, setIssues] = useState<string[]>([])

  const loadList = useCallback(async () => {
    try {
      const r = await get<{ templates: TemplateView[] }>('/templates')
      setTemplates(r.templates)
    } catch (e) {
      message.error(`加载模板失败：${String(e)}`)
    }
  }, [])

  const loadDetail = useCallback(async (key: string) => {
    try {
      const d = await get<TemplateDetailView>(`/templates/${encodeURIComponent(key)}`)
      setDetail(d)
      const rev = d.revisions.find((x) => x.revision === d.publishedRevision) ?? d.revisions[0]
      setContents(rev?.contents ?? {})
      setRendered(null)
      setIssues([])
    } catch (e) {
      message.error(`加载模板失败：${String(e)}`)
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  const setField = (ch: string, field: string, value: string) => {
    setContents((prev) => ({ ...prev, [ch]: { ...(prev[ch] ?? {}), [field]: value } }))
  }

  const onSave = async () => {
    if (!detail) return
    try {
      const r = await post<{ revision: number }>(
        `/templates/${encodeURIComponent(detail.key)}/revisions`, { contents })
      message.success(`草稿已保存（v${r.revision}）`)
      await loadDetail(detail.key)
    } catch (e) {
      message.error(`保存失败：${String(e)}`)
    }
  }

  const onPreview = async () => {
    if (!detail) return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(payloadText || '{}') as Record<string, unknown>
    } catch {
      message.error('样例 payload 不是合法 JSON')
      return
    }
    try {
      const r = await post<{ rendered: Record<string, Record<string, string>> }>(
        `/templates/${encodeURIComponent(detail.key)}/preview`, { contents, payload })
      setRendered(r.rendered)
      setIssues([])
    } catch (e) {
      setRendered(null)
      setIssues([String(e)])
    }
  }

  const onPublish = async (revision: number) => {
    if (!detail) return
    try {
      await post(`/templates/${encodeURIComponent(detail.key)}/publish`, { revision })
      message.success(`已发布 v${revision}`)
      await loadDetail(detail.key)
      await loadList()
    } catch (e) {
      message.error(`发布失败：${String(e)}`)
    }
  }

  return (
    <Space align="start" style={{ width: '100%' }} size="large">
      <Card title="模板" size="small" style={{ width: 280 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {templates.map((t) => (
            <Button
              key={t.key}
              type={detail?.key === t.key ? 'primary' : 'default'}
              block
              onClick={() => void loadDetail(t.key)}
            >
              {t.name || t.key}
              <Tag style={{ marginLeft: 8 }}>{t.status}</Tag>
            </Button>
          ))}
        </Space>
      </Card>

      {detail && (
        <Card title={`${detail.name || detail.key}（事件：${detail.eventKey}）`} size="small" style={{ flex: 1 }}>
          <Typography.Paragraph type="secondary">
            变量 = 事件 payload 字段名；预览与投递使用同一渲染函数。发布需 notify:publish。
          </Typography.Paragraph>

          <Typography.Text strong>企微（wecom_chat）</Typography.Text>
          <Input.TextArea
            aria-label="企微文案"
            rows={4}
            value={contents.wecom_chat?.text ?? ''}
            onChange={(e) => setField('wecom_chat', 'text', e.target.value)}
            style={{ marginBottom: 12 }}
          />

          <Typography.Text strong>收件箱（in_app）</Typography.Text>
          <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
            <Input
              aria-label="收件箱标题"
              placeholder="标题"
              value={contents.in_app?.title ?? ''}
              onChange={(e) => setField('in_app', 'title', e.target.value)}
            />
            <Input.TextArea
              aria-label="收件箱正文"
              rows={2}
              placeholder="正文"
              value={contents.in_app?.body ?? ''}
              onChange={(e) => setField('in_app', 'body', e.target.value)}
            />
            <Input
              aria-label="收件箱链接"
              placeholder="{{link}}"
              value={contents.in_app?.link ?? ''}
              onChange={(e) => setField('in_app', 'link', e.target.value)}
            />
          </Space>

          <Typography.Text strong>样例 payload（JSON）</Typography.Text>
          <Input.TextArea
            aria-label="样例 payload"
            rows={3}
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            style={{ marginBottom: 12 }}
          />

          <Space style={{ marginBottom: 12 }}>
            <Button onClick={() => void onSave()}>保存草稿</Button>
            <Button type="primary" onClick={() => void onPreview()}>预览</Button>
          </Space>

          {issues.length > 0 && <Alert type="error" message={issues.join('; ')} style={{ marginBottom: 12 }} />}
          {rendered && Object.entries(rendered).map(([ch, fields]) => (
            <Card key={ch} size="small" title={ch} style={{ marginBottom: 8 }}>
              <pre data-testid={`preview-${ch}`} style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(fields, null, 2)}</pre>
            </Card>
          ))}

          <Typography.Text strong>版本</Typography.Text>
          <Table
            rowKey="revision"
            size="small"
            pagination={false}
            dataSource={detail.revisions}
            columns={[
              { title: '版本', dataIndex: 'revision', render: (v: number) => `v${v}` },
              { title: '状态', dataIndex: 'reviewStatus' },
              { title: '作者', dataIndex: 'createdBy' },
              { title: '时间', dataIndex: 'createdAt' },
              {
                title: '操作',
                render: (_, r) => (
                  <Button size="small" onClick={() => void onPublish(r.revision)}>
                    发布 v{r.revision}
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      )}
    </Space>
  )
}
