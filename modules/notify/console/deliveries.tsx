// deliveries.tsx — 投递回执（审计面）+ 单条重试
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Select, Space, Table, Tag, Typography, message } from 'antd'
import { get, post, type DeliveryView, type NamespaceStatView } from './api'

const STATUSES = ['pending', 'sent', 'failed', 'dead', 'suppressed']

export default function DeliveriesTab() {
  const [rows, setRows] = useState<DeliveryView[]>([])
  const [stats, setStats] = useState<NamespaceStatView[]>([])
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<string | undefined>()
  const [channel, setChannel] = useState<string | undefined>()
  const [namespace, setNamespace] = useState<string | undefined>()
  const [recipient, setRecipient] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, s] = await Promise.all([
        get<{ deliveries: DeliveryView[] }>('/deliveries'),
        get<{ stats: NamespaceStatView[] }>('/stats?sinceHours=24'),
      ])
      setRows(r.deliveries)
      setStats(s.stats)
    } catch (e) {
      message.error(`加载投递失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => rows.filter((r) =>
    (!status || r.status === status)
    && (!channel || r.channel === channel)
    && (!namespace || (r.ownerNamespace ?? '') === namespace)
    && (!recipient || r.recipient.includes(recipient))), [rows, status, channel, namespace, recipient])

  const channelOptions = [...new Set(rows.map((r) => r.channel))]
  const namespaceOptions = [...new Set([
    ...rows.map((r) => r.ownerNamespace ?? ''),
    ...stats.map((s) => s.namespace ?? ''),
  ])].sort()

  const onRetry = async (r: DeliveryView) => {
    try {
      await post('/deliveries/retry', {
        eventId: r.eventId, ruleId: r.ruleId, recipient: r.recipient, channel: r.channel,
      })
      await load()
      message.success('已重新入队')
    } catch (e) {
      message.error(`重试失败：${String(e)}`)
    }
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        每条 = 规则 × 收件人 × 通道的一次投递；失败摘要用于排障。重试只对 failed/dead 开放。
      </Typography.Paragraph>

      <Space style={{ marginBottom: 12 }}>
        <Select
          aria-label="状态"
          allowClear
          placeholder="状态"
          style={{ width: 140 }}
          value={status}
          onChange={setStatus}
          options={STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <Select
          aria-label="通道"
          allowClear
          placeholder="通道"
          style={{ width: 180 }}
          value={channel}
          onChange={setChannel}
          options={channelOptions.map((c) => ({ value: c, label: c }))}
        />
        <Select
          aria-label="namespace"
          allowClear
          placeholder="namespace"
          style={{ width: 180 }}
          value={namespace}
          onChange={setNamespace}
          options={namespaceOptions.map((n) => ({ value: n, label: n || '平台/租户' }))}
        />
        <Input
          aria-label="收件人"
          placeholder="收件人包含…"
          style={{ width: 180 }}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
        <Button onClick={() => void load()}>刷新</Button>
      </Space>

      {stats.length > 0 && (
        <Table<NamespaceStatView>
          rowKey={(r) => r.namespace ?? '__platform'}
          dataSource={stats}
          size="small"
          pagination={false}
          style={{ marginBottom: 16 }}
          title={() => '近 24h 按 namespace'}
          columns={[
            { title: 'namespace', render: (_, r) => r.namespace ?? <Tag>平台/租户</Tag> },
            { title: '事件', dataIndex: 'events', width: 80 },
            { title: '投递', dataIndex: 'deliveries', width: 80 },
            { title: 'sent', dataIndex: 'sent', width: 80 },
            { title: 'failed', dataIndex: 'failed', width: 80 },
            { title: 'dead', dataIndex: 'dead', width: 80 },
            { title: '积压>10m', dataIndex: 'stalePending', width: 100 },
          ]}
        />
      )}

      <Table<DeliveryView>
        rowKey={(r) => `${r.eventId}|${r.ruleId}|${r.recipient}|${r.channel}`}
        loading={loading}
        dataSource={filtered}
        size="small"
        pagination={{ pageSize: 20 }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 190 },
          { title: '事件', dataIndex: 'eventKey' },
          {
            title: 'namespace',
            render: (_, r) => r.ownerNamespace ?? <Tag>平台/租户</Tag>,
          },
          { title: '收件人', dataIndex: 'recipient' },
          { title: '通道', dataIndex: 'channel' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s: string) => (
              <Tag color={s === 'sent' ? 'green' : s === 'failed' ? 'orange' : s === 'dead' ? 'red' : 'default'}>
                {s}
              </Tag>
            ),
          },
          { title: '尝试', dataIndex: 'attempts', width: 70 },
          {
            title: '测试',
            render: (_, r) => (r.isTest ? <Tag>test</Tag> : '—'),
          },
          { title: '错误', dataIndex: 'lastError' },
          {
            title: '操作',
            render: (_, r) => (
              r.status === 'failed' || r.status === 'dead'
                ? <Button size="small" onClick={() => void onRetry(r)}>重试</Button>
                : '—'
            ),
          },
        ]}
      />
    </>
  )
}
