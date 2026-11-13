// console/pipelines/index.tsx — 管线地图（2026-11-14）。
//
// 视角与体系地图相反：那边从「指标」出发看它算自哪张表；这边从「管线」出发看
// 整个域里 资产（湖前缀）→ staging → marts 三层是否接通，哪条链断了、最近跑没跑。
//
// 为什么是固定三层而不是力导向：用户在问「逻辑关系」，分层 DAG 一眼能读完；
// 119 条管线不占独立列，挂在资产节点上（点资产看清单），否则一动就是毛球。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Drawer, Empty, Input, Segmented, Space, Tag, Typography } from 'antd'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer])

interface MapPipeline { id: string; account: string | null; cron: string | null; enabled: boolean }
interface MapAsset { lake: string; staging: string | null; marts: string[]; pipelines: MapPipeline[] }
interface PipelinesResponse {
  generatedAt: string
  runsWired: boolean
  assets: MapAsset[]
  orphanStaging: string[]
  warnings: string[]
  lastRun: Record<string, { status: string; at: string } | null>
}

type NodeKind = 'asset' | 'staging' | 'mart'
const KIND_LABEL: Record<NodeKind, string> = { asset: '资产（湖）', staging: 'staging', mart: 'marts' }
const KIND_COLOR: Record<NodeKind, string> = { asset: '#E08A00', staging: '#0FA958', mart: '#4D6BFE' }
const RUN_DOT: Record<string, string> = { ok: '#0FA958', failed: '#E5484D', running: '#4D6BFE', cancelled: '#C9CDD4', interrupted: '#E08A00', unknown: '#C9CDD4' }
const COL_X: Record<NodeKind, number> = { asset: 0, staging: 430, mart: 860 }
const ROW_H = 24

interface Selection { kind: NodeKind; label: string }

