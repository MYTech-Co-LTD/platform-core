// console/RealtimeStats.tsx — 运营实时统计页（件④ / #2756，计划 D3）。
//
// 单一源、当前态：走 `POST /stats` 的声明式聚合（白名单字段/聚合 + `asOf`），与「湖 → 摊平 →
// mart/L1」的分析通道分家——本页不接报表引擎。
//
// 交互（计划 D3）：选表单（**只列 `dataPlane.stats.enabled` 的已发布表单**）→ 先列 `stats.views`
// 具名卡片（agent 起草时已产出，点开即渲染）→ 高级模式再按契约字段选维度/度量/日期范围。
// 纪律：**不提供任意字段输入**——维度/度量选项全部来自契约 `dataPlane.fields`；「合计」行用
// 同过滤条件下的无分组查询取得（avg 不能由各组合计平均反推，故不在前端累加）。
// 移动端：Card 包表、控件 flex-wrap、表格 `scroll.x = max-content`。
import { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Col, Collapse, DatePicker, Empty, Row, Select, Spin, Table, Tag, Typography,
} from 'antd'
import { ApiError, apiGet, getDefDetail, runStats, statsContractOf } from './api'
import type { DefSummary, FieldDecl, StatsContract, StatsFilter, StatsMeasure, StatsQuery, StatsViewDecl } from './api'

const AGG_LABEL: Record<string, string> = {
  sum: '求和', avg: '平均', count: '计数', min: '最小', max: '最大',
}

interface FormEntry {
  assetId: string
  contract: StatsContract
}

interface StatsRow extends Record<string, unknown> {
  __key: string
  __total?: boolean
}

interface RunView {
  title: string
  groupBy: string[]
  measures: StatsMeasure[]
  rows: Array<Record<string, unknown>>
  totalRow: Record<string, unknown> | null
  asOf: string
  truncated: boolean
}

interface Exec {
  query: StatsQuery
  groupBy: string[]
  measures: StatsMeasure[]
  /** 合计查询的过滤条件（具名视图要把视图自带 filter 一并带上）。 */
  totalFilter: StatsFilter | undefined
  title: string
}

/** `asOf` → 北京时间 `HH:mm:ss`（`实时（截至 …）` 文案用；非法值原样返回）。 */
export function formatAsOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(d)
}

/** 度量 → 行对象键（与服务端 `measureSql` 的别名同构）。 */
function measureKeyOf(m: StatsMeasure): string {
  return m.field === '*' ? 'count' : `${m.agg}_${m.field}`
}

function parseMeasureKey(key: string): StatsMeasure | null {
  if (key === 'count:*') return { field: '*', agg: 'count' }
  const i = key.indexOf(':')
  if (i <= 0) return null
  const agg = key.slice(0, i)
  const field = key.slice(i + 1)
  if (!(agg in AGG_LABEL) || field.length === 0) return null
  return { field, agg: agg as StatsMeasure['agg'] }
}

function measureOptionsOf(fields: FieldDecl[], titles: Record<string, string>): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [{ value: 'count:*', label: '记录数' }]
  for (const f of fields) {
    for (const agg of f.agg ?? []) {
      out.push({
        value: `${agg}:${f.field}`,
        label: `${AGG_LABEL[agg] ?? agg} · ${titles[f.field] ?? f.field}`,
      })
    }
  }
  return out
}

function describeView(view: StatsViewDecl, titles: Record<string, string>): string {
  const dims = view.groupBy ?? []
  const dimsText = dims.length === 0
    ? '不分组（合计）'
    : `按${dims.map((d) => titles[d] ?? d).join('、')}分组`
  const measuresText = view.measures
    .map((m) => (m.field === '*' ? '记录数' : `${AGG_LABEL[m.agg] ?? m.agg}${titles[m.field] ?? m.field}`))
    .join('、')
  return `${dimsText} · ${measuresText}`
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v)
}

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail === undefined ? e.code : `${e.code}：${e.detail}`
  return e instanceof Error ? e.message : String(e)
}

