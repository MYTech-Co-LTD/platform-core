// console/system-map/index.tsx — 体系地图·本体图（2026-11-13）。
//
// 取代原来的「新标签打开 /api/modules/data/system-map 单文件 HTML」入口：
// 同一套宿主壳、同一份 DESIGN.md token，图谱是页面主内容。
//
// 形状 = entities + relations（节点带类型，边带类型），参考 MCP knowledge graph 的读法：
//   点节点 → 右侧 observations（口径 / 来源 / 使用量 / 对账）；
//   悬停 → 只亮邻域（ECharts focus:'adjacency'）；图例 → 按类型显隐。
// 数据来自 GET /system-map/graph（与 HTML 页共用服务端模型与缓存，见 routes/system-map.ts）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Drawer, Empty, Input, Space, Tag, Typography } from 'antd'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer])

type NodeType = 'entity' | 'metric' | 'source' | 'dimension'
type EdgeType = 'belongs_to' | 'derives_from' | 'upstream_of' | 'has_dimension'

interface OntologyNode { id: string; type: NodeType; label: string; observations: string[] }
interface OntologyEdge { from: string; to: string; type: EdgeType }
interface Health {
  metricTotal: number
  entityBoundPct: number
  auditCoveredPct: number
  zeroUse: number
}
interface GraphResponse {
  generatedAt: string
  health: Health
  ontology: { nodes: OntologyNode[]; edges: OntologyEdge[] }
  warnings: string[]
}

type TrailStepKind = 'metric' | 'mart' | 'staging' | 'lake' | 'pipeline'
interface TrailStep { kind: TrailStepKind; label: string; detail?: string; from: 'declared' | 'inferred' }
interface MetricTrail {
  metricId: string
  title: string
  steps: TrailStep[]
  runtime: {
    pipelineId: string | null
    lastRun: { runId: string; at: string; status: string; durationMs?: number; error?: string } | null
    materializedAt: string | null
    maxBizday: string | null
  }
  notes: string[]
}
const STEP_LABEL: Record<TrailStepKind, string> = {
  metric: '指标', mart: '表', staging: 'staging', lake: '湖', pipeline: '管线',
}
const RUN_DOT: Record<string, string> = { ok: '#0FA958', failed: '#E5484D', running: '#4D6BFE', cancelled: '#C9CDD4', interrupted: '#E08A00', unknown: '#C9CDD4' }

const TYPE_LABEL: Record<NodeType, string> = { entity: '业务对象', metric: '指标', source: '源表', dimension: '维度' }
const TYPE_COLOR: Record<NodeType, string> = {
  entity: '#4D6BFE', metric: '#0FA958', source: '#E08A00', dimension: '#8B5CF6',
}
const TYPE_SIZE: Record<NodeType, number> = { entity: 34, metric: 15, source: 22, dimension: 18 }
const EDGE_LABEL: Record<EdgeType, string> = {
  belongs_to: '属于', derives_from: '算自', upstream_of: '上游', has_dimension: '维度',
}

/** 搜索命中：标签 / id / observations 里的任意一段（大小写不敏感）。 */
function matches(n: OntologyNode, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (needle === '') return true
  return n.label.toLowerCase().includes(needle)
    || n.id.toLowerCase().includes(needle)
    || n.observations.some((o) => o.toLowerCase().includes(needle))
}

