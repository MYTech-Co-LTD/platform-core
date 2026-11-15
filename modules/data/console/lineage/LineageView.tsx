// LineageView.tsx — 「数据生产线」的视图本体：给一个指标，画出源 → 湖 → staging → marts 的字段链路。
//
// 两个宿主：独立页 `console/lineage/index.tsx`（带指标下拉）与体系地图的指标抽屉（#2338）。
// 视图只管「怎么画 + 怎么聚焦」，指标 id 由宿主给；数据自己拉
// GET /system-map/lineage/:metricId（契约 columns/layout + dbt schema.yml + marts SQL 解析）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Skeleton, Tag, Typography } from 'antd'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'
import LineageCanvas, { type CanvasApi } from './canvas'
import { buildFocus, windowOf, type FocusModel } from './focus'
import './lineage.css'

type Status = 'passthrough' | 'dropped' | 'added' | 'aggregate'
type StageKey = 'source' | 'lake' | 'staging' | 'marts'

interface Column {
  name: string
  type?: string
  description: string
  status: Status
  inputs?: string[]
  dependsOn?: string[]
  undocumented?: boolean
}
interface Lineage {
  metricId: string
  title: string
  source: { contractId: string | null; columns: Column[] }
  lake: { prefix: string; partitions: string[]; fileName: string; partitionStyle: string } | null
  staging: { model: string | null; columns: Column[] }
  marts: { model: string | null; columns: Column[] }
  notes: string[]
}

const STAGE_ORDER: StageKey[] = ['source', 'lake', 'staging', 'marts']
const PLAY_STEPS: Array<{ key: StageKey; msg: string }> = [
  { key: 'source', msg: '① 从源接口取数，按契约原样落进湖' },
  { key: 'lake', msg: '② 湖里是 parquet 原件，按 system_book / bizday / hour 分区' },
  { key: 'staging', msg: '③ staging 逐列 cast、补主体列，不改口径' },
  { key: 'marts', msg: '④ marts 按 (账套, 业务日, 门店) 聚合出度量' },
]

/** 折叠时露出来的骨架：分区键 + marts 的粒度键 + staging 注入列。 */
function skeletonOf(data: Lineage): Set<string> {
  const keys = new Set<string>(data.lake?.partitions ?? [])
  for (const c of data.marts.columns) if (c.status === 'passthrough') keys.add(c.name)
  for (const c of data.staging.columns) if (c.status === 'added') keys.add(c.name)
  return keys
}

function Pills(props: {
  stage: StageKey
  columns: Column[]
  hi: ReadonlySet<string>
  /** 可见下标；undefined = 全部 */
  visible?: ReadonlySet<number>
  gaps?: ReadonlyArray<{ before: number; count: number }>
  keys: ReadonlySet<string>
  onPick: (name: string) => void
  /** 折叠模式：只留骨架 */
  skeletonOnly: boolean
}) {
  const { columns, hi, visible, gaps = [], keys, onPick, skeletonOnly } = props
  const gapAt = new Map(gaps.map((g) => [g.before, g.count]))
  const rows: React.ReactNode[] = []
  columns.forEach((c, i) => {
    const gap = gapAt.get(i)
    if (gap !== undefined) {
      rows.push(<div key={`gap-${i}`} className="lineage-gap">⋯ 还有 {gap} 列</div>)
    }
    const shown = visible !== undefined
      ? visible.has(i)
      : skeletonOnly
        // 折叠态留骨架：分区/粒度键 + dbt 注入列 + 聚合度量
        ? keys.has(c.name) || c.status === 'added' || c.status === 'aggregate'
        : true
    if (!shown) return
    const kind = c.status === 'added' ? 'added' : c.status === 'aggregate' ? 'measure' : c.status === 'dropped' ? 'dropped' : 'plain'
    rows.push(
      <div
        key={c.name}
        data-field={c.name}
        data-stage={props.stage}
        data-kind={kind}
        role="button"
        tabIndex={0}
        className={[
          'lineage-pill',
          keys.has(c.name) ? 'is-key' : '',
          hi.has(c.name) ? 'is-hi' : '',
        ].filter(Boolean).join(' ')}
        title={c.description !== '' ? c.description : undefined}
        onClick={(e) => { e.stopPropagation(); onPick(c.name) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(c.name) }
        }}
      >
        <span className="mono">{c.name}</span>
        {c.type !== undefined && <span className="type">{c.type}</span>}
        {c.undocumented === true && <span className="type" title="schema.yml 未写文档，描述取自契约">·</span>}
      </div>,
    )
  })
  const tail = gapAt.get(columns.length)
  if (tail !== undefined) rows.push(<div key="gap-tail" className="lineage-gap">⋯ 还有 {tail} 列</div>)
  return <>{rows}</>
}