export default function PipelinesPage() {
  const [data, setData] = useState<PipelinesResponse | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState<string>('全部')
  const [selected, setSelected] = useState<Selection | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  const load = useCallback(() => {
    setError(null)
    apiGet('/system-map/pipelines')
      .then((r) => setData(r as PipelinesResponse))
      .catch((e: unknown) => setError(humanError(e)))
  }, [])
  useEffect(load, [load])

  // 账套过滤：只保留该账套有管线的资产（共享管线算所有账套的候选，但不算 3120/64188 专属）
  const assets = useMemo(() => {
    if (data === null) return []
    if (account === '全部') return data.assets
    if (account === '共享') return data.assets.filter((a) => a.pipelines.some((p) => p.account === null))
    return data.assets.filter((a) => a.pipelines.some((p) => p.account === account))
  }, [data, account])

  const view = useMemo(() => {
    if (data === null) return { nodes: [], edges: [] as Array<{ source: string; target: string }> }
    // 三层固定位置：资产 / staging（被这些资产引用）/ marts（这些 staging 的下游）
    const assetsShown = assets
    const stagings = [...new Set(assetsShown.map((a) => a.staging).filter((s): s is string => s !== null))]
    const martSet = new Set<string>()
    for (const a of assetsShown) for (const m of a.marts) martSet.add(m)
    const marts = [...martSet].sort((a, b) => a.localeCompare(b))

    const nodes = [
      ...assetsShown.map((a, i) => ({ id: `asset:${a.lake}`, kind: 'asset' as const, label: a.lake, x: COL_X.asset, y: i * ROW_H })),
      ...stagings.map((s, i) => ({ id: `staging:${s}`, kind: 'staging' as const, label: s, x: COL_X.staging, y: i * ROW_H })),
      ...marts.map((m, i) => ({ id: `mart:${m}`, kind: 'mart' as const, label: m, x: COL_X.mart, y: i * ROW_H })),
    ]
    const edges: Array<{ source: string; target: string }> = []
    for (const a of assetsShown) {
      if (a.staging !== null) edges.push({ source: `asset:${a.lake}`, target: `staging:${a.staging}` })
      for (const m of a.marts) edges.push({ source: `staging:${a.staging}`, target: `mart:${m}` })
    }
    return { nodes, edges }
  }, [assets, data])

  // 搜索：命中节点 + 一跳邻居
  const focused = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return view
    const keep = new Set(view.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id))
    for (const e of view.edges) {
      if (keep.has(e.source)) keep.add(e.target)
      if (keep.has(e.target)) keep.add(e.source)
    }
    return {
      nodes: view.nodes.filter((n) => keep.has(n.id)),
      edges: view.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    }
  }, [view, query])

  useEffect(() => {
    if (boxRef.current === null) return
    const chart = chartRef.current ?? echarts.init(boxRef.current)
    chartRef.current = chart
    chart.off('click')
    chart.on('click', (params) => {
      const p = params as { dataType?: string; data?: { id?: string; name?: string; kind?: NodeKind } }
      if (p.dataType !== 'node' || p.data?.name === undefined || p.data.kind === undefined) return
      setSelected({ kind: p.data.kind, label: p.data.name })
    })
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    chart.setOption({
      tooltip: {
        confine: true,
        formatter: (raw: unknown) => {
          const p = raw as { dataType?: string; data?: { name?: string; kind?: NodeKind } }
          if (p.dataType === 'node') return `${p.data?.name ?? ''}`
          return ''
        },
      },
      legend: [{
        data: [KIND_LABEL.asset, KIND_LABEL.staging, KIND_LABEL.mart], top: 0, left: 0,
        itemWidth: 8, itemHeight: 8, icon: 'circle', textStyle: { fontSize: 12, color: '#6B7280' },
      }],
      series: [{
        type: 'graph',
        layout: 'none',
        roam: true,
        focus: 'adjacency',
        left: 16, right: 16, top: 36, bottom: 16,
        label: { show: true, fontSize: 10.5, color: '#4B5563' },
        emphasis: { focus: 'adjacency', label: { fontSize: 12, color: '#1B1C1E' }, lineStyle: { width: 2 } },
        lineStyle: { color: '#D5D8DE', width: 1, curveness: 0.1, opacity: 0.8 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 4,
        categories: (Object.keys(KIND_LABEL) as NodeKind[]).map((k) => ({ name: KIND_LABEL[k], itemStyle: { color: KIND_COLOR[k] } })),
        data: focused.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          name: n.label,
          category: (Object.keys(KIND_LABEL) as NodeKind[]).indexOf(n.kind),
          x: n.x,
          y: n.y,
          symbolSize: 7,
          // marts 在最后一列：标签放左边，否则会被右缘切掉
          label: { show: true, position: n.kind === 'mart' ? 'left' : 'right', distance: 4 },
          itemStyle: { color: KIND_COLOR[n.kind], borderColor: '#FFFFFF', borderWidth: 1 },
        })),
        edges: focused.edges,
      }],
    }, true)
  }, [focused])

  if (error !== null) {
    return (
      <Alert type="error" showIcon message={error.text} description={error.detail ?? error.code}
             action={<Button size="small" onClick={load}>重试</Button>} />
    )
  }

  const broken = data === null ? 0 : data.assets.filter((a) => a.staging === null).length
  const failed = data === null ? 0 : Object.values(data.lastRun).filter((r) => r?.status === 'failed').length

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-end', padding: '4px 2px 8px' }}>
        {data === null ? null : [
          { k: '资产', v: data.assets.length, d: '有管线写入的湖前缀' },
          { k: 'staging', v: new Set(data.assets.map((a) => a.staging).filter(Boolean)).size, d: '已接上 staging 的资产' },
          { k: '断点', v: broken, d: '有管线但没有 staging' },
          { k: '最近失败', v: failed, d: data.runsWired ? '最近一次 run = failed' : '运行记录未接入' },
        ].map((x) => (
          <div key={x.k} style={{ minWidth: 110 }}>
            <div style={{ fontSize: 12, color: '#9AA0A6' }}>{x.k}</div>
            <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: '#1B1C1E' }}>{x.v}</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{x.d}</div>
          </div>
        ))}
      </div>

      <Card styles={{ body: { padding: 12 } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 4px 8px', flexWrap: 'wrap' }}>
          <Input allowClear placeholder="搜资产、staging 或 marts" value={query}
                 onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 300 }} />
          <Segmented
            value={account}
            onChange={(v) => setAccount(String(v))}
            options={['全部', '3120', '64188', '共享']}
          />
          <span style={{ flex: 1 }} />
          {data !== null && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {focused.nodes.length} 个节点 · {focused.edges.length} 条关系
            </Typography.Text>
          )}
        </div>
        {data !== null && focused.nodes.length === 0 ? (
          <Empty description="没有匹配的节点" style={{ padding: '80px 0' }} />
        ) : (
          <div ref={boxRef} style={{ width: '100%', height: 'calc(100vh - 330px)', minHeight: 460 }} />
        )}
      </Card>

      {data !== null && data.warnings.length > 0 && (
        <Alert type="info" showIcon message={`${data.warnings.length} 条生成告警`}
               description={data.warnings.join('；')} />
      )}

      <Drawer open={selected !== null} onClose={() => setSelected(null)} width={460}
              title={selected === null ? null : (
                <Space size={8}>
                  <span>{selected.label}</span>
                  <Tag color={KIND_COLOR[selected.kind]} style={{ borderRadius: 999 }}>{KIND_LABEL[selected.kind]}</Tag>
                </Space>
              )}>
        {selected !== null && data !== null && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {selected.kind === 'asset' && (() => {
              const a = data.assets.find((x) => x.lake === selected.label)
              if (a === undefined) return null
              return (
                <>
                  <div>
                    <div style={{ fontSize: 12, color: '#9AA0A6', marginBottom: 6 }}>管线（{a.pipelines.length}）</div>
                    {a.pipelines.map((p) => {
                      const run = data.lastRun[p.id]
                      return (
                        <div key={p.id} style={{ padding: '4px 0', fontSize: 13 }}>
                          <span style={{
                            display: 'inline-block', width: 6, height: 6, borderRadius: 6, marginRight: 6,
                            background: run === null || run === undefined ? '#C9CDD4' : (RUN_DOT[run.status] ?? '#C9CDD4'),
                          }} />
                          <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{p.id}</span>
                          <div style={{ paddingLeft: 12, fontSize: 11.5, color: '#9AA0A6' }}>
                            {p.account === null ? '共享' : `账套 ${p.account}`}
                            {p.cron === null ? ' · 无调度' : ` · ${p.cron}`}
                            {p.cron !== null && !p.enabled ? ' · 已停用' : ''}
                            {run == null ? ' · 运行记录未知' : ` · 最近 ${run.status} ${new Date(run.at).toLocaleString('zh-CN')}`}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#9AA0A6', marginBottom: 4 }}>下游</div>
                    <div style={{ fontSize: 13 }}>staging：{a.staging ?? '—（断点）'}</div>
                    <div style={{ fontSize: 13 }}>marts：{a.marts.length === 0 ? '—' : a.marts.join('、')}</div>
                  </div>
                </>
              )
            })()}
            {selected.kind === 'staging' && (() => {
              const up = data.assets.filter((a) => a.staging === selected.label)
              const martList = [...new Set(up.flatMap((a) => a.marts))]
              return (
                <>
                  <div style={{ fontSize: 13 }}>上游资产：{up.map((a) => a.lake).join('、') || '—'}</div>
                  <div style={{ fontSize: 13 }}>下游 marts：{martList.join('、') || '—'}</div>
                </>
              )
            })()}
            {selected.kind === 'mart' && (() => {
              const up = data.assets.filter((a) => a.marts.includes(selected.label))
              return (
                <div style={{ fontSize: 13 }}>
                  上游 staging：{[...new Set(up.map((a) => a.staging).filter(Boolean))].join('、') || '—'}
                </div>
              )
            })()}
          </Space>
        )}
      </Drawer>
    </Space>
  )
}