export default function RealtimeStats() {
  const [forms, setForms] = useState<FormEntry[]>([])
  const [loadingForms, setLoadingForms] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [assetId, setAssetId] = useState<string | null>(null)

  const [dims, setDims] = useState<string[]>([])
  const [measureKeys, setMeasureKeys] = useState<string[]>([])
  const [range, setRange] = useState<[string, string] | null>(null)

  const [run, setRun] = useState<RunView | null>(null)
  const [lastExec, setLastExec] = useState<Exec | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  // 表单清单：`/defs` 只有摘要，逐个取 head body 判 `stats.enabled`（只统计已发布 head）。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const body = await apiGet<{ defs: DefSummary[] }>('/api/modules/forms/defs')
        const entries: FormEntry[] = []
        for (const d of body.defs.filter((x) => x.headVersion !== null)) {
          try {
            const contract = statsContractOf(await getDefDetail(d.assetId))
            if (contract !== null && contract.enabled) entries.push({ assetId: d.assetId, contract })
          } catch {
            // 单张表单读不到不拖垮整页（API 面另有门卫）
          }
        }
        if (cancelled) return
        setForms(entries)
        setAssetId(entries[0]?.assetId ?? null)
      } catch (e) {
        if (!cancelled) setLoadError(errText(e))
      } finally {
        if (!cancelled) setLoadingForms(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 换表单：清掉上一次结果与高级模式选择（避免把 A 的字段用法带到 B）。
  useEffect(() => {
    setRun(null)
    setLastExec(null)
    setRunError(null)
    setDims([])
    setMeasureKeys([])
  }, [assetId])

  const entry = forms.find((f) => f.assetId === assetId) ?? null
  const labelOf = (field: string): string => entry?.contract.titles[field] ?? field

  const groupOptions = entry === null
    ? []
    : entry.contract.fields
      .filter((f) => f.groupable === true)
      .map((f) => ({ value: f.field, label: labelOf(f.field) }))
  const measureOptions = entry === null ? [] : measureOptionsOf(entry.contract.fields, entry.contract.titles)

  const dateWindow = (): StatsFilter | undefined =>
    range === null ? undefined : { submittedFrom: range[0], submittedTo: range[1] }

  const execute = async (exec: Exec): Promise<void> => {
    setRunning(true)
    setRunError(null)
    try {
      const first = await runStats(exec.query)
      let totalRow: Record<string, unknown> | null = null
      if (exec.groupBy.length > 0) {
        const totalQuery: StatsQuery = {
          assetId: exec.query.assetId,
          groupBy: [],
          measures: exec.measures,
          ...(exec.totalFilter !== undefined && Object.keys(exec.totalFilter).length > 0
            ? { filter: exec.totalFilter }
            : {}),
        }
        const total = await runStats(totalQuery)
        totalRow = total.rows[0] ?? null
      } else {
        totalRow = first.rows[0] ?? null // 单行本身就是合计
      }
      setRun({
        title: exec.title,
        groupBy: exec.groupBy,
        measures: exec.measures,
        rows: first.rows,
        totalRow,
        asOf: first.asOf,
        // 截断只取分组查询的判定：合计查询恒为单行，其 truncated 无意义
        truncated: first.truncated,
      })
      setLastExec(exec)
    } catch (e) {
      setRunError(errText(e))
    } finally {
      setRunning(false)
    }
  }

  const runNamed = (view: StatsViewDecl): void => {
    if (entry === null) return
    const date = dateWindow()
    const queryFilter: StatsFilter = { ...(view.filter ?? {}), ...(date ?? {}) }
    const totalFilter: StatsFilter = { ...(view.filter ?? {}), ...(date ?? {}) }
    const query: StatsQuery = {
      assetId: entry.assetId,
      viewId: view.key,
      ...(Object.keys(queryFilter).length > 0 ? { filter: queryFilter } : {}),
    }
    void execute({ query, groupBy: view.groupBy ?? [], measures: view.measures, totalFilter, title: view.label })
  }

  const runCustom = (): void => {
    if (entry === null) return
    const measures = measureKeys
      .map(parseMeasureKey)
      .filter((m): m is StatsMeasure => m !== null)
    if (measures.length === 0) {
      setRunError('至少选一个度量')
      return
    }
    const date = dateWindow()
    const dimsChosen = dims
    const query: StatsQuery = {
      assetId: entry.assetId,
      ...(dimsChosen.length > 0 ? { groupBy: dimsChosen } : {}),
      measures,
      limit: 100,
      ...(date !== undefined ? { filter: date } : {}),
    }
    void execute({ query, groupBy: dimsChosen, measures, totalFilter: date, title: '自定义查询' })
  }

  if (loadingForms) {
    return (
      <Card size="small">
        <Spin /> <Typography.Text type="secondary" style={{ marginLeft: 8 }}>正在加载可统计的表单…</Typography.Text>
      </Card>
    )
  }

  if (loadError !== null) {
    return <Alert type="error" showIcon message={loadError} />
  }

  // 空态一：没有任何开启实时统计的表单（给下一步，不是「暂无数据」）
  if (forms.length === 0) {
    return (
      <Card size="small">
        <Empty description="还没有开启实时统计的表单。在表单契约里开启 dataPlane.stats.enabled 并发布后，这里会出现。" />
      </Card>
    )
  }

  const columns = entry === null || run === null
    ? []
    : [
      ...run.groupBy.map((f) => ({
        title: labelOf(f),
        dataIndex: f,
        key: f,
        render: (v: unknown) => formatCell(v),
      })),
      ...run.measures.map((m) => ({
        title: m.field === '*' ? '记录数' : `${AGG_LABEL[m.agg] ?? m.agg} · ${labelOf(m.field)}`,
        dataIndex: measureKeyOf(m),
        key: measureKeyOf(m),
        align: 'right' as const,
        render: (v: unknown) => formatCell(v),
      })),
    ]

  const dataSource: StatsRow[] = run === null
    ? []
    : run.rows.map((row, i) => ({ ...row, __key: `r${i}` }))
  if (run !== null && run.groupBy.length > 0 && run.totalRow !== null) {
    const total: StatsRow = { ...run.totalRow, __key: 'total', __total: true }
    total[run.groupBy[0]] = '合计'
    dataSource.push(total)
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 8 }}>
        <Select
          id="stats-form-select"
          showSearch
          placeholder="选择表单"
          style={{ minWidth: 220 }}
          value={assetId ?? undefined}
          options={forms.map((f) => ({ value: f.assetId, label: `${f.contract.title}（${f.assetId}）` }))}
          onChange={(v: string) => setAssetId(v)}
        />
        {run !== null && <Tag color="processing">实时（截至 {formatAsOf(run.asOf)}）</Tag>}
        {run !== null && (
          <Button size="small" loading={running} onClick={() => { if (lastExec !== null) void execute(lastExec) }}>
            刷新
          </Button>
        )}
      </div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        只统计已发布表单的提交（当前态、单一源）。先选表单，再点统计视图，或用高级模式自定义。
      </Typography.Paragraph>

      {runError !== null && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={runError} />}

      {entry !== null && entry.contract.views.length > 0 && (
        <Card size="small" title="统计视图" style={{ marginBottom: 12 }}>
          <Row gutter={[12, 12]}>
            {entry.contract.views.map((v) => (
              <Col key={v.key} xs={24} sm={12} lg={8}>
                <Card
                  size="small"
                  hoverable
                  onClick={() => runNamed(v)}
                  style={run?.title === v.label ? { borderColor: '#1677ff' } : undefined}
                >
                  <Typography.Text strong>{v.label}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {describeView(v, entry.contract.titles)}
                    </Typography.Text>
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}

      <Collapse
        size="small"
        style={{ marginBottom: 12 }}
        items={[{
          key: 'advanced',
          label: '高级模式（自定义维度 / 度量 / 日期范围）',
          children: (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ display: 'grid', gap: 4, minWidth: 220, flex: '1 1 220px' }}>
                <Typography.Text type="secondary">维度（最多 3 个，不选 = 合计）</Typography.Text>
                <Select
                  id="stats-groupby"
                  mode="multiple"
                  maxCount={3}
                  allowClear
                  placeholder="按契约声明的可分组字段"
                  value={dims}
                  onChange={(v: string[]) => setDims(v)}
                  options={groupOptions}
                />
              </div>
              <div style={{ display: 'grid', gap: 4, minWidth: 220, flex: '1 1 220px' }}>
                <Typography.Text type="secondary">度量（最多 5 个）</Typography.Text>
                <Select
                  id="stats-measures"
                  mode="multiple"
                  maxCount={5}
                  allowClear
                  placeholder="选字段与聚合"
                  value={measureKeys}
                  onChange={(v: string[]) => setMeasureKeys(v)}
                  options={measureOptions}
                />
              </div>
              <div style={{ display: 'grid', gap: 4, minWidth: 240, flex: '1 1 240px' }}>
                <Typography.Text type="secondary">提交日期（含当日）</Typography.Text>
                <DatePicker.RangePicker
                  allowClear
                  style={{ width: '100%' }}
                  onChange={(_, strings) => {
                    setRange(strings[0] !== '' && strings[1] !== '' ? [strings[0], strings[1]] : null)
                  }}
                />
              </div>
              <Button
                type="primary"
                loading={running}
                disabled={entry === null || measureKeys.length === 0}
                onClick={runCustom}
              >
                查询
              </Button>
            </div>
          ),
        }]}
      />

      <Card
        size="small"
        title={run === null ? '统计结果' : `${run.title} · 共 ${run.rows.length} 行`}
      >
        {run !== null && run.truncated && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="结果已按上限截断（最多 500 组），请加筛选缩小范围。"
          />
        )}
        <Table<StatsRow>
          rowKey="__key"
          size="small"
          loading={running}
          dataSource={dataSource}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={columns}
          onRow={(row) => (row.__total === true ? { style: { fontWeight: 600, background: '#FAFBFC' } } : {})}
          locale={{
            emptyText: (
              <Empty
                description={run === null
                  ? '选择上方的统计视图，或用高级模式查询'
                  : '当前条件下没有提交记录。换个日期范围或维度试试。'}
              />
            ),
          }}
        />
      </Card>
    </div>
  )
}
