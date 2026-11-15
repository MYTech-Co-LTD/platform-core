// console/lineage/index.tsx — 数据生产线（2026-11-15）。
//
// 问题：体系地图/管线地图都只到「表」，看不出**字段**怎么一步步变成指标。
// 本页把四段摊开：源接口 → 湖（落盘形态）→ staging → marts，每列标出
// 直通 / 被丢掉 / dbt 注入 / 聚合度量；▶ 播放按生产顺序逐段出现。
//
// 数据：GET /system-map/lineage/:metricId（仓内声明：契约 columns/layout + dbt schema.yml）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Select, Space, Tag, Typography } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

type Status = 'passthrough' | 'dropped' | 'added' | 'aggregate'
interface Column { name: string; type?: string; description: string; status: Status; inputs?: string[] }
interface Lineage {
  metricId: string
  title: string
  source: { contractId: string | null; columns: Column[] }
  lake: { prefix: string; partitions: string[]; fileName: string; partitionStyle: string } | null
  staging: { model: string | null; columns: Column[] }
  marts: { model: string | null; columns: Column[] }
  notes: string[]
}
interface MetricOption { id: string; title: string }

const STATUS_TAG: Record<Status, { text: string; color: string } | null> = {
  passthrough: null,
  dropped: { text: '本层丢掉', color: 'default' },
  added: { text: 'dbt 注入', color: 'purple' },
  aggregate: { text: '聚合度量', color: 'green' },
}

function Field({ c, innerRef }: { c: Column; innerRef?: (el: HTMLDivElement | null) => void }) {
  const tag = STATUS_TAG[c.status]
  return (
    <div ref={innerRef} data-field={c.name} style={{
      padding: '6px 8px', borderRadius: 8,
      background: c.status === 'added' ? '#F7F3FF' : c.status === 'aggregate' ? '#F0FFF7' : 'transparent',
      opacity: c.status === 'dropped' ? 0.55 : 1,
    }}>
      <div style={{
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5,
        textDecoration: c.status === 'dropped' ? 'line-through' : 'none',
      }}>
        {c.name}
        {c.type !== undefined && <span style={{ color: '#9AA0A6', marginLeft: 6 }}>{c.type}</span>}
        {tag !== null && <Tag color={tag.color} style={{ borderRadius: 999, marginLeft: 6, fontSize: 10 }}>{tag.text}</Tag>}
      </div>
      {c.description !== '' && (
        <div style={{ fontSize: 10.5, color: '#9AA0A6', lineHeight: 1.45, marginTop: 1 }} title={c.description}>
          {c.description}
        </div>
      )}
    </div>
  )
}