export interface LineageViewProps {
  metricId: string
  /** 画板高度：独立页用默认（撑满视口），抽屉里给小一点 */
  height?: number | string
  /** 独立页显示「指标名 + 缺声明」这一行 */
  showTitle?: boolean
}

export default function LineageView({ metricId, height, showTitle = false }: LineageViewProps) {
  const [data, setData] = useState<Lineage | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<StageKey>>(new Set())
  const [focus, setFocus] = useState<FocusModel | null>(null)
  const [play, setPlay] = useState<{ stage: StageKey; msg: string } | null>(null)
  const canvasApi = useRef<CanvasApi | null>(null)
  const timers = useRef<number[]>([])

  const load = useCallback(() => {
    if (metricId === '') return
    setError(null)
    setData(null)
    apiGet(`/system-map/lineage/${encodeURIComponent(metricId)}`)
      .then((r) => {
        setData(r as Lineage)
        setFocus(null)
        setExpanded(new Set())
        setPlay(null)
      })
      .catch((e: unknown) => { setError(humanError(e)); setData(null) })
  }, [metricId])
  useEffect(load, [load])

  const stopPlay = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }, [])
  useEffect(() => stopPlay, [stopPlay])

  const keys = useMemo(() => (data === null ? new Set<string>() : skeletonOf(data)), [data])

  const pick = useCallback((name: string) => {
    if (data === null) return
    const next = buildFocus(name, {
      source: { columns: data.source.columns },
      staging: { columns: data.staging.columns, partitions: data.lake?.partitions ?? [] },
      marts: { columns: data.marts.columns },
    })
    if (next === null) return
    stopPlay()
    setPlay(null)
    setFocus((cur) => (cur !== null && cur.name === name ? null : next))
  }, [data, stopPlay])

  const clearFocus = useCallback(() => { setFocus(null); setPlay(null); stopPlay() }, [stopPlay])

  // 聚焦后把这条路径推进画面（等 DOM 落定再量）
  useEffect(() => {
    if (focus === null) return
    const t = window.requestAnimationFrame(() => {
      const els = [...document.querySelectorAll<HTMLElement>('.lineage-pill.is-hi, .lineage-head[data-on="1"]')]
      canvasApi.current?.frame(els)
    })
    return () => window.cancelAnimationFrame(t)
  }, [focus])

  // Esc 退出聚焦
  useEffect(() => {
    if (focus === null && play === null) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') clearFocus() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, play, clearFocus])

  const playAll = useCallback(() => {
    if (data === null) return
    stopPlay()
    setFocus(null)
    setExpanded(new Set())
    PLAY_STEPS.forEach((s, i) => {
      timers.current.push(window.setTimeout(() => {
        setExpanded(new Set([s.key]))
        setPlay({ stage: s.key, msg: s.msg })
        canvasApi.current?.frameStage(s.key)
      }, i * 1100))
    })
    timers.current.push(window.setTimeout(() => {
      setPlay({ stage: 'marts', msg: '生产完成 · 指标取 marts 的度量列' })
      timers.current.push(window.setTimeout(() => {
        setExpanded(new Set())
        setPlay(null)
        canvasApi.current?.fitOverview()
      }, 1600))
    }, PLAY_STEPS.length * 1100))
  }, [data, stopPlay])

  // 换指标后把新图放回视口（画板只在挂载时自适应一次）
  useEffect(() => {
    if (data === null) return
    const t = window.setTimeout(() => canvasApi.current?.fitOverview(), 120)
    return () => window.clearTimeout(t)
  }, [data])

  // 布局变化后重算连线（开窗 / 展开 / 换指标）
  const layoutKey = useMemo(() => {
    const parts = [
      data?.metricId ?? '',
      [...expanded].sort().join(','),
      focus?.name ?? '',
      play?.stage ?? '',
    ]
    return parts.join('|')
  }, [data, expanded, focus, play])

  const hitsOf = useCallback((stage: StageKey): ReadonlySet<string> => {
    if (focus === null) return new Set()
    return stage === 'source' ? focus.source : stage === 'staging' ? focus.staging : stage === 'marts' ? focus.marts : focus.partitions
  }, [focus])

  const modeOf = useCallback((stage: StageKey): 'collapsed' | 'window' | 'full' => {
    if (play !== null) return play.stage === stage ? 'full' : 'collapsed'
    if (focus !== null && hitsOf(stage).size > 0) return expanded.has(stage) ? 'full' : 'window'
    return expanded.has(stage) ? 'full' : 'collapsed'
  }, [play, focus, hitsOf, expanded])

  const toggleStage = (stage: StageKey): void => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(stage)) next.delete(stage)
      else next.add(stage)
      return next
    })
  }

  // 旁白是「聚焦结果」的一句话读数，不是教程（DESIGN.md「界面不写教程」）
  const narr: { name?: string; mid: string; tail: string } | null = play !== null
    ? { mid: '', tail: play.msg }
    : focus === null
      ? null
      : focus.reverse
        ? {
            name: focus.name,
            mid: ' · 由 staging 的 ',
            tail: `${focus.staging.size} 列${focus.deps.length > 0 ? `（含 ${focus.deps.length} 个度量组合）` : ''}聚合而成`,
          }
        : {
            name: focus.name,
            mid: ' · 源字段 → ',
            tail: `${focus.staging.has(focus.name) ? 'staging 同名透传' : 'staging 不再保留'} → ${
              focus.marts.has(focus.name) ? 'marts 同名列'
                : focus.links.length > 0 ? `汇入 ${focus.links.length} 个聚合度量` : '未进入 marts'}`,
          }

  const card = (stage: StageKey): React.ReactNode => {
    if (data === null) return null
    const mode = modeOf(stage)
    const hits = hitsOf(stage)
    const active = hits.size > 0 && (focus !== null || play?.stage === stage)
    const meta = {
      source: { step: 1, title: '源接口 + 契约', sub: `${data.source.columns.length} 列 · ${data.source.contractId ?? '无契约'}` },
      lake: { step: 2, title: '湖（raw parquet）', sub: '按契约落盘，字段与源一致' },
      staging: { step: 3, title: 'staging（洗净对齐）', sub: `${data.staging.columns.length} 列${data.staging.model === null ? '' : ` · ${data.staging.model}`}` },
      marts: { step: 4, title: 'marts（业务成品）', sub: `${data.marts.columns.length} 列${data.marts.model === null ? '' : ` · ${data.marts.model}`}` },
    }[stage]

    // 开窗：只保留命中列上下各 3 行
    let visible: ReadonlySet<number> | undefined
    let gaps: ReadonlyArray<{ before: number; count: number }> = []
    if (mode === 'window') {
      const cols = stage === 'source' ? data.source.columns : stage === 'staging' ? data.staging.columns : data.marts.columns
      const idx = new Set<number>()
      cols.forEach((c, i) => { if (hits.has(c.name)) idx.add(i) })
      const w = windowOf(cols.length, idx, 3)
      visible = w.visible
      gaps = w.gaps
    }

    const total = stage === 'source' ? data.source.columns.length
      : stage === 'staging' ? data.staging.columns.length : data.marts.columns.length

    return (
      <div
        key={stage}
        className="lineage-card"
        data-stage-card={stage}
        data-active={active ? '1' : '0'}
      >
        <div className="lineage-head" data-on={active ? '1' : '0'}>
          <div className="lineage-num">0{meta.step}</div>
          <div>
            <div className="lineage-title">{meta.title}</div>
            <div className="lineage-sub">{meta.sub}</div>
          </div>
        </div>

        {stage === 'lake' ? (
          <div className="lineage-store">
            {data.lake === null ? (
              <div className="note">契约没声明 layout —— 落盘形态未知</div>
            ) : (
              <>
                <div className="row"><b>目录</b><span className="mono">{data.lake.prefix}/</span></div>
                {data.lake.partitions.map((p) => (
                  <div key={p} className={`row${hits.has(p) ? ' is-hi' : ''}`}>
                    <b>{p === data.lake?.partitions[0] ? '分区' : ''}</b>
                    <span className="mono">{p}=…</span>
                  </div>
                ))}
                <div className="row"><b>文件</b><span className="mono">{data.lake.fileName}</span></div>
                <div className="note">落盘即定型：分区键由路径推断，staging 再显式 cast 回契约类型。</div>
              </>
            )}
          </div>
        ) : (
          <Pills
            stage={stage}
            columns={stage === 'source' ? data.source.columns : stage === 'staging' ? data.staging.columns : data.marts.columns}
            hi={hits}
            visible={visible}
            gaps={gaps}
            keys={keys}
            skeletonOnly={mode === 'collapsed'}
            onPick={pick}
          />
        )}

        {stage !== 'lake' && (
          <span className="lineage-more" role="button" tabIndex={0}
                onClick={() => toggleStage(stage)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStage(stage) } }}>
            {mode === 'full' ? `收起，只看骨架 ${total} 列` : `展开全部 ${total} 列`}
          </span>
        )}
      </div>
    )
  }

  if (error !== null) {
    return (
      <Alert type="error" showIcon message={error.text} description={error.detail ?? error.code}
             action={<Button size="small" onClick={load}>重试</Button>} />
    )
  }
  if (data === null) {
    return (
      <div style={{ padding: '12px 4px' }}>
        <Skeleton active paragraph={{ rows: 6 }} title={false} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button type="primary" onClick={playAll}>▶ 播放生产流程</Button>
        {focus !== null && <Button onClick={clearFocus}>退出聚焦</Button>}
        {showTitle && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data.title}
            {data.notes.length > 0 && <Tag style={{ marginLeft: 8, borderRadius: 999 }}>缺声明 {data.notes.length} 处</Tag>}
          </Typography.Text>
        )}
      </div>

      <LineageCanvas
        focus={focus}
        layoutKey={layoutKey}
        height={height}
        onCanvasApi={(api) => { canvasApi.current = api }}
        onBlankClick={clearFocus}
        overlay={narr === null ? null : (
          <div className="lineage-narr">
            <span className="dot" />
            <span className="txt">
              {narr.name !== undefined && <b>{narr.name}</b>}
              {narr.mid}
              {narr.tail}
            </span>
            {focus !== null && <Button size="small" onClick={clearFocus}>退出聚焦</Button>}
          </div>
        )}
      >
        {STAGE_ORDER.map((s) => card(s))}
      </LineageCanvas>

      {data.notes.length > 0 && (
        <Alert type="info" showIcon message="生成说明" description={data.notes.join('；')} />
      )}
    </div>
  )
}

/** 没有指标时的空态（独立页与抽屉共用）。 */
export function LineageEmpty({ description }: { description: string }) {
  return <Empty description={description} />
}
