// pages/admin/Subscriptions.tsx — 我的订阅（只读，M3，spec D4）
//
// 真身在 Casdoor（平台超管发放/退订）；本页只把本租户 org 的 mod-* 订阅映射成模块视图。
// 订阅变更后菜单生效窗口 = config 缓存 TTL（默认 60s）。
import { useEffect, useState } from 'react'
import { App, Card, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ApiError, listAdminSubscriptions, type AdminSubscription } from '../../lib/api'
import { ConsolePage } from '../../components/ConsolePage'

function fmtTime(v: string | null): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
}

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
    // Casdoor 回的是 RFC3339 UTC（如 2026-01-01T00:00:00Z）；直接摆原串没人读得懂，转本地时间
    { title: '开始', dataIndex: 'startTime', key: 'startTime', render: fmtTime },
    { title: '到期', dataIndex: 'endTime', key: 'endTime', render: fmtTime },
  ]

  return (
    <ConsolePage
      title="我的订阅"
      description="已开通的模块，由平台运营发放。"
    >
    <Card>
      <Table<AdminSubscription>
        rowKey={(s) => s.moduleId}
        size="small"
        loading={loading}
        columns={columns}
        dataSource={subscriptions}
        pagination={false}
        locale={{
          emptyText: (
            <div style={{ padding: '32px 0' }}>
              <Typography.Text type="secondary">还没有订阅任何模块。需要开通模块请联系平台运营。</Typography.Text>
            </div>
          ),
        }}
      />
    </Card>
    </ConsolePage>
  )
}
