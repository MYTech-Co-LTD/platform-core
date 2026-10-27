// channels.tsx — 通道配置 / 健康检查 / 测试发送（只发给自己）。
// 密钥只显示 env 键名与已配置状态，绝不回显值。
import { useCallback, useEffect, useState } from 'react'
import {
  Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography, message,
} from 'antd'
import { get, patch, post, type ChannelView, type TemplateView } from './api'

export default function ChannelsTab() {
  const [channels, setChannels] = useState<ChannelView[]>([])
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [loading, setLoading] = useState(false)
  const [configFor, setConfigFor] = useState<ChannelView | null>(null)
  const [testFor, setTestFor] = useState<ChannelView | null>(null)
  const [configForm] = Form.useForm()
  const [testForm] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, t] = await Promise.all([
        get<{ channels: ChannelView[] }>('/channels'),
        get<{ templates: TemplateView[] }>('/templates'),
      ])
      setChannels(c.channels)
      setTemplates(t.templates.filter((x) => x.status === 'published'))
    } catch (e) {
      message.error(`加载失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const onToggle = async (id: string, enabled: boolean) => {
    try {
      await patch(`/channels/${encodeURIComponent(id)}`, { enabled })
      await load()
    } catch (e) {
      message.error(`启停失败：${String(e)}`)
    }
  }

  const onHealth = async (id: string) => {
    try {
      const r = await post<{ ok: boolean; detail?: string }>(`/channels/${encodeURIComponent(id)}/health`)
      message[r.ok ? 'success' : 'error'](r.ok ? '健康检查通过' : `健康检查失败：${r.detail ?? ''}`)
      await load()
    } catch (e) {
      message.error(`健康检查失败：${String(e)}`)
    }
  }

  const openConfig = (ch: ChannelView) => {
    setConfigFor(ch)
    configForm.setFieldsValue({
      address_fallback: ch.config.address_fallback ?? 'none',
      rate_limit_per_min: ch.config.rate_limit_per_min,
      timeout_ms: ch.config.timeout_ms,
    })
  }

  const saveConfig = async () => {
    if (!configFor) return
    const v = await configForm.validateFields()
    const config: Record<string, unknown> = {}
    if (v.address_fallback !== undefined) config.address_fallback = v.address_fallback
    if (v.rate_limit_per_min != null) config.rate_limit_per_min = v.rate_limit_per_min
    if (v.timeout_ms != null) config.timeout_ms = v.timeout_ms
    try {
      await patch(`/channels/${encodeURIComponent(configFor.id)}`, { config })
      setConfigFor(null)
      await load()
      message.success('通道配置已保存')
    } catch (e) {
      message.error(`保存失败：${String(e)}`)
    }
  }

  const sendTest = async () => {
    if (!testFor) return
    const v = await testForm.validateFields()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(v.payload || '{}') as Record<string, unknown>
    } catch {
      message.error('payload 不是合法 JSON')
      return
    }
    try {
      await post('/test-send', { templateKey: v.templateKey, channel: testFor.id, payload })
      setTestFor(null)
      testForm.resetFields()
      message.success('测试消息已入队（只发给你自己）')
    } catch (e) {
      message.error(`测试发送失败：${String(e)}`)
    }
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        通道凭据由运维在 env 层预备；这里只显示 env 键名，不回显值。测试发送只发给当前登录人。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        webhook 通道：出站只允许 https、拒绝私网/回环/元数据地址、不跟随重定向、带 HMAC 签名；
        健康检查会发一个签名探针（2xx 视为健康）。
      </Typography.Paragraph>

      <Table<ChannelView>
        rowKey="id"
        loading={loading}
        dataSource={channels}
        pagination={false}
        size="small"
        columns={[
          { title: '通道', dataIndex: 'id' },
          { title: 'provider', dataIndex: 'provider' },
          {
            title: '启停',
            render: (_, r) => <Switch checked={r.enabled} onChange={(v) => void onToggle(r.id, v)} />,
          },
          {
            title: '凭据',
            render: (_, r) => (
              <>
                <Tag color={r.configured ? 'green' : 'red'}>{r.configured ? '已配置' : '未配置'}</Tag>
                {Object.values(r.secretRefs).map((k) => <Tag key={k}>{k}</Tag>)}
              </>
            ),
          },
          {
            title: '健康',
            render: (_, r) => (r.health ? <Tag color={r.health.startsWith('ok') ? 'green' : 'red'}>{r.health}</Tag> : '—'),
          },
          {
            title: '操作',
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => void onHealth(r.id)}>健康检查</Button>
                <Button size="small" onClick={() => openConfig(r)}>配置</Button>
                <Button size="small" onClick={() => { setTestFor(r); testForm.resetFields() }}>测试发送</Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`配置通道 ${configFor?.id ?? ''}`}
        open={configFor !== null}
        onCancel={() => setConfigFor(null)}
        onOk={() => void saveConfig()}
        okText="保存"
      >
        <Form form={configForm} layout="vertical">
          <Form.Item name="address_fallback" label="地址回退">
            <Select
              options={[
                { value: 'none', label: 'none（只认 identity_link）' },
                { value: 'casdoor_name', label: 'casdoor_name（Casdoor 名 = 企微 userid）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="rate_limit_per_min" label="每分钟上限">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="timeout_ms" label="超时（毫秒）">
            <InputNumber min={1000} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`测试发送（${testFor?.id ?? ''}）`}
        open={testFor !== null}
        onCancel={() => setTestFor(null)}
        onOk={() => void sendTest()}
        okText="发送给我"
      >
        <Typography.Paragraph type="secondary">收件人固定为当前登录人，不可指定他人。</Typography.Paragraph>
        <Form form={testForm} layout="vertical">
          <Form.Item name="templateKey" label="模板" rules={[{ required: true }]}>
            <Select options={templates.map((t) => ({ value: t.key, label: t.key }))} />
          </Form.Item>
          <Form.Item name="payload" label="payload（JSON）" rules={[{ required: true }]}>
            <Input.TextArea rows={4} placeholder='{"title":"T","link":"https://x"}' />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
