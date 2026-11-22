// console/flow/index.tsx — 「全流程」节点图（2026-11-22，#2687）。
//
// 一张从左到右的流程图：源接口 → 采集管线 → 湖资产 → staging → marts → 指标 → 消费面。
// 与「结构」（关系图）/「血缘」（单指标纵切）的分工：本页回答**整条链路**长什么样。
//
// 聚合策略：管线按湖前缀分组、指标按实体分组（后端算好 count/members）。
// 点组节点 → 右侧抽屉列成员；点表/湖节点 → 抽屉给出「去看血缘/链路」的入口。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Drawer, Empty, Skeleton, Tag, Typography } from 'antd'
import * as echarts from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

echarts.use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer])

type FlowKind = 'source' | 'pipeline' | 'lake' | 'staging' | 'mart' | 'recon' | 'metric' | 'consumer' | 'audit'

interface FlowNode {
  id: string
  kind: FlowKind
  label: string
  count?: number
  members?: string[]
  x: number
  y: number
}
interface FlowStep {
  id: string
  step: number
  component: string
  kind: string
  label: string
  detail?: string
  count?: number
}
interface FlowBody {
  generatedAt: string
  nodes: FlowNode[]
  edges: Array<{ source: string; target: string; style?: 'dashed' }>
  layers: Array<{ kind: FlowKind; label: string; x: number; count: number }>
  notes: string[]
}

/** 分类色（7 类，固定顺序；与数据地图其它页同一套 token 精神）。 */
const KIND_COLOR: Record<FlowKind, string> = {
  source: '#2a78d6',
  pipeline: '#eb6834',
  lake: '#1baf7a',
  staging: '#eda100',
  mart: '#6250d6',
  recon: '#e34948',
  metric: '#e87ba4',
  consumer: '#008300',
  audit: '#6b7280',
}
const KIND_LABEL: Record<FlowKind, string> = {
  source: '源接口',
  pipeline: '采集管线',
  lake: '湖资产',
  staging: 'staging',
  mart: 'marts',
  recon: '对账族',
  metric: '指标',
  consumer: '消费面',
  audit: '审计（旁路）',
}

