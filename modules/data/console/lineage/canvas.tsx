// canvas.tsx — 数据生产线的画板：四段横排 + 无限画布（拖拽 / 缩放 / 适应）+ 聚焦连线。
//
// 连线不在 React 状态里画（元素位置随折叠/开窗变化），而是在布局稳定后从 DOM 量：
// 用 offsetLeft/offsetTop 累加到 world 的**局部坐标**，缩放时不用重算。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import type { FocusModel } from './focus'

export interface StageRect { x: number; y: number; cy: number; right: number; height: number }

export interface CanvasApi {
  /** 把某条路径推进画面（聚焦时） */
  frame: (elements: HTMLElement[]) => void
  /** 四段全貌 */
  fitOverview: () => void
  /** 播放时推近某一层 */
  frameStage: (stageKey: string) => void
  zoomBy: (factor: number) => void
  reset: () => void
}

interface Props {
  focus: FocusModel | null
  /** 布局变化后重算连线的触发值（展开/开窗/换指标） */
  layoutKey: string
  onCanvasApi: (api: CanvasApi) => void
  /** 点空白处 */
  onBlankClick: () => void
  children: React.ReactNode
}

const MIN_K = 0.35
const MAX_K = 2.4

export default function LineageCanvas(props: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [paths, setPaths] = useState<Array<{ d: string; kind: 'pass' | 'agg' | 'drop' }>>([])

  const apply = useCallback((next: { x: number; y: number; k: number }) => setView(next), [])

  /** 世界局部坐标：沿 offsetParent 链累加（缩放不影响这套坐标）。 */
  const local = useCallback((el: HTMLElement): StageRect => {
    const world = worldRef.current
    let x = 0
    let y = 0
    // happy-dom 没有 offsetParent（undefined）⇒ 用 undefined 兜底，别拿它当 HTMLElement 用
    let cur: HTMLElement | null | undefined = el
    while (cur !== null && cur !== undefined && cur !== world) {
      x += cur.offsetLeft ?? 0
      y += cur.offsetTop ?? 0
      cur = cur.offsetParent as HTMLElement | null | undefined
    }
    const h = el.offsetHeight
    return { x, y, cy: y + h / 2, right: x + el.offsetWidth, height: h }
  }, [])

  // 程序化移动带缓动；拖拽/滚轮不加（避免手感发黏）
  const [smooth, setSmooth] = useState(false)
  const animate = useCallback((next: { x: number; y: number; k: number }) => {
    setSmooth(true)
    apply(next)
    window.setTimeout(() => setSmooth(false), 460)
  }, [apply])

  const fitOverview = useCallback(() => {
    const vp = viewportRef.current
    const world = worldRef.current
    if (vp === null || world === null) return
    const w = world.scrollWidth
    const h = world.scrollHeight
    if (w === 0 || h === 0) return
    const k = Math.min((vp.clientWidth - 24) / w, (vp.clientHeight - 24) / h, 1)
    const kk = Math.max(MIN_K, k)
    animate({ x: Math.max(8, (vp.clientWidth - w * kk) / 2), y: 16, k: kk })
  }, [animate])

  const frame = useCallback((elements: HTMLElement[]) => {
    const vp = viewportRef.current
    if (vp === null || elements.length === 0) return
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const el of elements) {
      const r = local(el)
      x1 = Math.min(x1, r.x)
      y1 = Math.min(y1, r.y)
      x2 = Math.max(x2, r.right)
      y2 = Math.max(y2, r.y + r.height)
    }
    const pad = 56
    const bw = x2 - x1 + pad * 2
    const bh = y2 - y1 + pad * 2
    const k = Math.max(0.5, Math.min(1, (vp.clientWidth - 16) / bw, (vp.clientHeight - 16) / bh))
    animate({
      k,
      x: (vp.clientWidth - bw * k) / 2 - (x1 - pad) * k,
      y: bh * k < vp.clientHeight * 0.72 ? 40 : (vp.clientHeight - bh * k) / 2 - (y1 - pad) * k,
    })
  }, [animate, local])

  const frameStage = useCallback((stageKey: string) => {
    const vp = viewportRef.current
    const world = worldRef.current
    if (vp === null || world === null) return
    const st = world.querySelector<HTMLElement>(`[data-stage-card="${stageKey}"]`)
    if (st === null) return
    const rowTop = Math.min(...[...world.querySelectorAll<HTMLElement>('[data-stage-card]')]
      .map((el) => local(el).y - el.offsetHeight / 2))
    const ww = world.scrollWidth - 32
    const hh = local(st).y + st.offsetHeight / 2 - rowTop
    const k = Math.max(0.5, Math.min(1, (vp.clientWidth - 24) / ww, (vp.clientHeight - 24) / hh))
    animate({ k, x: (vp.clientWidth - ww * k) / 2 - 16 * k, y: 36 })
  }, [animate, local])

  const zoomBy = useCallback((factor: number) => {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
      const vp = viewportRef.current
      const cx = (vp?.clientWidth ?? 0) / 2
      const cy = (vp?.clientHeight ?? 0) / 2
      return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) }
    })
  }, [])

  // 把画板能力交给页面一次（用 ref 取回调，避免父组件重渲染再触发一次 effect）
  const apiSinkRef = useRef(props.onCanvasApi)
  apiSinkRef.current = props.onCanvasApi
  useEffect(() => {
    apiSinkRef.current({ frame, fitOverview, frameStage, zoomBy, reset: () => setView({ x: 0, y: 0, k: 1 }) })
  }, [frame, fitOverview, frameStage, zoomBy])

  // 首次拿到数据后适应画布
  useEffect(() => {
    const t = window.setTimeout(fitOverview, 120)
    return () => window.clearTimeout(t)
  }, [fitOverview])

  // 连线：只画聚焦路径。数据来自 DOM，所以布局稳定后再量。
  useLayoutEffect(() => {
    const world = worldRef.current
    if (world === null) return
    const build = (): void => {
      const f = props.focus
      if (f === null) { setPaths([]); return }
      const at = (stage: string, name: string): StageRect | null => {
        const el = world.querySelector<HTMLElement>(
          `[data-stage-card="${stage}"] [data-field="${CSS.escape(name)}"]`,
        )
        return el === null ? null : local(el)
      }
      const curve = (a: StageRect, b: StageRect): string => {
        const dx = Math.max(26, (b.x - a.right) * 0.42)
        return `M${a.right} ${a.cy} C${a.right + dx} ${a.cy},${b.x - dx} ${b.cy},${b.x - 4} ${b.cy}`
      }
      const out: Array<{ d: string; kind: 'pass' | 'agg' | 'drop' }> = []
      for (const name of f.source) {
        const from = at('source', name)
        if (from === null) continue
        if (!f.staging.has(name)) { out.push({ d: `M${from.right} ${from.cy} l 30 0`, kind: 'drop' }); continue }
        const to = at('staging', name)
        if (to !== null) out.push({ d: curve(from, to), kind: 'pass' })
      }
      // staging → marts 同名直通（键列在两层之间也要有线）
      for (const name of f.staging) {
        if (!f.marts.has(name)) continue
        const a = at('staging', name)
        const b = at('marts', name)
        if (a !== null && b !== null) out.push({ d: curve(a, b), kind: 'pass' })
      }
      for (const [from, to] of f.links) {
        const a = at('staging', from)
        const b = at('marts', to)
        if (a !== null && b !== null) out.push({ d: curve(a, b), kind: 'agg' })
      }
      // 度量 → 度量：同一列里绕右侧连接（组合关系，别和左侧扇入混在一起）
      for (const [from, to] of f.deps) {
        const a = at('marts', from)
        const b = at('marts', to)
        if (a === null || b === null) continue
        const xo = Math.max(a.right, b.right) + 14
        out.push({
          d: `M${a.right + 2} ${a.cy} C${xo} ${a.cy},${xo} ${b.cy},${b.right + 2} ${b.cy}`,
          kind: 'pass',
        })
      }
      setPaths(out)
    }
    build()
    const onResize = (): void => build()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [props.focus, props.layoutKey, local])

  // 滚轮缩放：React 的 onWheel 在部分浏览器是 passive，自己挂一个非 passive 的
  useEffect(() => {
    const vp = viewportRef.current
    if (vp === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.0012)))
        return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) }
      })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [])

  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)

  return (
    <div
      ref={viewportRef}
      className="lineage-viewport"
      data-focus={props.focus === null ? '0' : '1'}
      data-testid="lineage-canvas"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        // 卡片里的可点元素不参与拖拽：setPointerCapture 会把 pointerup 改派给画布，
        // 后续 click 就落不到字段上（2026-11-15 实测「字段点不了」）。
        if ((e.target as HTMLElement).closest('[data-field],button,[role="button"]')) return
        dragRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = dragRef.current
        if (d === null) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
        setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
      }}
      onPointerUp={(e) => {
        const d = dragRef.current
        dragRef.current = null
        if (d !== null && !d.moved && e.target === e.currentTarget) props.onBlankClick()
      }}
      style={{
        position: 'relative', overflow: 'hidden', cursor: 'grab', userSelect: 'none',
        height: 'calc(100vh - 268px)', minHeight: 520,
        border: '1px solid #EBEDF0', borderRadius: 12, background: '#FAFBFC',
        backgroundImage: 'radial-gradient(#E6E8EC 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', gap: 6, zIndex: 3 }}>
        <Tooltip title="把四段完整放回视口">
          <Button size="small" onClick={fitOverview}>适应画布</Button>
        </Tooltip>
        <Button size="small" onClick={() => zoomBy(1 / 1.2)}>－</Button>
        <span style={{ fontSize: 11.5, color: '#9AA0A6', alignSelf: 'center', minWidth: 38, textAlign: 'center' }}>
          {Math.round(view.k * 100)}%
        </span>
        <Button size="small" onClick={() => zoomBy(1.2)}>＋</Button>
      </div>

      <div
        ref={worldRef}
        className={smooth ? 'lineage-world smooth' : 'lineage-world'}
        style={{
          position: 'absolute', left: 0, top: 0, padding: '16px 16px 84px',
          display: 'flex', gap: 12, alignItems: 'flex-start', width: 'max-content',
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
          transition: smooth ? 'transform .46s cubic-bezier(.22,.8,.2,1)' : undefined,
        }}
      >
        <svg
          aria-hidden
          style={{
            position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
            pointerEvents: 'none', overflow: 'visible', zIndex: 2,
          }}
        >
          <defs>
            <marker id="lineage-arw" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="#4D6BFE" />
            </marker>
            <marker id="lineage-arw-agg" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="#0FA958" />
            </marker>
            <marker id="lineage-arw-drop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" fill="#E5484D" />
            </marker>
          </defs>
          {paths.map((p, i) => (
            <path
              key={i}
              className="lineage-edge"
              d={p.d}
              data-kind={p.kind}
              fill="none"
              stroke={p.kind === 'agg' ? '#0FA958' : p.kind === 'drop' ? '#E5484D' : '#4D6BFE'}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeDasharray={p.kind === 'drop' ? '3 4' : '5 8'}
              markerEnd={p.kind === 'agg' ? 'url(#lineage-arw-agg)' : p.kind === 'drop' ? 'url(#lineage-arw-drop)' : 'url(#lineage-arw)'}
            />
          ))}
        </svg>
        {props.children}
      </div>
    </div>
  )
}