export default function SystemMapPage() {
  const [data, setData] = useState<GraphResponse | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<OntologyNode | null>(null)
  const [trail, setTrail] = useState<MetricTrail | null>(null)
  const [trailError, setTrailError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  // 指标节点：打开抽屉时现查链路（结构 + 运行态；运行态不进图缓存的 10 分钟）
  useEffect(() => {
    setTrail(null)
    setTrailError(null)
    if (selected === null || selected.type !== 'metric') return
    const id = selected.id.startsWith('metric:') ? selected.id.slice('metric:'.length) : selected.id
    let alive = true
    apiGet(`/system-map/metrics/${encodeURIComponent(id)}/trail`)
      .then((r) => {
        const t = (r as { trail?: MetricTrail }).trail
        if (alive) setTrail(t ?? null)
      })
      .catch((e: unknown) => { if (alive) setTrailError(humanError(e).text) })
    return () => { alive = false }
  }, [selected])

  const load = useCallback(() => {
    setError(null)
    apiGet('/system-map/graph')
      .then((r) => setData(r as GraphResponse))
      .catch((e: unknown) => setError(humanError(e)))
  }, [])
  useEffect(load, [load])

  // 图数据：搜索非空时只留命中节点 + 一跳邻居（图谱的可读性靠聚焦，不靠缩小字号）。
  const view = useMemo(() => {
    if (data === null) return null
    const all = data.ontology
    if (query.trim() === '') return { nodes: all.nodes, edges: all.edges }
    const keep = new Set(all.nodes.filter((n) => matches(n, query)).map((n) => n.id))
    for (const e of all.edges) {
      if (keep.has(e.from)) keep.add(e.to)
      if (keep.has(e.to)) keep.add(e.from)
    }
    return {
      nodes: all.nodes.filter((n) => keep.has(n.id)),
      edges: all.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    }
  }, [data, query])

  useEffect(() => {
    if (boxRef.current === null) return
    const chart = chartRef.current ?? echarts.init(boxRef.current)
    chartRef.current = chart
    chart.off('click')
    chart.on('click', (params) => {
      const p = params as { dataType?: string; data?: { id?: string } }
      if (p.dataType !== 'node' || p.data?.id === undefined) return
      const node = data?.ontology.nodes.find((n) => n.id === p.data?.id)
      if (node !== undefined) setSelected(node)
    })
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [data])

  useEffect(() => {
    const chart = chartRef.current
    if (chart === null || view === null) return
    const categories = (Object.keys(TYPE_LABEL) as NodeType[]).map((t) => TYPE_LABEL[t])
    chart.setOption({
      tooltip: {
        confine: true,
        formatter: (raw: unknown) => {
          const p = raw as { dataType?: string; data?: { name?: string; typeLabel?: string; edgeLabel?: string } }
          if (p.dataType === 'edge') return `${p.data?.edgeLabel ?? ''}`
          return `${p.data?.name ?? ''}${p.data?.typeLabel === undefined ? '' : ` · ${p.data.typeLabel}`}`
        },
      },
      legend: [{
        data: categories, top: 0, left: 0, itemWidth: 8, itemHeight: 8, icon: 'circle',
        textStyle: { fontSize: 12, color: '#6B7280' },
      }],
      series: [{
        type: 'graph',
        layout: 'force',
        roam: true,
        // 布局盒留边：不留的话力导向会把节点推到画布边缘被裁掉，图例也会压住左上角的节点
        left: 24, right: 24, top: 44, bottom: 24,
        draggable: true,
        // 悬停只亮邻域：90 个节点的图不这样压，看到的就是一团线。
        focus: 'adjacency',
        force: { repulsion: 200, edgeLength: [60, 130], gravity: 0.12, layoutAnimation: true },
        // 标签放节点右侧：默认的 inside 会把「fct_xxx」压在圆点上，糊成一团
        label: { show: false, position: 'right', distance: 4, fontSize: 11, color: '#4B5563' },
        emphasis: { focus: 'adjacency', label: { show: true }, lineStyle: { width: 2 } },
        lineStyle: { color: '#D5D8DE', width: 1, curveness: 0.08, opacity: 0.9 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 5,
        edgeLabel: { show: false },
        categories: categories.map((name, i) => ({
          name,
          itemStyle: { color: TYPE_COLOR[(Object.keys(TYPE_LABEL) as NodeType[])[i]!] },
        })),
        data: view.nodes.map((n) => ({
          id: n.id,
          name: n.label,
          category: (Object.keys(TYPE_LABEL) as NodeType[]).indexOf(n.type),
          typeLabel: TYPE_LABEL[n.type],
          symbolSize: TYPE_SIZE[n.type],
          // 指标节点太多，默认不挂标签；搜索出来的节点强制显示（否则搜了也看不出是哪一个）。
          // 维度标签靠左：它的名字最长（「商品（部门 → 品类 → 单品）」），靠右会在画布右缘被切掉
          label: { show: n.type !== 'metric' || query.trim() !== '', ...(n.type === 'dimension' ? { position: 'left' } : {}) },
          itemStyle: { color: TYPE_COLOR[n.type], borderColor: '#FFFFFF', borderWidth: 2 },
        })),
        edges: view.edges.map((e) => ({ source: e.from, target: e.to, edgeLabel: EDGE_LABEL[e.type] })),
      }],
    }, true)
  }, [view, query])

  const relationCount = useMemo(() => {
    if (selected === null || data === null) return 0
    return data.ontology.edges.filter((e) => e.from === selected.id || e.to === selected.id).length
  }, [selected, data])

  if (error !== null) {
    return (
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert type="error" showIcon message={error.text}
               description={error.detail ?? error.code}
               action={<Button size="small" onClick={load}>重试</Button>} />
      </Space>
    )
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* 关键数字条：先给「体系多大」，再给图 */}
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-end', padding: '4px 2px 8px' }}>
        {data === null ? null : [
          { k: '指标', v: data.health.metricTotal, d: '平台口径 + 本租户派生' },
          { k: '实体绑定', v: `${data.health.entityBoundPct}%`, d: '指标挂到业务对象的比例' },
          { k: '对账覆盖', v: `${data.health.auditCoveredPct}%`, d: '有独立复算文件' },
          { k: '零使用', v: data.health.zeroUse, d: '近 30 天未被查询' },
        ].map((x) => (
          <div key={x.k} style={{ minWidth: 110 }}>
            <div style={{ fontSize: 12, color: '#9AA0A6' }}>{x.k}</div>
            <div style={{
              fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums', color: '#1B1C1E',
            }}>{x.v}</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{x.d}</div>
          </div>
        ))}
      </div>

      <Card styles={{ body: { padding: 12 } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 4px 8px' }}>
          <Input
            allowClear
            placeholder="搜指标、业务对象或源表"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data === null ? '' : `${view?.nodes.length ?? 0} 个节点 · ${view?.edges.length ?? 0} 条关系`}
          </Typography.Text>
          <span style={{ flex: 1 }} />
          {data !== null && data.warnings.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data.warnings.length} 条生成告警
            </Typography.Text>
          )}
        </div>
        {data !== null && view !== null && view.nodes.length === 0 ? (
          <Empty description="没有匹配的节点，换个关键词试试" style={{ padding: '80px 0' }} />
        ) : (
          <div ref={boxRef} style={{ width: '100%', height: 'calc(100vh - 330px)', minHeight: 460 }} />
        )}
      </Card>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        width={420}
        title={selected === null ? null : (
          <Space size={8}>
            <span>{selected.label}</span>
            <Tag color={TYPE_COLOR[selected.type]} style={{ borderRadius: 999 }}>{TYPE_LABEL[selected.type]}</Tag>
          </Space>
        )}
      >
        {selected !== null && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                {selected.id}
              </Typography.Text>
            </div>
            <div>
              {selected.observations.map((o) => (
                <div key={o} style={{ fontSize: 13, color: '#1B1C1E', lineHeight: 2 }}>{o}</div>
              ))}
            </div>
            {selected.type === 'metric' && (
              <div>
                <div style={{ fontSize: 12, color: '#9AA0A6', marginBottom: 6 }}>链路</div>
                {trailError !== null && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{trailError}</Typography.Text>
                )}
                {trailError === null && trail === null && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>读取中…</Typography.Text>
                )}
                {trail !== null && (
                  <div>
                    {trail.steps.map((st, i) => (
                      <div key={`${st.kind}:${st.label}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
                        <span style={{
                          fontSize: 11, color: '#9AA0A6', width: 44, flex: 'none',
                          paddingLeft: i === 0 ? 0 : 8, borderLeft: i === 0 ? 'none' : '1px solid #EBEDF0',
                        }}>{STEP_LABEL[st.kind]}</span>
                        <span style={{ fontSize: 13, color: '#1B1C1E' }}>{st.label}</span>
                        {st.from === 'inferred' && <Tag style={{ borderRadius: 999, fontSize: 11 }}>推断</Tag>}
                        {st.detail !== undefined && (
                          <span style={{ fontSize: 11.5, color: '#9AA0A6' }}>{st.detail}</span>
                        )}
                      </div>
                    ))}
                    <div style={{ marginTop: 10, fontSize: 12, color: '#6B7280', lineHeight: 1.9 }}>
                      <div>
                        最近一次运行：{trail.runtime.lastRun === null
                          ? (trail.notes.some((n) => n.includes('DATA_RUN_DIRS')) ? '未接入运行记录' : '没有记录')
                          : (
                            <span>
                              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 6, marginRight: 6,
                                background: RUN_DOT[trail.runtime.lastRun.status] ?? '#C9CDD4' }} />
                              {trail.runtime.lastRun.status} · {new Date(trail.runtime.lastRun.at).toLocaleString('zh-CN')}
                              {trail.runtime.lastRun.durationMs === undefined ? '' : ` · ${Math.round(trail.runtime.lastRun.durationMs / 1000)}s`}
                            </span>
                          )}
                      </div>
                      <div>物化钟：{trail.runtime.materializedAt === null ? '未知' : new Date(trail.runtime.materializedAt).toLocaleString('zh-CN')}</div>
                      <div>数据水位：{trail.runtime.maxBizday ?? '未知'}</div>
                      {trail.notes.map((n) => <div key={n} style={{ color: '#9AA0A6' }}>{n}</div>)}
                    </div>
                  </div>
                )}
              </div>
            )}
            {selected.type === 'metric' && (
              <Button size="small" href={`/console/data/metrics`}>去指标页看变更历史</Button>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              关联 {relationCount} 条关系
            </Typography.Text>
          </Space>
        )}
      </Drawer>
    </Space>
  )
}