export default function FlowPage() {
  const [body, setBody] = useState<FlowBody | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [pick, setPick] = useState<FlowNode | null>(null)
  /** 管线节点流：点成员加载（懒加载，避免一次拉 121 条） */
  const [pipeId, setPipeId] = useState<string | null>(null)
  const [pipeSteps, setPipeSteps] = useState<FlowStep[] | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  const openPipelineFlow = useCallback(async (id: string) => {
    setPipeId(id)
    setPipeSteps(null)
    try {
      const res = (await apiGet(`/system-map/pipelines/${encodeURIComponent(id)}/flow`)) as { steps?: FlowStep[] }
      setPipeSteps(res.steps ?? [])
    } catch {
      setPipeSteps([])
    }
  }, [])

  const load = useCallback(async () => {
    try {
      setBody((await apiGet('/system-map/flow')) as FlowBody)
      setError(null)
    } catch (e) {
      setError(humanError(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (boxRef.current === null || body === null) return
    const chart = chartRef.current ?? echarts.init(boxRef.current)
    chartRef.current = chart
    chart.off('click')
    chart.on('click', (params) => {
      const p = params as { dataType?: string; data?: { id?: string } }
      if (p.dataType !== 'node' || p.data?.id === undefined) return
      const hit = body.nodes.find((n) => n.id === p.data?.id)
      if (hit !== undefined) setPick(hit)
    })
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [body])

  useEffect(() => {
    const chart = chartRef.current
    if (chart === null || body === null) return
    const kinds = Object.keys(KIND_LABEL) as FlowKind[]
    chart.setOption({
      tooltip: {
        confine: true,
        formatter: (raw: unknown) => {
          const p = raw as { dataType?: string; data?: { name?: string; kind?: FlowKind; count?: number } }
          if (p.dataType !== 'node') return ''
          const n = p.data
          if (n === undefined) return ''
          const suffix = n.count !== undefined ? `（×${n.count}）` : ''
          return `${KIND_LABEL[n.kind ?? 'source']}<br/><b>${n.name ?? ''}</b>${suffix}<br/><span style="color:#999">点击看成员</span>`
        },
      },
      legend: [{
        data: kinds.map((k) => KIND_LABEL[k]), top: 0, left: 0,
        itemWidth: 8, itemHeight: 8, icon: 'circle', textStyle: { fontSize: 12, color: '#6B7280' },
      }],
      series: [{
        type: 'graph',
        layout: 'none',
        roam: true,
        focus: 'adjacency',
        left: 24, right: 40, top: 40, bottom: 24,
        label: { show: true, fontSize: 10.5, color: '#4B5563', position: 'right', distance: 4 },
        emphasis: { focus: 'adjacency', label: { fontSize: 12, color: '#1B1C1E' }, lineStyle: { width: 2 } },
        lineStyle: { color: '#D5D8DE', width: 1, curveness: 0.08, opacity: 0.75 },
        edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 4,
        categories: kinds.map((k) => ({ name: KIND_LABEL[k], itemStyle: { color: KIND_COLOR[k] } })),
        data: body.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          name: n.count !== undefined ? `${n.label} ×${n.count}` : n.label,
          category: kinds.indexOf(n.kind),
          x: n.x,
          y: n.y,
          symbolSize: n.count !== undefined ? 10 : 7,
          itemStyle: { color: KIND_COLOR[n.kind] },
        })),
        edges: body.edges.map((e) => ({ source: e.source, target: e.target, ...(e.style === 'dashed' ? { lineStyle: { type: 'dashed', opacity: 0.55 } } : {}) })),
      }],
    }, true)
  }, [body])

  if (error !== null) {
    return <Alert type="error" showIcon message={error.text} description={`错误码：${error.code}`} />
  }
  if (body === null) {
    return <div><Skeleton active /><Typography.Text type="secondary" style={{ fontSize: 12 }}>正在组装全流程图…</Typography.Text></div>
  }

  const height = Math.max(420, Math.max(...body.nodes.map((n) => n.y), 0) + 80)
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
        从左到右共 7 层：源接口 → 采集管线 → 湖资产 → staging → marts → 指标 → 消费面。
        管线与指标默认按组折叠（节点上的 ×N 是成员数），<b>点节点看成员清单</b>；滚轮缩放、拖拽移动。
      </Typography.Paragraph>
      {body.notes.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={body.notes.join('；')} />
      )}
      <div ref={boxRef} style={{ width: '100%', height, minHeight: 420 }} />
      {body.nodes.length === 0 && <Empty description="没有可画的节点" />}

      <Drawer
        open={pick !== null} onClose={() => setPick(null)} width={520}
        title={pick === null ? '' : `${KIND_LABEL[pick.kind]}：${pick.label}${pick.count !== undefined ? `（×${pick.count}）` : ''}`}
      >
        {pick !== null && (
          <>
            {pick.kind === 'pipeline' && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                这一组管线写入同一个湖资产。逐条详情见「链路」视角（/console/data/pipelines）。
              </Typography.Paragraph>
            )}
            {pick.kind === 'metric' && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                同一业务实体下的指标组。单个指标的口径与血缘见「血缘」视角。
              </Typography.Paragraph>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(pick.members ?? []).map((m) => (
                pick.kind === 'pipeline'
                  ? (
                    <Tag
                      key={m}
                      onClick={() => { void openPipelineFlow(m) }}
                      style={{ marginInlineEnd: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, cursor: 'pointer' }}
                    >
                      {m} <span style={{ color: '#8c8c8c' }}>看节点流 →</span>
                    </Tag>
                  )
                  : <Tag key={m} style={{ marginInlineEnd: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{m}</Tag>
              ))}
              {(pick.members ?? []).length === 0 && (
                <Typography.Text type="secondary">该节点没有成员清单（叶子节点）</Typography.Text>
              )}
            </div>

            {/* 管线内部节点流：采集的每一步（取数页 / 合并 / 定型 / 契约门 / 落湖） */}
            {pipeId !== null && (
              <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  节点流：<span className="mono">{pipeId}</span>
                </Typography.Text>
                {pipeSteps === null && <div style={{ marginTop: 6 }}><Skeleton active paragraph={{ rows: 3 }} /></div>}
                {pipeSteps !== null && pipeSteps.length === 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    没有解析到节点流（管线定义缺失或不可读）。
                  </Typography.Text>
                )}
                {pipeSteps !== null && pipeSteps.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {pipeSteps.map((st) => (
                      <div key={st.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
                        <span style={{ color: '#8c8c8c', minWidth: 20 }}>{st.step}</span>
                        <span className="mono" style={{ color: '#8c8c8c', fontSize: 11.5 }}>{st.component}</span>
                        <span>{st.label || st.kind}{st.count !== undefined && st.count > 1 ? ` ×${st.count}` : ''}</span>
                        {st.detail !== undefined && <span style={{ color: '#aaa', fontSize: 11.5 }}>{st.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
