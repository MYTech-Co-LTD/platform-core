// inbox.tsx — 收件箱（通知副本；已读 ≠ 已办）
import { useCallback, useEffect, useState } from 'react'
import { Button, Space, Table, Tag, Typography, message } from 'antd'
import { get, post, type InboxItem } from './api'

export default function InboxTab() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [unread, setUnread] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await get<{ items: InboxItem[] }>(`/inbox${unread ? '?unread=1' : ''}`)
      setItems(r.items)
    } catch (e) {
      message.error(`加载收件箱失败：${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [unread])

  useEffect(() => { void load() }, [load])

  const markAllRead = async () => {
    try {
      await post('/inbox/read-all')
      await load()
    } catch (e) {
      message.error(`全部已读失败：${String(e)}`)
    }
  }

  const markRead = async (id: string) => {
    try {
      await post(`/inbox/${encodeURIComponent(id)}/read`)
      await load()
    } catch (e) {
      message.error(`标记已读失败：${String(e)}`)
    }
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        收件箱是通知副本；已读 ≠ 已办。待办请以权威源为准。
      </Typography.Paragraph>

      <Space style={{ marginBottom: 12 }}>
        <Button type={unread ? 'primary' : 'default'} onClick={() => setUnread((x) => !x)}>
          {unread ? '只看未读' : '全部'}
        </Button>
        <Button onClick={() => void markAllRead()}>全部已读</Button>
        <Button onClick={() => void load()}>刷新</Button>
      </Space>

      <Table<InboxItem>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 20 }}
        size="small"
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 190 },
          { title: '标题', dataIndex: 'title' },
          { title: '正文', dataIndex: 'body' },
          {
            title: '链接',
            render: (_, r) => (r.link ? <a href={r.link} target="_blank" rel="noreferrer">{r.link}</a> : '—'),
          },
          {
            title: '状态',
            render: (_, r) => (
              r.readAt ? <Tag color="default">已读</Tag> : <Tag color="blue">未读</Tag>
            ),
          },
          {
            title: '操作',
            render: (_, r) => (
              r.readAt ? '—' : <Button size="small" onClick={() => void markRead(r.id)}>标记已读</Button>
            ),
          },
        ]}
      />
    </>
  )
}
