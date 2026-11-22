// console/flow/index.tsx — 「数据生产线」动效流水线（2026-11-22，#2693）。
//
// 形态第四次迭代，按用户明确要求：**完整动效的流程图，像流水线一样**展示
//   ① 数据怎么生产（源 → 采集 → 湖 → staging → marts → 指标 → 消费）
//   ② 怎么对账（平台值 + 源值 → 差异 → 容差 → 归因 → 台账）
//   ③ 怎么排班（24 小时时间轴 + 当前时刻 + 正在跑的档位）
//
// 动效全部用 CSS（无第三方动画库）：连线上的流动粒子、节点依次脉冲、排班红针随时间走。
// 数据来自现役端点：/system-map/flow（结构计数）、/system-map/observability（对账汇总 + 排班）。
// 点任意节点 → 抽屉打开对象详情（/system-map/object，字段/血缘/说明）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Drawer, Skeleton, Table, Tabs, Tag, Typography } from 'antd'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'
import { parseCronToCstSlots, type CronSlot } from './cron'

type ObjectKind = 'lake' | 'staging' | 'mart' | 'recon' | 'metric' | 'pipeline'
interface SimpleRef { kind: ObjectKind; name: string; displayName?: string; summary?: string }
interface ObjectColumn { name: string; type: string | null; expr: string | null; description: string }
interface ObjectDetail {
  kind: ObjectKind; name: string; displayName: string | null; summary: string | null
  domain: string | null; columns: ObjectColumn[]
  upstream: SimpleRef[]; downstream: SimpleRef[]; upstream2: SimpleRef[]; downstream2: SimpleRef[]; notes: string[]
  /** 管线专用：内部节点流（取数页 → 合并 → 定型 → 契约门 → 落湖） */
  pipelineSteps?: Array<{ id: string; step: number; component: string; kind: string; label: string; detail: string | null; count: number | null }> | null
}
interface FlowBody { nodes: Array<{ id: string; kind: string; label: string; count?: number; members?: string[] }>; notes: string[] }
interface ScheduleRow { key: string; cron: string; enabled: boolean; lastRun: { status: string } | null; fails24h: number }
interface ReconSummary {
  windowDays: number; storeDays: number; overTol: number; withinTol: number
  overTolDiffSum: number
  byAttribution: Array<{ attribution: string; n: number }>
}
interface ObservabilityBody {
  schedules: ScheduleRow[]
  recon: ReconSummary | { error: string }
}

const KIND_LABEL: Record<ObjectKind, string> = {
  pipeline: '采集管线', lake: '湖资产', staging: 'staging', mart: 'marts', recon: '对账族', metric: '指标',
}
const KIND_COLOR: Record<ObjectKind, string> = {
  pipeline: 'orange', lake: 'green', staging: 'gold', mart: 'purple', recon: 'red', metric: 'magenta',
}

/** 生产泳道的六层（每层一个节点：名称 + 计数 + 可下钻的成员前缀）。 */
interface Stage {
  key: string
  title: string
  hint: string
  count: number
  members: string[]
  color: string
}

const CSS = `
@keyframes df-flow { from { left: 0; opacity: 0 } 10% { opacity: 1 } 90% { opacity: 1 } to { left: 100%; opacity: 0 } }
@keyframes df-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(42,120,214,0) } 50% { box-shadow: 0 0 0 6px rgba(42,120,214,.18) } }
@keyframes df-blink { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
@keyframes df-spin { to { transform: rotate(360deg) } }
.df-pipe { position: relative; height: 22px; min-width: 56px; flex: 1; align-self: center; }
.df-pipe::before { content: ''; position: absolute; top: 10px; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, #d5d8de, #b9bec7); border-radius: 2px; }
.df-pipe .dot { position: absolute; top: 6px; width: 9px; height: 9px; border-radius: 50%;
  animation: df-flow 2.6s linear infinite; }
.df-pipe .dot:nth-child(2) { animation-delay: .85s }
.df-pipe .dot:nth-child(3) { animation-delay: 1.7s }
.df-paused .dot { animation-play-state: paused }
.df-paused .df-live { animation-play-state: paused }
.df-node { border: 1px solid #e3e4e8; border-radius: 12px; padding: 10px 12px; background: #fff;
  min-width: 118px; cursor: pointer; transition: transform .12s, box-shadow .12s; }
.df-node:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(15,23,42,.08) }
.df-node .n { font-size: 12.5px; font-weight: 600 }
.df-node .c { font-size: 20px; font-variant-numeric: tabular-nums; line-height: 1.2 }
.df-node .h { font-size: 11px; color: #9aa0a6 }
.df-live { animation: df-pulse 2.4s ease-in-out infinite }
.df-sched { display: grid; grid-template-columns: 92px 1fr; gap: 6px 10px; align-items: center; }
.df-track { position: relative; height: 16px; background: #f3f4f6; border-radius: 8px; overflow: hidden }
.df-bar { position: absolute; top: 3px; height: 10px; border-radius: 5px; }
.df-now { position: absolute; top: 0; bottom: 0; width: 2px; background: #e34948; }
.df-hour { font-size: 10.5px; color: #9aa0a6; }
`

