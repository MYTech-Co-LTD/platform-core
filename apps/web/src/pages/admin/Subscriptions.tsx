// pages/admin/Subscriptions.tsx — 我的订阅（只读，M3，spec D4）
//
// 真身在 Casdoor（平台超管发放/退订）；本页只把本租户 org 的 mod-* 订阅映射成模块视图。
// 订阅变更后菜单生效窗口 = config 缓存 TTL（默认 60s）。
import { useEffect, useState } from 'react'
import { App, Card, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ApiError, listAdminSubscriptions, type AdminSubscription } from '../../lib/api'

export default function AdminSubscriptionsPage() {
  const { message } = App.useApp()
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        setSubscriptions((await listAdminSubscriptions()).subscriptions)
      } catch (e) {
        message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
      } finally {
        setLoading(false)
      }
    })()
  }, [message])

  const columns: ColumnsType<AdminSubscription> = [
    {
      title: '模块',
      key: 'module',
      render: (_, s) => s.moduleName ?? s.moduleId,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 110,
      render: (v: string) => (v === 'Active' ? <Tag color="green">生效中</Tag> : <Tag>{v || '未知'}</Tag>),
    },
    { title: '开始', dataIndex: 'startTime', key: 'startTime', render: (v: string | null) => v ?? '—' },
    { title: '到期', dataIndex: 'endTime', key: 'endTime', render: (v: string | null) => v ?? '—' },
  ]

  return (
    <Card
      title="我的订阅"
      extra={<Typography.Text type="secondary">订阅由平台运营管理；退订后菜单在 1 分钟内自动隐藏</Typography.Text>}
    >
      <Table<AdminSubscription>
        rowKey={(s) => s.moduleId}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={subscriptions}
        pagination={false}
        locale={{ emptyText: '暂无订阅' }}
      />
    </Card>
  )
}
