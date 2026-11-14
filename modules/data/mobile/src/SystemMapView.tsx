// SystemMapView.tsx — 移动端「体系地图」（2026-11-15）。
//
// 取代原来的「链接到服务端单文件 HTML 页」：移动端现在直读 `/system-map/graph`
// 与 `/system-map/metrics/:id/trail`，与桌面同一份 API、同一套口径——
// 旧 HTML 页因此可以下线（两套渲染长期分叉的成本是这次切换的唯一理由）。
//
// 移动端不做图谱：小屏上力导向图没法用。这里用「业务对象 → 指标」的分组列表 +
// 指标详情（observations + 链路），把同样的事实按可读的顺序铺开。
import { useEffect, useMemo, useState } from 'react'
import { Input, Skeleton } from 'antd-mobile'
import { C, EmptyState, cardStyle, radius } from './ui'
import { apiGet } from './api'

interface OntologyNode { id: string; type: 'entity' | 'metric' | 'source' | 'dimension'; label: string; observations: string[] }
interface OntologyEdge { from: string; to: string; type: string }
interface GraphResponse {
  health: { metricTotal: number; entityBoundPct: number; auditCoveredPct: number; zeroUse: number }
  ontology: { nodes: OntologyNode[]; edges: OntologyEdge[] }
}
interface TrailStep { kind: string; label: string; detail?: string; from: 'declared' | 'inferred' }
interface MetricTrail {
  steps: TrailStep[]
  runtime: { lastRun: { status: string; at: string } | null; materializedAt: string | null; maxBizday: string | null }
  notes: string[]
}

const STEP_LABEL: Record<string, string> = { metric: '指标', mart: '表', staging: 'staging', lake: '湖', pipeline: '管线' }

