// console/observability/index.tsx — 「运行观测」页（2026-11-22，#2681）。
//
// 与「体系地图 / 管线地图」的分工：
//   体系地图  = 结构（指标/对象/字段之间的关系）
//   管线地图  = 链路（资产 → staging → marts 通没通）
//   **本页**  = 现在（调度档位 / 22 条体检 / 湖卫生 / 物化水位 / 对账差异）
//
// 只读：没有任何触发/重跑按钮（首版边界）。数据 30 秒自动刷新；
// 页面不可见时暂停轮询（切走不空转）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Card, Descriptions, Drawer, Empty, Space, Switch, Table, Tag, Typography } from 'antd'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

interface ScheduleRow {
  key: string
  cron: string
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  lastRun: { status: string; at: string; durationMs: number | null; exitCode: number | null; error: string | null } | null
  fails24h: number
}
interface AssertionRow { group: 'core' | 'oo'; check: string; verdict: 'ok' | 'warn' | 'err'; detail: string; at: string }
interface ReconBranch {
  systemBook: string; bizday: string; branchNum: number; diff: number
  attribution: string | null; swapOffset: number
}
interface Body {
  generatedAt: string
  schedules: ScheduleRow[]
  assertions: { rows: AssertionRow[]; coreAt: string | null; ooAt: string | null }
  lake: {
    hourFiles: number | null; hourOldest: string | null; dayFiles: number | null; dayNewest: string | null
    monthFiles: number | null; sealedMax: string | null; monthIndexMax: string | null; error?: string
  }
  materialization: Array<{ relation: string; status: string; maxBizday: string | null; materializedAt: string }>
  recon: {
    windowDays: number; storeDays: number; overTol: number; withinTol: number; overTolDiffSum: number
    byAttribution: Array<{ attribution: string; n: number; swapOffset: number }>
    topBranches: ReconBranch[]
  } | { error: string }
  warnings: string[]
}
interface ReconDetailRow {
  system_book: string; bizday: string; branch_num: number; control: string | null
  platform_value: string | null; source_value: string | null; diff: string | null
  tol_applied: string | null; bound_by: string | null; verdict: string; missing_side: string | null
  reason_code: string | null; disposition: string | null; attribution: string | null
  swap_offset: string | null; computed_at: string | null
}

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const money = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : `¥${nf.format(Number(v))}`)
const dt = (v: string | null | undefined) => (v === null || v === undefined ? '—' : new Date(v).toLocaleString('zh-CN', { hour12: false }))
const dur = (ms: number | null) => (ms === null ? '—' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`)

function StatusTag({ s }: { s: string }) {
  const map: Record<string, { color: string; text: string }> = {
    ok: { color: 'success', text: '正常' },
    warn: { color: 'warning', text: '观察' },
    err: { color: 'error', text: '异常' },
    failed: { color: 'error', text: '失败' },
    timeout: { color: 'error', text: '超时' },
    running: { color: 'processing', text: '运行中' },
  }
  const m = map[s] ?? { color: 'default', text: s }
  return <Tag color={m.color}>{m.text}</Tag>
}

export default function ObservabilityPage() {
  const [body, setBody] = useState<Body | null>(null)
  const [err, setErr] = useState<HumanError | null>(null)
  const [auto, setAuto] = useState(true)
  const [loading, setLoading] = useState(false)
  const [drawer, setDrawer] = useState<{ row: ReconBranch; rows: ReconDetailRow[]; total: number } | null>(null)
  const [drawerBusy, setDrawerBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = (await apiGet('/system-map/observability')) as Body
      setBody(data)
      setErr(null)
    } catch (e) {
      setErr(humanError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 30 秒自动刷新；页面不可见时跳过（切走不空转）。
  useEffect(() => {
    if (!auto) return undefined
    const t = window.setInterval(() => {
      if (!document.hidden) void load()
    }, 30_000)
    return () => window.clearInterval(t)
  }, [auto, load])

  const openBranch = useCallback(async (row: ReconBranch) => {
    setDrawerBusy(true)
    setDrawer({ row, rows: [], total: 0 })
    try {
      const qs = new URLSearchParams({
        book: row.systemBook, bizday: row.bizday, branch: String(row.branchNum), verdict: 'over_tol', limit: '200',
      })
      const res = (await apiGet(`/system-map/observability/recon?${qs.toString()}`)) as { rows: ReconDetailRow[]; total: number }
      setDrawer({ row, rows: res.rows, total: res.total })
    } catch (e) {
      setErr(humanError(e))
      setDrawer(null)
    } finally {
      setDrawerBusy(false)
    }
  }, [])

  const assertionSummary = useMemo(() => {
    const rows = body?.assertions.rows ?? []
    return {
      ok: rows.filter((r) => r.verdict === 'ok').length,
      warn: rows.filter((r) => r.verdict === 'warn').length,
      err: rows.filter((r) => r.verdict === 'err').length,
      total: rows.length,
    }
  }, [body])

  const recon = body !== null && !('error' in body.recon) ? body.recon : null

  return (
    <div>
      <Space align="center" style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>运行观测</Typography.Title>
        <Space size={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {body === null ? (loading ? '加载中…' : '') : `更新于 ${dt(body.generatedAt)} · 30 秒自动刷新`}
          </Typography.Text>
          <Switch size="small" checked={auto} onChange={setAuto} checkedChildren="自动" unCheckedChildren="暂停" />
        </Space>
      </Space>

      {err !== null && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={err.text} description={`错误码：${err.code}${err.detail === undefined ? '' : ` · ${err.detail}`}`} />}
      {body !== null && body.warnings.length > 0 && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="部分数据源读取失败（其余区块仍可用）"
          description={body.warnings.join('；')}
        />
      )}

      {/* ── KPI ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 12 }}>
        <Card size="small">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>体检通过</Typography.Text>
          <div style={{ fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>
            {assertionSummary.ok}<span style={{ fontSize: 14, color: '#8c8c8c' }}> / {assertionSummary.total || '—'}</span>
          </div>
          <Typography.Text type={assertionSummary.err > 0 ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
            {assertionSummary.err > 0 ? `${assertionSummary.err} 条异常` : assertionSummary.warn > 0 ? `${assertionSummary.warn} 条观察` : '全部正常'}
          </Typography.Text>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>调度失败（24 小时）</Typography.Text>
          <div style={{ fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>
            {body === null ? '—' : body.schedules.reduce((s, x) => s + x.fails24h, 0)}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {body === null ? '' : `${body.schedules.filter((s) => s.enabled).length} 条排班启用中`}
          </Typography.Text>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>对账超容差（近 7 天）</Typography.Text>
          <div style={{ fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>{recon === null ? '—' : recon.overTol}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {recon === null ? '' : `差异合计 ${money(recon.overTolDiffSum)}`}
          </Typography.Text>
        </Card>
        <Card size="small">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>湖 · 小时文件</Typography.Text>
          <div style={{ fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>{body?.lake.hourFiles ?? '—'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最老 {body?.lake.hourOldest ?? '—'}
          </Typography.Text>
        </Card>
      </div>

      {/* ── 调度 ── */}
      <Card size="small" title="调度档位" style={{ marginBottom: 12 }}>
        <Table<ScheduleRow>
          size="small" rowKey="key" pagination={false} dataSource={body?.schedules ?? []} loading={body === null && loading}
          columns={[
            { title: '任务', dataIndex: 'key', width: 260, render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
            { title: '周期（UTC）', dataIndex: 'cron', width: 150, render: (v: string) => <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{v}</span> },
            { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => (v ? '是' : <Typography.Text type="secondary">否</Typography.Text>) },
            {
              title: '最近一次', width: 190,
              render: (_: unknown, r: ScheduleRow) => (r.lastRun === null ? <Typography.Text type="secondary">从未运行</Typography.Text> : (
                <Space size={6}>
                  <StatusTag s={r.lastRun.status} />
                  <span style={{ fontSize: 12 }}>{dur(r.lastRun.durationMs)}</span>
                </Space>
              )),
            },
            { title: '最近时间', width: 170, render: (_: unknown, r: ScheduleRow) => <span style={{ fontSize: 12 }}>{dt(r.lastRun?.at)}</span> },
            { title: '下次', width: 170, render: (_: unknown, r: ScheduleRow) => <span style={{ fontSize: 12 }}>{dt(r.nextRunAt)}</span> },
            {
              title: '24h 失败', dataIndex: 'fails24h', width: 90,
              render: (v: number) => (v > 0 ? <Tag color="error">{v}</Tag> : <span style={{ color: '#8c8c8c' }}>0</span>),
            },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只读展示。失败原因可在「最近一次」的工具提示里看到。
        </Typography.Text>
      </Card>

      {/* ── 体检 ── */}
      <Card size="small" title="体检清单（每 5 分钟）" style={{ marginBottom: 12 }}>
        <Table<AssertionRow>
          size="small" rowKey="check" pagination={false} dataSource={body?.assertions.rows ?? []} loading={body === null && loading}
          columns={[
            { title: '状态', width: 88, render: (_: unknown, r: AssertionRow) => <StatusTag s={r.verdict} /> },
            { title: '检查项', dataIndex: 'check', width: 200, render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
            { title: '结果', dataIndex: 'detail', render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span> },
            { title: '组', dataIndex: 'group', width: 60, render: (v: string) => <Tag>{v}</Tag> },
          ]}
        />
      </Card>

      {/* ── 湖 ── */}
      <Card size="small" title="湖卫生" style={{ marginBottom: 12 }}>
        {body?.lake.error !== undefined ? <Alert type="warning" showIcon message={`湖查询失败：${body.lake.error}`} /> : (
          <Descriptions size="small" column={3}>
            <Descriptions.Item label="小时文件">{body?.lake.hourFiles ?? '—'} 个（最老 {body?.lake.hourOldest ?? '—'}）</Descriptions.Item>
            <Descriptions.Item label="日文件">{body?.lake.dayFiles ?? '—'} 个（最新 {body?.lake.dayNewest ?? '—'}）</Descriptions.Item>
            <Descriptions.Item label="月文件">{body?.lake.monthFiles ?? '—'} 个（索引 {body?.lake.monthIndexMax ?? '—'}）</Descriptions.Item>
            <Descriptions.Item label="封版水位">{body?.lake.sealedMax ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="口径" span={2}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                小时文件是当天临时数据，越少越快；日文件是定稿正本；月文件是合并后的大文件。
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      {/* ── 物化 ── */}
      <Card size="small" title="物化水位（每张表最近一次建成）" style={{ marginBottom: 12 }}>
        <Table
          size="small" rowKey="relation" pagination={{ pageSize: 8, hideOnSinglePage: true }}
          dataSource={body?.materialization ?? []}
          columns={[
            { title: '表', dataIndex: 'relation', render: (v: string) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
            { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <StatusTag s={v} /> },
            { title: '数据到', dataIndex: 'maxBizday', width: 120 },
            { title: '建成时间', dataIndex: 'materializedAt', width: 190, render: (v: string) => <span style={{ fontSize: 12 }}>{dt(v)}</span> },
          ]}
        />
      </Card>

      {/* ── 对账 ── */}
      <Card size="small" title="对账差异（近 7 天，点门店看明细）" style={{ marginBottom: 12 }}>
        {recon === null ? (
          <Alert
            type="info" showIcon
            message="对账数据暂不可读"
            description={'error' in (body?.recon ?? {}) ? String((body?.recon as { error: string }).error) : '正在加载'}
          />
        ) : (
          <>
            <Space size={24} style={{ marginBottom: 10, flexWrap: 'wrap' }}>
              <span>店日总数 <b>{recon.storeDays}</b></span>
              <span>超容差 <b style={{ color: recon.overTol > 0 ? '#cf1322' : undefined }}>{recon.overTol}</b></span>
              <span>差异合计 <b>{money(recon.overTolDiffSum)}</b></span>
              <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                归因：{recon.byAttribution.length === 0 ? '无' : recon.byAttribution.map((a) => `${a.attribution} ${a.n}`).join('，')}
              </span>
            </Space>
            {recon.topBranches.length === 0 ? <Empty description="近 7 天没有超容差的店日" /> : (
              <Table<ReconBranch>
                size="small" rowKey={(r) => `${r.systemBook}|${r.bizday}|${r.branchNum}`}
                pagination={false} dataSource={recon.topBranches}
                onRow={(r) => ({ onClick: () => void openBranch(r), style: { cursor: 'pointer' } })}
                columns={[
                  { title: '账套', dataIndex: 'systemBook', width: 90 },
                  { title: '日期', dataIndex: 'bizday', width: 110 },
                  { title: '门店', dataIndex: 'branchNum', width: 80 },
                  { title: '差异', dataIndex: 'diff', width: 120, render: (v: number) => <b>{money(v)}</b> },
                  { title: '抵扣额上界', dataIndex: 'swapOffset', width: 120, render: (v: number) => money(v) },
                  { title: '归因', dataIndex: 'attribution', render: (v: string | null) => (v === null ? <Typography.Text type="secondary">未归因</Typography.Text> : <Tag>{v}</Tag>) },
                ]}
              />
            )}
          </>
        )}
      </Card>

      <Drawer
        open={drawer !== null} onClose={() => setDrawer(null)} width={860}
        title={drawer === null ? '' : `账套 ${drawer.row.systemBook} · ${drawer.row.bizday} · 门店 ${drawer.row.branchNum}（共 ${drawer.total} 行）`}
      >
        {drawerBusy ? <Typography.Text type="secondary">加载中…</Typography.Text> : (
          <Table<ReconDetailRow>
            size="small" rowKey={(r, i) => `${r.control ?? ''}|${i ?? 0}`} pagination={{ pageSize: 50, hideOnSinglePage: true }}
            dataSource={drawer?.rows ?? []}
            columns={[
              { title: '控制项', dataIndex: 'control', width: 130, render: (v: string | null) => <Typography.Text code style={{ fontSize: 12 }}>{v ?? '—'}</Typography.Text> },
              { title: '平台值', dataIndex: 'platform_value', width: 110 },
              { title: '源值', dataIndex: 'source_value', width: 110 },
              { title: '差异', dataIndex: 'diff', width: 100, render: (v: string | null) => (v === null ? '—' : <b>{money(v)}</b>) },
              { title: '容差', dataIndex: 'tol_applied', width: 90 },
              { title: '缺侧', dataIndex: 'missing_side', width: 80 },
              { title: '归因', dataIndex: 'attribution', width: 150, render: (v: string | null) => (v === null ? '—' : <Tag>{v}</Tag>) },
              { title: '处置', dataIndex: 'disposition', width: 120, render: (v: string | null) => v ?? '—' },
            ]}
          />
        )}
      </Drawer>
    </div>
  )
}
