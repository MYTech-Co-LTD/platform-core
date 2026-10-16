// console/FormsList.tsx — 表单列表页（issue #718）：资产/版本三态总览 + 填报入口。
// 填报按钮只在「有 head 版本」且会话含 forms:fill 时亮——无码的人不进填报页
//（页门是 forms:view；提交 API 的 forms:fill 由后端门卫权威施加，这里只是不引人撞墙）。
import { useEffect, useState } from 'react'
import { Button, Table, Typography } from 'antd'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { apiGet } from './api'
import type { DefSummary } from './api'

interface ConsoleContext {
  session: { scopes: string[] }
}

export default function FormsList() {
  const navigate = useNavigate()
  const { session } = useOutletContext<ConsoleContext>()
  const canFill = session.scopes.includes('forms:fill')

  const [defs, setDefs] = useState<DefSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiGet<{ defs: DefSummary[] }>('/api/modules/forms/defs')
      .then((body) => {
        if (!cancelled) setDefs(body.defs)
      })
      .catch(() => {
        if (!cancelled) setDefs([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <Typography.Title level={5}>表单</Typography.Title>
      <Table<DefSummary>
        rowKey="assetId"
        size="small"
        loading={loading}
        dataSource={defs}
        pagination={false}
        columns={[
          { title: '表单', dataIndex: 'assetId' },
          {
            title: '当前版本',
            dataIndex: 'headVersion',
            render: (v: number | null) => (v === null ? '—' : `v${v}`),
          },
          { title: '草稿', dataIndex: 'draftCount', width: 70 },
          { title: '已发布', dataIndex: 'publishedCount', width: 80 },
          { title: '已退役', dataIndex: 'retiredCount', width: 80 },
          {
            title: '操作',
            key: 'action',
            width: 90,
            render: (_, record) =>
              canFill && record.headVersion !== null ? (
                <Button
                  type="link"
                  size="small"
                  onClick={() => navigate(`/console/forms/fill/${record.assetId}`)}
                >
                  填报
                </Button>
              ) : (
                <span style={{ color: 'rgba(0,0,0,0.35)' }}>{record.headVersion === null ? '未发布' : '—'}</span>
              ),
          },
        ]}
      />
    </div>
  )
}
