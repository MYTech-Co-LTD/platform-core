// console/index.tsx — 定时任务页（Wave 6 P4 遗留：console 面）。
//
// 只读：排班列表 + 点行看最近运行。**手动触发不在页面上开放**——它需要 CSRF 与会话身份，
// V1 先让 API/agent 走（`POST /api/modules/jobs/:key/run`，`jobs:manage`）。
// 数据来自模块自己的 API（`/api/modules/jobs/*`，宿主按 manifest 施 `jobs:read` 门）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Empty, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'

interface ScheduleView {
  id: string
  key: string
  enabled: boolean
  cron: string
  timezone: string
  nextRunAt: string | null
  lastStatus: string | null
  lastRunAt: string | null
}

interface RunView {
  id: string
  key: string
  status: string
  trigger: string
  attempt: number
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  durationMs: number | null
  outputTail: string | null
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'green', failed: 'red', timeout: 'orange', running: 'blue', queued: 'default', skipped: 'default',
}

function fmt(ts: string | null): string {
  if (ts === null) return '—'
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

export default function JobsConsolePage() {
  const [rows, setRows] = useState<ScheduleView[]>([])
  const [runs, setRuns] = useState<RunView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadSchedules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/modules/jobs/schedules')
      const body = (await res.json().catch(() => ({}))) as { schedules?: ScheduleView[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setRows(body.schedules ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRuns = useCallback(async (key: string) => {
    try {
      const res = await fetch(`/api/modules/jobs/runs/${encodeURIComponent(key)}?limit=20`)
      const body = (await res.json().catch(() => ({}))) as { runs?: RunView[]; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setRuns(body.runs ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void loadSchedules() }, [loadSchedules])

  const columns: ColumnsType<ScheduleView> = [
    { title: '任务', dataIndex: 'key', width: 220, ellipsis: true },
    {
      title: '状态', dataIndex: 'enabled', width: 90,
      render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    { title: 'Cron', dataIndex: 'cron', width: 140 },
    { title: '时区', dataIndex: 'timezone', width: 90 },
    { title: '下次运行', dataIndex: 'nextRunAt', width: 180, render: fmt },
    {
      title: '最近运行', dataIndex: 'lastStatus', width: 150,
      render: (v: string | null, r) => (v === null
        ? <Typography.Text type="secondary">—</Typography.Text>
        : <Space size={6}><Tag color={STATUS_COLOR[v] ?? 'default'}>{v}</Tag><Typography.Text type="secondary">{fmt(r.lastRunAt)}</Typography.Text></Space>),
    },
  ]

  const runColumns: ColumnsType<RunView> = [
    { title: '#', dataIndex: 'id', width: 80 },
    { title: '触发', dataIndex: 'trigger', width: 90 },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{v}</Tag> },
    { title: '开始', dataIndex: 'startedAt', width: 180, render: fmt },
    { title: '耗时', dataIndex: 'durationMs', width: 90, render: (v: number | null) => (v === null ? '—' : `${v}ms`) },
    { title: '退出码', dataIndex: 'exitCode', width: 90, render: (v: number | null) => (v === null ? '—' : String(v)) },
    { title: '输出尾部', dataIndex: 'outputTail', ellipsis: true, render: (v: string | null) => v ?? '—' },
  ]

  return (
    <div style={{ padding: 16 }}>
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>定时任务</Typography.Title>
        <Typography.Text type="secondary">
          平台内置调度器驱动的周期任务：cron 在代码目录（registry），启停与下次运行在库。
          点一行看最近 20 次运行。
        </Typography.Text>
        {error !== null ? <Alert type="error" showIcon title={`加载失败：${error}`} /> : null}
        <Card size="small">
          <Table<ScheduleView>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty description="还没有系统任务" /> }}
            onRow={(r) => ({
              onClick: () => { setSelected(r.key); void loadRuns(r.key) },
              style: { cursor: 'pointer' },
            })}
          />
        </Card>
        <Card
          size="small"
          title={selected === null ? '运行记录（点上方任务查看）' : `运行记录：${selected}`}
        >
          <Table<RunView>
            rowKey="id"
            size="small"
            columns={runColumns}
            dataSource={runs}
            pagination={{ pageSize: 10, size: 'small' }}
            scroll={{ x: 900 }}
            locale={{ emptyText: <Empty description={selected === null ? '先选择一条任务' : '还没有运行记录'} /> }}
          />
        </Card>
      </Space>
    </div>
  )
}
