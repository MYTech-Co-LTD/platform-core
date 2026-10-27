// events.tsx — 事件目录（只读；宿主注入的目录快照）
import { useEffect, useState } from 'react'
import { Table, Tag, Typography, message } from 'antd'
import { get, type EventView } from './api'

export default function EventsTab() {
  const [rows, setRows] = useState<EventView[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    get<{ events: EventView[] }>('/events')
      .then((r) => setRows(r.events))
      .catch((e) => message.error(`加载事件失败：${String(e)}`))
      .finally(() => setLoading(false))
  }, [])

  return (
    <>
      <Typography.Paragraph type="secondary">
        事件由模块在 manifest 声明；这里只读。规则只能引用已声明的收件人与事件。
      </Typography.Paragraph>
      <Table<EventView>
        rowKey="key"
        loading={loading}
        dataSource={rows}
        pagination={false}
        size="small"
        expandable={{
          expandedRowRender: (r) => (
            <pre style={{ margin: 0, fontSize: 12 }}>
              {JSON.stringify({ payload: r.payload, recipients: r.recipients, defaults: r.defaults }, null, 2)}
            </pre>
          ),
        }}
        columns={[
          { title: '事件', dataIndex: 'key' },
          { title: '标题', dataIndex: 'title' },
          {
            title: '作用域',
            render: (_, r) => (r.scope ? r.scope.key : <Tag>无</Tag>),
          },
          {
            title: '收件人',
            render: (_, r) => Object.keys(r.recipients).map((k) => <Tag key={k}>{k}</Tag>),
          },
          {
            title: '默认规则',
            render: (_, r) => (r.defaults ? `${r.defaults.recipient} → ${r.defaults.template}` : '—'),
          },
        ]}
      />
    </>
  )
}
