// console/monitors/index.tsx — 业务监控管理页（D 子项目，#2436）。
//
// agent 能建监控（恒 dry_run=true），人在这里看到并**开闸**（关 dry_run 开始投递）。
// 页面只做展示 + 两枚开关（dry_run / enabled）+ 运行记录抽屉；改阈值/收件人不在本页
// （agent 或 HTTP 面建，人只管「开不开」——与报表发布同一个人 gate 口径）。
// API 复用 GET/PATCH /monitors（门=data:query；改/停仅创建者或 data:manage）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Drawer, Empty, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd'
import { apiGet, apiSend } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

type Monitor = {
  id: string; name: string
  targetKind: 'metric' | 'report_panel'
  metricId: string | null; reportId: string | null; panelIndex: number | null
  verdict: 'missing' | 'stale' | 'threshold'
  operator: string | null; threshold: string | null
  windowDays: number; cadenceSecs: number
  dryRun: boolean; enabled: boolean; state: 'ok' | 'firing' | 'unknown'
  stateSince: string | null; lastEvalAt: string | null
  recipients: Array<{ kind: string; ref: string }>
  createdBy: string
}

type Run = {
  id: string; evaluatedAt: string; verdict: string; value: string | null
  stateAfter: string; notified: boolean; dryRun: boolean; error: string | null
}

const STATE_COLOR: Record<Monitor['state'], string> = { ok: 'green', firing: 'red', unknown: 'orange' }
const STATE_LABEL: Record<Monitor['state'], string> = { ok: '正常', firing: '告警中', unknown: '判不了' }
const VERDICT_LABEL: Record<Monitor['verdict'], string> = {
  missing: '数据没了', stale: '数据过期', threshold: '阈值越界',
}
const TARGET_LABEL: Record<Monitor['targetKind'], string> = {
  metric: '指标', report_panel: '报表面板',
}

function cadenceLabel(secs: number): string {
  if (secs < 3600) return `${Math.round(secs / 60)} 分钟`
  if (secs < 86400) return `${Math.round(secs / 3600)} 小时`
  return `${Math.round(secs / 86400)} 天`
}

function targetOf(m: Monitor): string {
  if (m.targetKind === 'metric') return m.metricId ?? '—'
  return `${m.reportId ?? '—'}#${m.panelIndex ?? '—'}`
}

export default function MonitorsPage() {
  const [rows, setRows] = useState<Monitor[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<HumanError | null>(null)
  const [runsFor, setRunsFor] = useState<Monitor | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const b = await apiGet('/monitors') as { monitors?: Monitor[] }
      setRows(Array.isArray(b.monitors) ? b.monitors : [])
    } catch (e) { setErr(humanError(e)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const loadRuns = useCallback(async (m: Monitor) => {
    setRunsLoading(true)
    try {
      const b = await apiGet(`/monitors/${encodeURIComponent(m.id)}/runs?limit=50`) as { runs?: Run[] }
      setRuns(Array.isArray(b.runs) ? b.runs : [])
    } catch { setRuns([]) } finally { setRunsLoading(false) }
  }, [])

  const patch = async (m: Monitor, body: Record<string, boolean>) => {
    setErr(null)
    try {
      await apiSend(`/monitors/${encodeURIComponent(m.id)}`, 'PATCH', body)
      await load()
      if (runsFor?.id === m.id) await loadRuns(m)
    } catch (e) { setErr(humanError(e)) }
  }

  const cols = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '目标', key: 'target', render: (_: unknown, m: Monitor) => (
      <Space size={4}>
        <Tag>{TARGET_LABEL[m.targetKind]}</Tag>
        <Typography.Text code style={{ fontSize: 12 }}>{targetOf(m)}</Typography.Text>
      </Space>
    )},
    { title: '判据', key: 'verdict', render: (_: unknown, m: Monitor) => (
      <span>
        {VERDICT_LABEL[m.verdict]}
        {m.verdict === 'threshold' && m.threshold !== null && (
          <Typography.Text type="secondary" style={{ marginLeft: 4 }}>
            {m.operator} {m.threshold}
          </Typography.Text>
        )}
      </span>
    )},
    { title: '状态', key: 'state', render: (_: unknown, m: Monitor) => (
      <Tag color={STATE_COLOR[m.state]}>{STATE_LABEL[m.state]}</Tag>
    )},
    { title: '投递', key: 'dryRun', width: 100, render: (_: unknown, m: Monitor) => (
      <Popconfirm
        title={m.dryRun ? '开闸后将按判据实际发送通知' : '切回影子期将停止发送（只记录）'}
        onConfirm={() => patch(m, { dryRun: !m.dryRun })}
        disabled={!m.enabled}
      >
        <Switch
          checked={!m.dryRun}
          checkedChildren="投递中"
          unCheckedChildren="影子期"
          disabled={!m.enabled}
          size="small"
        />
      </Popconfirm>
    )},
    { title: '启用', key: 'enabled', width: 70, render: (_: unknown, m: Monitor) => (
      <Switch
        checked={m.enabled}
        onChange={(v: boolean) => patch(m, { enabled: v })}
        size="small"
      />
    )},
    { title: '周期', key: 'cadence', width: 80, render: (_: unknown, m: Monitor) => cadenceLabel(m.cadenceSecs) },
    { title: '最近求值', key: 'lastEval', width: 150, render: (_: unknown, m: Monitor) =>
      m.lastEvalAt ? new Date(m.lastEvalAt).toLocaleString('zh-CN') : '—' },
    { title: '操作', key: 'actions', width: 90, render: (_: unknown, m: Monitor) => (
      <a onClick={() => { setRunsFor(m); void loadRuns(m) }}>运行记录</a>
    )},
  ]

  return (
    <Card title="业务监控" styles={{ body: { padding: 0 } }}>
      {err && <Alert type="error" showIcon message={err.text} description={err.code} style={{ margin: 12 }} closable onClose={() => setErr(null)} />}
      <Table<Monitor>
        rowKey="id"
        dataSource={rows}
        columns={cols}
        loading={loading}
        size="small"
        pagination={false}
        locale={{ emptyText: <Empty description="暂无监控；可让 agent 在对话中建，或从报表面板的「挂监控」入口创建" /> }}
      />
      <Drawer
        title={runsFor ? `运行记录：${runsFor.name}` : ''}
        open={runsFor !== null}
        onClose={() => setRunsFor(null)}
        width={640}
      >
        <Table<Run>
          rowKey="id"
          dataSource={runs}
          loading={runsLoading}
          size="small"
          pagination={false}
          locale={{ emptyText: <Empty description="尚无求值记录" /> }}
          columns={[
            { title: '时间', dataIndex: 'evaluatedAt', width: 150, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '判定', dataIndex: 'verdict', width: 80 },
            { title: '值', dataIndex: 'value', width: 80, render: (v: string | null) => v ?? '—' },
            { title: '状态', dataIndex: 'stateAfter', width: 80 },
            { title: '投递', key: 'notified', width: 60, render: (_: unknown, r: Run) =>
              r.notified ? <Tag color="blue">已发</Tag> : <Tag>未发</Tag> },
            { title: '错误', dataIndex: 'error', ellipsis: true, render: (v: string | null) => v ?? '—' },
          ]}
        />
      </Drawer>
    </Card>
  )
}
