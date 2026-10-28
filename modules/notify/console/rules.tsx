// rules.tsx — 规则管理（五元组；无表达式编辑器）
import { useCallback, useEffect, useState } from 'react'
import {
  Button, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message,
} from 'antd'
import {
  del, get, post, put,
  type ChannelView, type EventView, type RuleDeliverability, type RuleView, type TemplateView,
} from './api'

/** 阻塞原因 → 人话（与 domain/deliverability.ts 的 Blocked 一一对应） */
export const blockedLabel = (blocked: string): string => {
  if (blocked === 'no_recipient') return '无可解析收件人'
  if (blocked === 'no_channel') return '通道全停用'
  if (blocked === 'template_missing') return '模板未发布'
  return blocked
}

export const recipientOptions = (decl?: EventView) =>
  Object.entries(decl?.recipients ?? {}).map(([value, r]) => ({ value, label: r.label ?? value }))

export const publishedTemplateOptions = (templates: TemplateView[]) =>
  templates
    .filter((t) => t.status === 'published')
    .map((t) => ({ value: t.key, label: `${t.key}（v${t.publishedRevision ?? '?'}）` }))

export const enabledChannelOptions = (channels: ChannelView[]) =>
  channels.filter((c) => c.enabled).map((c) => ({ value: c.id, label: `${c.id}（${c.provider}）` }))

export default function RulesTab() {
  const [rules, setRules] = useState<RuleView[]>([])
  const [events, setEvents] = useState<EventView[]>([])
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [channels, setChannels] = useState<ChannelView[]>([])
  const [loading, setLoading] = useState(false)
  const [deliv, setDeliv] = useState<Map<string, RuleDeliverability>>(new Map())
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const eventKey = Form.useWatch('eventKey', form) as string | undefined
  const decl = events.find((e) => e.key === eventKey)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, ev, t, ch, dv] = await Promise.all([
        get<{ rules: RuleView[] }>('/rules'),
        get<{ events: EventView[] }>('/events'),
        get<{ templates: TemplateView[] }>('/templates'),
        get<{ channels: ChannelView[] }>('/channels'),
        // 可送达性预检（只读）。失败不该拖垮整页 ⇒ 单独 catch 成空表
        get<{ rules: RuleDeliverability[] }>('/rules/deliverability')
          .catch(() => ({ rules: [] as RuleDeliverability[] })),
      ])
      setRules(r.rules)
      setEvents(ev.events)
      setTemplates(t.templates)
      setChannels(ch.channels)
      setDeliv(new Map(dv.rules.map((x) => [x.ruleId, x])))
    } catch (e) {
      message.error(`加载失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const onCreate = async (v: Record<string, unknown>) => {
    try {
      await post('/rules', v)
      setOpen(false)
      form.resetFields()
      await load()
      message.success('规则已保存（即时生效）')
    } catch (e) {
      message.error(`保存失败：${String(e)}`)
    }
  }

  const onToggle = async (id: string, enabled: boolean) => {
    try {
      await put(`/rules/${encodeURIComponent(id)}/enabled`, { enabled })
      await load()
    } catch (e) {
      message.error(`启停失败：${String(e)}`)
    }
  }

  const onDelete = async (id: string) => {
    try {
      await del(`/rules/${encodeURIComponent(id)}`)
      await load()
    } catch (e) {
      message.error(`删除失败：${String(e)}`)
    }
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        规则 = 事件 × 作用域 × 收件人 × 模板 × 通道。人工规则优先于声明派生；发错人可一键停用。
      </Typography.Paragraph>

      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setOpen((x) => !x)}>新建规则</Button>
        <Button onClick={() => void load()}>刷新</Button>
      </Space>

      {open && (
        <Form form={form} layout="inline" onFinish={onCreate} style={{ marginBottom: 16, rowGap: 8 }}>
          <Form.Item name="eventKey" label="事件" rules={[{ required: true }]}>
            <Select
              aria-label="事件"
              style={{ minWidth: 220 }}
              options={events.map((e) => ({ value: e.key, label: e.title ? `${e.title}（${e.key}）` : e.key }))}
            />
          </Form.Item>
          <Form.Item name="scope" label="作用域">
            <Input aria-label="作用域" placeholder="*" disabled={!decl?.scope} style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="recipientKey" label="收件人" rules={[{ required: true }]}>
            <Select aria-label="收件人" style={{ minWidth: 160 }} options={recipientOptions(decl)} />
          </Form.Item>
          <Form.Item name="templateKey" label="模板" rules={[{ required: true }]}>
            <Select aria-label="模板" style={{ minWidth: 220 }} options={publishedTemplateOptions(templates)} />
          </Form.Item>
          <Form.Item name="channels" label="通道" rules={[{ required: true }]}>
            <Select aria-label="通道" mode="multiple" style={{ minWidth: 220 }} options={enabledChannelOptions(channels)} />
          </Form.Item>
          <Form.Item name="cooldownMinutes" label="冷却(分)">
            <InputNumber aria-label="冷却(分)" min={0} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">保存</Button>
          </Form.Item>
        </Form>
      )}

      <Table<RuleView>
        rowKey="id"
        loading={loading}
        dataSource={rules}
        pagination={false}
        size="small"
        columns={[
          { title: '事件', dataIndex: 'eventKey' },
          { title: '作用域', dataIndex: 'scope' },
          {
            title: '收件人',
            render: (_, r) => `${r.recipientKey}${r.recipientLiteral ? `: ${r.recipientLiteral.join(',')}` : ''}`,
          },
          { title: '模板', dataIndex: 'templateKey' },
          { title: '通道', render: (_, r) => r.channels.join(' / ') },
          {
            title: '可解析',
            render: (_, r) => {
              const d = deliv.get(r.id)
              if (!d) return '—'
              return d.blocked === null
                ? <Tag color="green">{d.recipientCount} 人</Tag>
                : <Tag color="red">0 人（{blockedLabel(d.blocked)}）</Tag>
            },
          },
          {
            title: '来源',
            dataIndex: 'origin',
            render: (o: string) => <Tag color={o === 'derived' ? 'blue' : 'green'}>{o === 'derived' ? '声明派生' : '人工'}</Tag>,
          },
          {
            title: '启停',
            render: (_, r) => <Switch checked={r.enabled} onChange={(v) => void onToggle(r.id, v)} />,
          },
          {
            title: '操作',
            render: (_, r) => (
              <Popconfirm title="删除该规则？" onConfirm={() => void onDelete(r.id)}>
                <Button danger size="small" type="link">删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </>
  )
}