export default function FlowPage() {
  const [flow, setFlow] = useState<FlowBody | null>(null)
  const [obs, setObs] = useState<ObservabilityBody | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [paused, setPaused] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [pick, setPick] = useState<SimpleRef | null>(null)
  const [detail, setDetail] = useState<ObjectDetail | null>(null)
  /** 管线组：先列清单再进单条（避免「点进去一坨、分不清哪条」） */
  const [pipeGroup, setPipeGroup] = useState<{ members: string[] } | null>(null)
  const [detailErr, setDetailErr] = useState<HumanError | null>(null)
  const tickRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [f, o] = await Promise.all([
        apiGet('/system-map/flow') as Promise<FlowBody>,
        apiGet('/system-map/observability') as Promise<ObservabilityBody>,
      ])
      setFlow(f)
      setObs(o)
      setError(null)
    } catch (e) { setError(humanError(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  // 排班红针每分钟走一次（页面不可见时停）
  useEffect(() => {
    tickRef.current = window.setInterval(() => { if (!document.hidden) setNow(new Date()) }, 30_000)
    return () => { if (tickRef.current !== null) window.clearInterval(tickRef.current) }
  }, [])

  const open = useCallback(async (ref: SimpleRef) => {
    setPick(ref); setDetail(null); setDetailErr(null)
    try {
      const qs = new URLSearchParams({ kind: ref.kind, name: ref.name })
      setDetail((await apiGet(`/system-map/object?${qs.toString()}`)) as ObjectDetail)
    } catch (e) { setDetailErr(humanError(e)) }
  }, [])

  const stages: Stage[] = useMemo(() => {
    if (flow === null) return []
    const of = (k: string) => flow.nodes.filter((n) => n.kind === k)
    const built: Stage[] = [
      { key: 'source', title: '源接口', hint: '乐檬接口', count: of('source').length, members: of('source').map((n) => n.label), color: '#2a78d6' },
      { key: 'pipeline', title: '采集管线', hint: '按周期取数落湖', count: flow.nodes.filter((n) => n.kind === 'pipeline').reduce((s, n) => s + (n.count ?? 1), 0), members: flow.nodes.filter((n) => n.kind === 'pipeline').flatMap((n) => n.members ?? [n.label]), color: '#eb6834' },
      { key: 'lake', title: '湖资产', hint: 'parquet 分区文件', count: of('lake').length, members: of('lake').map((n) => n.label), color: '#1baf7a' },
      { key: 'staging', title: 'staging', hint: '定型 / 规范化', count: of('staging').length, members: of('staging').map((n) => n.label), color: '#eda100' },
      { key: 'mart', title: 'marts', hint: '按店日聚合度量', count: of('mart').length + of('recon').length, members: [...of('mart'), ...of('recon')].map((n) => n.label), color: '#6250d6' },
      { key: 'metric', title: '指标', hint: '口径的唯一实现', count: flow.nodes.filter((n) => n.kind === 'metric').reduce((s, n) => s + (n.count ?? 1), 0), members: flow.nodes.filter((n) => n.kind === 'metric').flatMap((n) => n.members ?? [n.label]), color: '#e87ba4' },
      { key: 'consumer', title: '消费面', hint: '报表 / 钻取 / 问数', count: of('consumer').length, members: of('consumer').map((n) => n.label), color: '#008300' },
    ]
    return built
  }, [flow])

  const recon = obs !== null && !('error' in obs.recon) ? obs.recon : null
  const schedules = useMemo(() => (obs?.schedules ?? []).filter((s) => s.enabled), [obs])
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const nowPct = (nowMinute / 1440) * 100

  if (error !== null) return <Alert type="error" showIcon message={error.text} description={`错误码：${error.code}`} />
  if (flow === null || obs === null) {
    return <div><Skeleton active paragraph={{ rows: 10 }} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>正在装载流水线…</Typography.Text></div>
  }

  const dotColors = (c: string) => (
    <>
      <span className="dot" style={{ background: c }} />
      <span className="dot" style={{ background: c }} />
      <span className="dot" style={{ background: c }} />
    </>
  )

  return (
    <div className={paused ? 'df-paused' : undefined}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>数据生产线</b>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          粒子 = 数据在流动；节点上的数字 = 该环节的对象数；点任意节点看它的字段与血缘。
        </Typography.Text>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => setPaused((v) => !v)}
            style={{ border: '1px solid #e3e4e8', background: '#fff', borderRadius: 999, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
          >
            {paused ? '▶ 播放动效' : '⏸ 暂停动效'}
          </button>
          <button
            onClick={() => { void load() }}
            style={{ border: '1px solid #e3e4e8', background: '#fff', borderRadius: 999, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
          >
            ⟳ 刷新数据
          </button>
        </span>
      </div>

      {/* ── 泳道 ①：数据生产 ─────────────────────────────────────────────── */}
      <section style={{ border: '1px solid #e8e8e5', borderRadius: 14, padding: '14px 16px', background: '#fcfcfb', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>① 数据怎么生产</div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, overflowX: 'auto', paddingBottom: 4 }}>
          {stages.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'stretch', flex: i === stages.length - 1 ? '0 0 auto' : 1, minWidth: 0 }}>
              <div
                className={`df-node${i === 1 ? ' df-live' : ''}`}
                onClick={() => {
                  // 采集管线是一组（121 条）：先列清单，再进单条看节点流
                  if (s.key === 'pipeline') { setPipeGroup({ members: s.members }); return }
                  const member = s.members[0]
                  if (member === undefined) return
                  const kind: ObjectKind = s.key === 'metric' ? 'metric' : s.key === 'lake' ? 'lake' : s.key === 'staging' ? 'staging' : 'mart'
                  void open({ kind, name: member })
                }}
                title={s.members.slice(0, 10).join('\n')}
              >
                <div className="n" style={{ color: s.color }}>{s.title}</div>
                <div className="c">{s.count}</div>
                <div className="h">{s.hint}</div>
              </div>
              {i < stages.length - 1 && <div className="df-pipe">{dotColors(s.color)}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ── 泳道 ②：对账 ────────────────────────────────────────────────── */}
      <section style={{ border: '1px solid #e8e8e5', borderRadius: 14, padding: '14px 16px', background: '#fcfcfb', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>② 怎么对账（近 {recon?.windowDays ?? 7} 天）</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap', rowGap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="df-node" style={{ minWidth: 150 }} onClick={() => void open({ kind: 'mart', name: 'fct_retail_sale' })}>
              <div className="n" style={{ color: '#6250d6' }}>平台值</div>
              <div className="h">我们算的（fct_retail_sale）</div>
            </div>
            <div className="df-node" style={{ minWidth: 150 }} onClick={() => void open({ kind: 'staging', name: 'stg_lemeng_recon_source' })}>
              <div className="n" style={{ color: '#2a78d6' }}>源值</div>
              <div className="h">乐檬报表端点返回</div>
            </div>
          </div>
          <div className="df-pipe" style={{ minWidth: 70, maxWidth: 110 }}>{dotColors('#6250d6')}</div>
          <div className="df-node df-live" onClick={() => void open({ kind: 'recon', name: 'recon_fact' })}>
            <div className="n" style={{ color: '#e34948' }}>差异计算</div>
            <div className="c">{recon?.storeDays ?? '—'}</div>
            <div className="h">店日（逐店逐日）</div>
          </div>
          <div className="df-pipe" style={{ minWidth: 70, maxWidth: 110 }}>{dotColors('#e34948')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="df-node" onClick={() => void open({ kind: 'recon', name: 'recon_break' })}>
              <div className="n" style={{ color: '#008300' }}>在容差内</div>
              <div className="c">{recon?.withinTol ?? '—'}</div>
              <div className="h">直接对平</div>
            </div>
            <div className="df-node" onClick={() => void open({ kind: 'recon', name: 'recon_break' })}>
              <div className="n" style={{ color: '#e34948' }}>超容差</div>
              <div className="c">{recon?.overTol ?? '—'}</div>
              <div className="h">差异 {recon === null ? '—' : `¥${recon.overTolDiffSum.toLocaleString()}`}</div>
            </div>
          </div>
          <div className="df-pipe" style={{ minWidth: 70, maxWidth: 110 }}>{dotColors('#e34948')}</div>
          <div className="df-node" onClick={() => void open({ kind: 'mart', name: 'fct_retail_swap_offset' })}>
            <div className="n" style={{ color: '#eda100' }}>归因</div>
            <div className="h">
              {recon === null || recon.byAttribution.length === 0
                ? '无超容差'
                : recon.byAttribution.map((a) => `${a.attribution} ${a.n}`).join('，')}
            </div>
          </div>
          <div className="df-pipe" style={{ minWidth: 56, maxWidth: 90 }}>{dotColors('#008300')}</div>
          <div className="df-node" onClick={() => void open({ kind: 'recon', name: 'recon_break' })}>
            <div className="n" style={{ color: '#008300' }}>台账</div>
            <div className="h">逐店差异 + 处置</div>
          </div>
        </div>
      </section>

      {/* ── 泳道 ③：排班 ────────────────────────────────────────────────── */}
      <section style={{ border: '1px solid #e8e8e5', borderRadius: 14, padding: '14px 16px', background: '#fcfcfb' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>③ 怎么排班（北京时间 24 小时）</div>
          <span style={{ fontSize: 12, color: '#e34948' }}>
            现在 {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
          </span>
          <span style={{ fontSize: 11.5, color: '#9aa0a6' }}>红针 = 当前时刻；条 = 该档在这段时间内会跑</span>
        </div>
        <div className="df-sched">
          {schedules.map((s) => {
            const shape = parseCronToCstSlots(s.cron)
            const label = s.key.replace(/^(data|platform)\./, '')
            return (
              <Row key={s.key} label={label} cron={s.cron} shape={shape} nowPct={nowPct} nowMinute={nowMinute}
                failed={(s.lastRun?.status === 'failed' || s.lastRun?.status === 'timeout') || s.fails24h > 0} />
            )
          })}
        </div>
      </section>

      {/* 管线组清单：先看「有哪几条」，再点进去看节点流（避免点进去一坨、分不清哪条） */}
      <Drawer
        open={pipeGroup !== null} onClose={() => setPipeGroup(null)} width={520}
        title={`采集管线（${pipeGroup?.members.length ?? 0} 条）`}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
          点一条看它的**节点流**（取数页 → 合并 → 定型 → 契约门 → 落湖）。
        </Typography.Paragraph>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '70vh', overflow: 'auto' }}>
          {(pipeGroup?.members ?? []).map((m) => (
            <div
              key={m}
              onClick={() => { setPipeGroup(null); void open({ kind: 'pipeline', name: m }) }}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 8, cursor: 'pointer',
                border: '1px solid #e3e4e8', borderRadius: 10, padding: '7px 10px', fontSize: 12.5,
              }}
            >
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>{m}</span>
              <span style={{ color: '#2a78d6', whiteSpace: 'nowrap' }}>看节点流 →</span>
            </div>
          ))}
        </div>
      </Drawer>

      <Drawer
        open={pick !== null} onClose={() => setPick(null)} width={760}
        title={pick === null ? '' : (
          <span>
            <Tag color={KIND_COLOR[pick.kind]} style={{ marginInlineEnd: 8 }}>{KIND_LABEL[pick.kind]}</Tag>
            <span>{detail?.displayName !== null && detail?.displayName !== undefined && detail.displayName !== pick.name
              ? `${detail.displayName}（${pick.name}）`
              : pick.name}</span>
          </span>
        )}
      >
        {detailErr !== null && <Alert type="error" showIcon message={detailErr.text} description={`错误码：${detailErr.code}`} />}
        {detail === null && detailErr === null && <Skeleton active paragraph={{ rows: 6 }} />}
        {detail !== null && (
          <Tabs
            key={detail.pipelineSteps !== null && detail.pipelineSteps !== undefined ? 'steps' : 'rel'}
            defaultActiveKey={detail.pipelineSteps !== null && detail.pipelineSteps !== undefined ? 'steps' : 'rel'}
            items={[
            ...(detail.pipelineSteps !== null && detail.pipelineSteps !== undefined
              ? [{ key: 'steps', label: `节点流 ${detail.pipelineSteps.length} 步`, children: <StepList steps={detail.pipelineSteps} /> }]
              : []),
            {
              key: 'rel', label: '关系',
              children: <RelationView detail={detail} onPick={(r) => void open(r)} />,
            },
            {
              key: 'cols', label: `字段 ${detail.columns.length}`,
              children: detail.columns.length === 0
                ? <Typography.Text type="secondary">没有解析到字段（未知 ≠ 没有）</Typography.Text>
                : (
                  <Table<ObjectColumn> size="small" rowKey="name" dataSource={detail.columns} pagination={false}
                    columns={[
                      { title: '字段', dataIndex: 'name', width: 180, render: (v: string) => <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{v}</span> },
                      { title: '类型', dataIndex: 'type', width: 100, render: (v: string | null) => v ?? '—' },
                      {
                        title: '表达式 / 说明', dataIndex: 'expr',
                        render: (v: string | null, r) => (
                          <div style={{ fontSize: 12 }}>
                            {v !== null && <div style={{ fontFamily: 'ui-monospace, monospace', color: '#4b5563', wordBreak: 'break-all' }}>= {v}</div>}
                            {r.description !== '' && <div style={{ color: '#9aa0a6' }}>{r.description}</div>}
                            {v === null && r.description === '' && '—'}
                          </div>
                        ),
                      },
                    ]}
                  />
                ),
            },
            {
              key: 'notes', label: '说明',
              children: detail.notes.length === 0
                ? <Typography.Text type="secondary">没有异常说明。</Typography.Text>
                : <ul style={{ paddingLeft: 18, fontSize: 12.5, color: '#6b7280' }}>{detail.notes.map((n) => <li key={n}>{n}</li>)}</ul>,
            },
          ]} />
        )}
      </Drawer>
    </div>
  )
}

/**
 * 关系图（详情第一屏）：**上游 → 本对象 → 下游**，三列 + 箭头。
 * 为什么做成图而不是标签列表：用户反馈「点进去什么关系呀」——关系要一眼看出来。
 */
function RelationView(props: {
  detail: ObjectDetail
  onPick: (r: SimpleRef) => void
}) {
  const { detail, onPick } = props
  const chip = (r: SimpleRef, dir: 'up' | 'down') => (
    <div
      key={`${dir}:${r.kind}:${r.name}`}
      onClick={() => onPick(r)}
      title={r.summary ?? undefined}
      style={{
        border: '1px solid #e3e4e8', borderRadius: 10, padding: '7px 10px', background: '#fff',
        cursor: 'pointer', maxWidth: 240,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>
        {r.displayName !== undefined && r.displayName !== r.name ? r.displayName : r.name}
      </div>
      {r.displayName !== undefined && r.displayName !== r.name && (
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: '#9aa0a6' }}>{r.name}</div>
      )}
      <div style={{ fontSize: 10.5, color: '#9aa0a6' }}>{KIND_LABEL[r.kind]}</div>
    </div>
  )
  const arrow = (label: string, dir: 'up' | 'down') => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: '#b9bec7', minWidth: 56 }}>
      <span style={{ fontSize: 10.5, color: '#9aa0a6' }}>{label}</span>
      <span style={{ fontSize: 18, lineHeight: 1 }}>{dir === 'up' ? '→' : '→'}</span>
    </div>
  )
  return (
    <div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        读法：左边的把数据交给它，它算完交给右边。点任意方块跳到那个对象。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1.2fr auto 1fr', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: '#9aa0a6' }}>上游（数据从哪来）</div>
          {detail.upstream.length === 0
            ? <span style={{ fontSize: 12, color: '#9aa0a6' }}>没有上游（源头）</span>
            : detail.upstream.map((r) => chip(r, 'up'))}
          {detail.upstream2.length > 0 && (
            <div style={{ fontSize: 10.5, color: '#b9bec7' }}>
              更上游：{detail.upstream2.map((r) => r.displayName ?? r.name).join('、')}
            </div>
          )}
        </div>
        {arrow('交给', 'up')}
        <div style={{
          border: '2px solid #2a78d6', borderRadius: 12, padding: '10px 12px', background: '#f5f9ff',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {detail.displayName !== null && detail.displayName !== detail.name ? detail.displayName : detail.name}
          </div>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>{detail.name}</div>
          <div style={{ fontSize: 11, color: '#9aa0a6' }}>{KIND_LABEL[detail.kind]}</div>
          {detail.summary !== null && (
            <div style={{ fontSize: 12, color: '#4b5563', marginTop: 4 }}>{detail.summary}</div>
          )}
        </div>
        {arrow('交给', 'down')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: '#9aa0a6' }}>下游（谁在用它）</div>
          {detail.downstream.length === 0
            ? <span style={{ fontSize: 12, color: '#9aa0a6' }}>没有下游（终点）</span>
            : detail.downstream.map((r) => chip(r, 'down'))}
          {detail.downstream2.length > 0 && (
            <div style={{ fontSize: 10.5, color: '#b9bec7' }}>
              更下游：{detail.downstream2.map((r) => r.displayName ?? r.name).join('、')}
            </div>
          )}
        </div>
      </div>
      {detail.notes.length > 0 && (
        <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 12, color: '#9a6b00' }}>
          {detail.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  )
}

/** 管线内部节点流：竖向步骤条（序号 · 组件 · 人话 · 参数）。 */
function StepList(props: { steps: NonNullable<ObjectDetail['pipelineSteps']> }) {
  return (
    <div style={{ paddingLeft: 4 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        这条管线按下面顺序执行（从上到下）。同类型连续节点会合并成一步并标 ×N。
      </div>
      {props.steps.map((st, i) => (
        <div key={st.id} style={{ display: 'flex', gap: 10, paddingBottom: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 22 }}>
            <span style={{
              width: 20, height: 20, borderRadius: '50%', background: '#2a78d6', color: '#fff',
              fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{i + 1}</span>
            {i < props.steps.length - 1 && <span style={{ flex: 1, width: 2, background: '#e3e4e8', marginTop: 2 }} />}
          </div>
          <div style={{ flex: 1, borderBottom: '1px dashed #f0f0f0', paddingBottom: 8 }}>
            <div style={{ fontSize: 13 }}>
              {st.label || st.kind}
              {st.count !== null && st.count > 1 ? ` ×${st.count}` : ''}
            </div>
            <div style={{ fontSize: 11, color: '#9aa0a6', fontFamily: 'ui-monospace, monospace' }}>
              {st.component}{st.detail !== null ? ` · ${st.detail}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 一行排班：标签 + 24h 轨道（条 = 该 cron 的触发窗口；红针 = 当前时刻）。 */
function Row(props: {
  label: string
  cron: string
  shape: ReturnType<typeof parseCronToCstSlots>
  nowPct: number
  nowMinute: number
  failed: boolean
}) {
  const { label, cron, shape, nowPct, nowMinute, failed } = props
  const bars: Array<{ left: number; width: number; live: boolean }> = []
  if (shape.kind === 'every-minutes') {
    if (shape.scope === 'all-day') {
      bars.push({ left: 0, width: 100, live: true })
    } else {
      const from = shape.scope.fromHour * 60
      const to = (shape.scope.toHour + 1) * 60
      bars.push({ left: (from / 1440) * 100, width: ((to - from) / 1440) * 100, live: nowMinute >= from && nowMinute < to })
    }
  }
  const color = failed ? '#e34948' : '#2a78d6'
  return (
    <>
      <div style={{ fontSize: 12, color: failed ? '#e34948' : '#4b5563' }} title={cron}>{label}</div>
      <div className="df-track" title={`${cron}（UTC）`}>
        {shape.kind === 'unknown' && (
          <span style={{ position: 'absolute', left: 6, top: 0, fontSize: 10, color: '#9aa0a6' }}>{cron}</span>
        )}
        {bars.map((b, i) => (
          <span key={i} className={b.live ? 'df-bar df-live' : 'df-bar'}
            style={{ left: `${b.left}%`, width: `${Math.max(b.width, 0.4)}%`, background: color, opacity: b.live ? 0.85 : 0.45 }} />
        ))}
        <span className="df-now" style={{ left: `${nowPct}%` }} />
      </div>
    </>
  )
}

/** 供测试：把排班时点换算成轨道百分比（0–100）。 */
export function slotPct(slot: CronSlot): number {
  return ((slot.hour * 60 + slot.minute) / 1440) * 100
}
