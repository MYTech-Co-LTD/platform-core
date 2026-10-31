// pages/admin/Integrations.tsx — 集成健康（只读；spec 2026-10-31-integration-health-design.md §2.3）
//
// 这一屏回答一个此前**没有任何界面回答**的问题：「我们接的那些出站集成，现在还有动静吗？」
// 触发案例：woke 的企微 suite_ticket 自 2026-08-30 起断流两个月，零信号——回调型集成没有调用方，
// 所以引擎告警/投递失败/容器健康/job 失败四种机制全都覆盖不到。
//
// 纪律：**判定在服务端**（`integration-health.ts` 纯函数）。本页只渲染结论与原因，不自己算
// 「多久算超期」——两处口径一旦分叉，最先失效的恰好是这一屏该守住的东西。
import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ApiError, listAdminIntegrations, type AdminIntegration } from '../../lib/api'

/** 结论 → 徽标。四态：STALE 红（真没动静）、PROBE_FAILED 橙（探不了，别误判）、OK 绿、DISABLED 灰。 */
function VerdictTag({ verdict }: { verdict: AdminIntegration['health']['verdict'] }) {
  if (verdict === 'STALE') return <Tag color="red">太久没消息</Tag>
  if (verdict === 'PROBE_FAILED') return <Tag color="orange">探针失败</Tag>
  if (verdict === 'DISABLED') return <Tag>已停用</Tag>
  return <Tag color="green">正常</Tag>
}

const KIND_LABEL: Record<AdminIntegration['kind'], string> = {
  callback: '回调（该来的来了吗）',
  token: '凭据（还能换到吗）',
  channel: '通道（最近真投递）',
}

export default function AdminIntegrationsPage() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<AdminIntegration[]>([])
  const [summary, setSummary] = useState({ total: 0, stale: 0, probeFailed: 0 })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listAdminIntegrations()
      setRows(r.integrations)
      setSummary(r.summary)
    } catch (e) {
      message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { void load() }, [load])

  const columns: ColumnsType<AdminIntegration> = [
    {
      title: '集成',
      key: 'id',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{r.id}</Typography.Text>
          {r.note ? <Typography.Text type="secondary">{r.note}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: '类型', dataIndex: 'kind', key: 'kind', width: 190, render: (k: AdminIntegration['kind']) => KIND_LABEL[k] },
    {
      title: '允许静默',
      dataIndex: 'slaSeconds',
      key: 'slaSeconds',
      width: 120,
      // 服务端已算成人话（reason 里带），这列给「一眼看阈值」用
      render: (v: number) => (v >= 86400 ? `${Math.round(v / 86400)} 天` : v >= 3600 ? `${Math.round(v / 3600)} 小时` : `${Math.round(v / 60)} 分钟`),
    },
    {
      title: '结论',
      key: 'verdict',
      width: 140,
      render: (_, r) => <VerdictTag verdict={r.health.verdict} />,
    },
    {
      title: '说明',
      key: 'reason',
      // 服务端给的就是人话（含年龄与 SLA），这里不再二次翻译
      render: (_, r) => <Typography.Text type={r.health.verdict === 'OK' ? 'secondary' : undefined}>{r.health.reason}</Typography.Text>,
    },
    {
      title: '最近证据',
      dataIndex: 'lastOkAt',
      key: 'lastOkAt',
      width: 190,
      render: (v: string | null) => (v ? new Date(v).toLocaleString() : '从未'),
    },
  ]

  return (
    <Card
      title="集成健康"
      extra={<Button onClick={() => void load()} loading={loading}>刷新</Button>}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          「回调」型集成没有调用方，坏了也不会报错——所以要看它「多久没动静」；
          「凭据」型要主动换一次才知道还活着。阈值（允许静默时长）按各自的推送/使用周期设定。
        </Typography.Paragraph>
        {summary.stale > 0 && (
          <Alert
            type="error"
            showIcon
            message={`${summary.stale} 个集成太久没有活性证据`}
            description="先看「说明」列：它给的是最后一 次证据距今多久、阈值多少。回调型优先怀疑对方停止推送或授权失效（如代开发 suite_ticket 断流）。"
          />
        )}
        {summary.probeFailed > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`${summary.probeFailed} 个集成的探针自己没跑通`}
            description="「探不了」不等于「它坏了」——先查探针侧的连接/权限，别急着去改集成配置。"
          />
        )}
        <Table<AdminIntegration>
          rowKey={(r) => `${r.id}@${r.org}`}
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: '还没有登记任何集成（Phase 3 起：新接通道/回调必须先登记判据）' }}
        />
      </Space>
    </Card>
  )
}