function LayerCard(props: {
  step: number
  title: string
  sub: string
  on: boolean
  children: React.ReactNode
}) {
  return (
    <Card
      style={{
        flex: '1 1 0', minWidth: 0,
        opacity: props.on ? 1 : 0, transform: props.on ? 'none' : 'translateY(8px)',
        transition: 'opacity .35s ease, transform .35s ease',
      }}
      styles={{ body: { padding: 12 } }}
    >
      <div style={{ borderBottom: '1px solid #EBEDF0', paddingBottom: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{props.step} {props.title}</div>
        <div style={{ fontSize: 11.5, color: '#9AA0A6', marginTop: 2 }}>{props.sub}</div>
      </div>
      <div style={{ maxHeight: 520, overflow: 'auto' }}>{props.children}</div>
    </Card>
  )
}

export default function LineagePage() {
  const [params, setParams] = useSearchParams()
  const metricId = params.get('metric')
  const [options, setOptions] = useState<MetricOption[]>([])
  const [data, setData] = useState<Lineage | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [step, setStep] = useState(0)
  // 连线（SVG 覆盖层）：源→staging 同名、staging→marts 同名、staging→度量（聚合输入）
  const boxRef = useRef<HTMLDivElement>(null)
  const fieldRefs = useRef(new Map<string, HTMLDivElement>())
  const [links, setLinks] = useState<Array<{ d: string; kind: 'pass' | 'drop' | 'agg'; stage: number }>>([])

  // 指标下拉：列表接口的字段是 id/title（与 /metrics 的既有契约一致）
  useEffect(() => {
    apiGet('/metrics')
      .then((r) => {
        const list = (r as { metrics?: Array<{ id: string; title: string }> }).metrics ?? []
        setOptions(list.map((m) => ({ id: m.id, title: m.title })))
      })
      .catch(() => setOptions([]))
  }, [])

  const load = useCallback(() => {
    if (metricId === null || metricId === '') return
    setError(null)
    apiGet(`/system-map/lineage/${encodeURIComponent(metricId)}`)
      .then((r) => { setData(r as Lineage); setStep(1) })
      .catch((e: unknown) => { setError(humanError(e)); setData(null) })
  }, [metricId])
  useEffect(load, [load])

  const play = (): void => {
    setStep(1)
    let i = 1
    const timer = setInterval(() => {
      i += 1
      setStep(i)
      if (i >= 4) clearInterval(timer)
    }, 650)
  }

  // 连线：用元素实际位置算贝塞尔曲线（布局变了就重算；resize 也重算）
  useEffect(() => {
    if (data === null) { setLinks([]); return }
    const build = (): void => {
      const box = boxRef.current
      if (box === null) return
      const base = box.getBoundingClientRect()
      const at = (layer: string, name: string): { x: number; y: number } | null => {
        const el = fieldRefs.current.get(`${layer}:${name}`)
        if (el === undefined) return null
        const r = el.getBoundingClientRect()
        return { x: r.left - base.left, y: r.top - base.top + r.height / 2, right: r.right - base.left } as never
      }
      const out: Array<{ d: string; kind: 'pass' | 'drop' | 'agg'; stage: number }> = []
      const curve = (from: { x: number; y: number }, to: { x: number; y: number }): string => {
        const dx = Math.max(24, (to.x - from.x) * 0.45)
        return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`
      }
      for (const c of data.source.columns) {
        const from = at('source', c.name)
        if (from === null) continue
        if (c.status === 'dropped') {
          out.push({ d: `M ${(from as never as { right: number }).right} ${from.y} l 26 0`, kind: 'drop', stage: 2 })
          continue
        }
        const to = at('staging', c.name)
        if (to !== null) out.push({ d: curve({ x: (from as never as { right: number }).right, y: from.y }, to), kind: 'pass', stage: 2 })
      }
      for (const c of data.staging.columns) {
        const from = at('staging', c.name)
        const to = at('marts', c.name)
        if (from === null || to === null) continue
        out.push({ d: curve({ x: (from as never as { right: number }).right, y: from.y }, to), kind: 'pass', stage: 3 })
      }
      for (const c of data.marts.columns) {
        if (c.inputs === undefined) continue
        const to = at('marts', c.name)
        if (to === null) continue
        for (const input of c.inputs) {
          const from = at('staging', input)
          if (from === null) continue
          out.push({ d: curve({ x: (from as never as { right: number }).right, y: from.y }, to), kind: 'agg', stage: 4 })
        }
      }
      setLinks(out)
    }
    build()
    const onResize = (): void => build()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [data])

  const dropped = useMemo(() => data?.source.columns.filter((c) => c.status === 'dropped').map((c) => c.name) ?? [], [data])
  const measures = useMemo(() => data?.marts.columns.filter((c) => c.status === 'aggregate').map((c) => c.name) ?? [], [data])

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          showSearch
          placeholder="选一个指标"
          style={{ minWidth: 280 }}
          value={metricId ?? undefined}
          onChange={(v) => setParams({ metric: String(v) }, { replace: true })}
          options={options.map((o) => ({ value: o.id, label: `${o.title} · ${o.id}` }))}
          filterOption={(input, option) =>
            String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
        <Button type="primary" onClick={play} disabled={data === null}>▶ 播放生产流程</Button>
        <Button onClick={() => setStep(4)} disabled={data === null}>显示全部</Button>
        {data !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            指标「{data.title}」= marts 的 {measures.join(' / ') || '未声明度量'}
          </Typography.Text>
        )}
      </div>

      {error !== null && (
        <Alert type="error" showIcon message={error.text} description={error.detail ?? error.code}
               action={<Button size="small" onClick={load}>重试</Button>} />
      )}

      {data === null && error === null && (
        <Card><Empty description="选一个指标，看它从源字段到成品的完整加工过程" /></Card>
      )}

      {data !== null && (
        <div ref={boxRef} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', position: 'relative' }}>
          <svg
            aria-hidden
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
          >
            {links.filter((l) => step >= l.stage).map((l, i) => (
              <path
                key={i}
                d={l.d}
                fill="none"
                stroke={l.kind === 'agg' ? '#0FA958' : l.kind === 'drop' ? '#E5484D' : '#C9CDD4'}
                strokeWidth={l.kind === 'pass' ? 1 : 1.2}
                strokeDasharray={l.kind === 'pass' ? undefined : '4 4'}
                opacity={l.kind === 'pass' ? 0.75 : 0.9}
              />
            ))}
          </svg>
          <LayerCard step={1} title="源接口 + 契约" on={step >= 1}
                     sub={`${data.source.columns.length} 列 · ${data.source.contractId ?? '无契约'}`}>
            {data.source.columns.map((c) => (
              <Field key={c.name} c={c} innerRef={(el) => { if (el !== null) fieldRefs.current.set(`source:${c.name}`, el) }} />
            ))}
          </LayerCard>

          <LayerCard step={2} title="湖（raw parquet）" on={step >= 2}
                     sub={data.lake === null ? '落盘形态未声明' : `前缀 ${data.lake.prefix}`}>
            {data.lake === null ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>契约没声明 layout</Typography.Text>
            ) : (
              <div style={{ fontSize: 12, lineHeight: 2 }}>
                <div><b style={{ color: '#9AA0A6', fontWeight: 400 }}>目录</b> <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}>{data.lake.prefix}/</span></div>
                <div><b style={{ color: '#9AA0A6', fontWeight: 400 }}>分区</b> <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}>{data.lake.partitions.map((p) => `${p}=…`).join('/')}/</span></div>
                <div><b style={{ color: '#9AA0A6', fontWeight: 400 }}>文件</b> <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}>{data.lake.fileName}</span></div>
                <div style={{ color: '#9AA0A6', marginTop: 8, fontSize: 11.5 }}>
                  字段与契约一致（{data.source.columns.length} 列）；分区键由路径推断，staging 再显式 cast 回契约类型。
                </div>
              </div>
            )}
          </LayerCard>

          <LayerCard step={3} title="staging（洗净对齐）" on={step >= 3}
                     sub={`${data.staging.columns.length} 列${data.staging.model === null ? '' : ` · ${data.staging.model}`}${dropped.length > 0 ? ` · 丢掉 ${dropped.length} 列` : ''}`}>
            {data.staging.columns.length === 0
              ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>这一层没有列声明</Typography.Text>
              : data.staging.columns.map((c) => (
                <Field key={c.name} c={c} innerRef={(el) => { if (el !== null) fieldRefs.current.set(`staging:${c.name}`, el) }} />
              ))}
          </LayerCard>

          <LayerCard step={4} title="marts（业务成品）" on={step >= 4}
                     sub={`${data.marts.columns.length} 列${data.marts.model === null ? '' : ` · ${data.marts.model}`} · ${measures.length} 个聚合度量`}>
            {data.marts.columns.length === 0
              ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>这一层没有列声明</Typography.Text>
              : data.marts.columns.map((c) => (
                <Field key={c.name} c={c} innerRef={(el) => { if (el !== null) fieldRefs.current.set(`marts:${c.name}`, el) }} />
              ))}
          </LayerCard>
        </div>
      )}

      {data !== null && data.notes.length > 0 && (
        <Alert type="info" showIcon message="生成说明" description={data.notes.join('；')} />
      )}
    </Space>
  )
}