export default function SystemMapView({ focus }: { focus?: string | null }) {
  const [data, setData] = useState<GraphResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<OntologyNode | null>(null)
  const [trail, setTrail] = useState<MetricTrail | null>(null)

  useEffect(() => {
    let alive = true
    apiGet('/system-map/graph')
      .then((b) => { if (alive) setData(b as GraphResponse) })
      .catch(() => { if (alive) setError('体系地图暂时读不到，稍后再试') })
    return () => { alive = false }
  }, [])

  // 深链带指标 id：数据到了自动打开详情（报表卡「口径与来源」用）
  useEffect(() => {
    if (focus === undefined || focus === null || data === null) return
    const node = data.ontology.nodes.find((n) => n.id === `metric:${focus}`)
    if (node !== undefined) setOpen(node)
  }, [focus, data])

  useEffect(() => {
    setTrail(null)
    if (open === null || open.type !== 'metric') return
    let alive = true
    const id = open.id.replace(/^metric:/, '')
    apiGet(`/system-map/metrics/${encodeURIComponent(id)}/trail`)
      .then((b) => { if (alive) setTrail((b as { trail: MetricTrail }).trail) })
      .catch(() => { if (alive) setTrail(null) })
    return () => { alive = false }
  }, [open])

  const groups = useMemo(() => {
    if (data === null) return []
    const byId = new Map(data.ontology.nodes.map((n) => [n.id, n]))
    const entityOf = new Map<string, string>()
    for (const e of data.ontology.edges) {
      if (e.type === 'belongs_to') entityOf.set(e.from, e.to)
    }
    const needle = q.trim().toLowerCase()
    const metrics = data.ontology.nodes.filter((n) => n.type === 'metric')
      .filter((n) => needle === '' || n.label.toLowerCase().includes(needle)
        || n.observations.some((o) => o.toLowerCase().includes(needle)))
    const out = new Map<string, { label: string; items: OntologyNode[] }>()
    for (const m of metrics) {
      const eid = entityOf.get(m.id) ?? 'entity:__none__'
      const label = byId.get(eid)?.label ?? '未归属对象'
      const g = out.get(eid)
      if (g === undefined) out.set(eid, { label, items: [m] })
      else g.items.push(m)
    }
    return [...out.entries()].map(([id, g]) => ({ id, ...g })).sort((a, b) => a.label.localeCompare(b.label))
  }, [data, q])

  if (error !== null) {
    return <div style={{ padding: 32, textAlign: 'center', color: C.mute, fontSize: 13 }}>{error}</div>
  }
  if (data === null) {
    return (
      <div style={{ padding: 12 }}>
        <Skeleton.Title animated />
        <Skeleton.Paragraph lineCount={4} animated />
      </div>
    )
  }

  // ── 指标详情 ────────────────────────────────────────────────────────────────
  if (open !== null) {
    return (
      <div style={{ padding: 12 }}>
        <button
          type="button"
          onClick={() => { setOpen(null); setTrail(null) }}
          style={{
            border: 'none', background: 'none', color: C.accentDeep, fontSize: 13,
            padding: '6px 0', minHeight: 38, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <span aria-hidden>←</span> 返回
        </button>
        <h1 style={{ margin: '2px 0 4px', fontSize: 20, lineHeight: 1.25, fontWeight: 650, color: C.ink }}>
          {open.label}
        </h1>
        <div style={{ fontSize: 11.5, color: C.mute, marginBottom: 12, fontFamily: 'ui-monospace, Menlo, monospace' }}>
          {open.id.replace(/^metric:/, '')}
        </div>

        <div style={{ ...cardStyle, padding: 14, marginBottom: 12 }}>
          {open.observations.map((o) => (
            <div key={o} style={{ fontSize: 13, color: C.ink, lineHeight: 1.9 }}>{o}</div>
          ))}
        </div>

        <div style={{ fontSize: 12, color: C.mute, margin: '0 2px 6px' }}>链路</div>
        <div style={{ ...cardStyle, padding: 14 }}>
          {trail === null ? (
            <div style={{ fontSize: 12, color: C.mute }}>读取中…</div>
          ) : (
            <>
              {trail.steps.map((s) => (
                <div key={`${s.kind}:${s.label}`} style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 2 }}>
                  <span style={{ color: C.mute, width: 42, flex: 'none' }}>{STEP_LABEL[s.kind] ?? s.kind}</span>
                  <span style={{ color: C.ink, wordBreak: 'break-all' }}>{s.label}</span>
                  {s.from === 'inferred' && <span style={{ color: C.mute }}>（推断）</span>}
                </div>
              ))}
              <div style={{ marginTop: 8, fontSize: 12, color: C.mute, lineHeight: 1.9 }}>
                <div>
                  最近一次运行：
                  {trail.runtime.lastRun === null
                    ? '未知'
                    : `${trail.runtime.lastRun.status} · ${new Date(trail.runtime.lastRun.at).toLocaleDateString('zh-CN')}`}
                </div>
                <div>物化钟：{trail.runtime.materializedAt === null ? '未知' : new Date(trail.runtime.materializedAt).toLocaleDateString('zh-CN')}</div>
                <div>数据水位：{trail.runtime.maxBizday ?? '未知'}</div>
                {trail.notes.map((n) => <div key={n}>{n}</div>)}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  // ── 列表 ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 12 }}>
      <h1 style={{ margin: '4px 2px 10px', fontSize: 23, lineHeight: 1.2, fontWeight: 650, letterSpacing: '-0.02em', color: C.ink }}>
        体系地图
      </h1>

      <div style={{ display: 'flex', gap: 16, padding: '0 4px 12px' }}>
        {[
          { k: '指标', v: data.health.metricTotal },
          { k: '实体绑定', v: `${data.health.entityBoundPct}%` },
          { k: '对账覆盖', v: `${data.health.auditCoveredPct}%` },
          { k: '零使用', v: data.health.zeroUse },
        ].map((x) => (
          <div key={x.k}>
            <div style={{ fontSize: 11, color: C.mute }}>{x.k}</div>
            <div style={{ fontSize: 20, fontWeight: 650, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{x.v}</div>
          </div>
        ))}
      </div>

      <Input
        placeholder="搜索指标或口径"
        value={q}
        onChange={setQ}
        style={{ '--font-size': '13px', background: '#fff', borderRadius: radius.field, padding: '8px 12px' } as React.CSSProperties}
      />

      <div style={{ marginTop: 12 }}>
        {groups.length === 0 ? (
          <EmptyState icon="search" title="没有匹配的指标" hint="换个关键词试试" />
        ) : groups.map((g) => (
          <div key={g.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: C.mute, margin: '0 2px 6px' }}>
              {g.label} · {g.items.length}
            </div>
            <div style={{ ...cardStyle, overflow: 'hidden' }}>
              {g.items.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setOpen(m)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none',
                    padding: '12px 14px', cursor: 'pointer',
                    borderTop: i === 0 ? 'none' : `1px solid ${C.line}`,
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 550, color: C.ink }}>{m.label}</div>
                  <div style={{ fontSize: 12, color: C.mute, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.observations[0] ?? ''}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
