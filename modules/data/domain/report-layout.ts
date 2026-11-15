// report-layout.ts — 报表版式的**唯一实现**（2026-11-15，issue #2295）。
//
// 版式 = 面板顺序 + 宽度（span 1..24），无坐标、无重叠——路线图硬规则 5「版式走模板 + 槽位，
// 不做自由画布」的边界内扩展（设计：docs/superpowers/specs/2026-11-15-report-layout-editing-design.md）。
//
// 两处消费方必须同源（否则默认版式与个人版式会各自漂移）：
//   ① 服务端 `PUT /reports/:id/layout`：在**存储的原始 spec**（v1/v2）上原地改顺序与 span；
//   ② 前端 `ReportView`：把个人版式合并进观看面面板。
// 面板身份键只用于对齐版式，**不落进规格、不参与取数**。
import { parseStoredSpec } from './report-spec'

export interface LayoutItem {
  key: string
  span: number
}

/** 面板的最小形状（v1 面板与渲染面 ViewPanel 的共同子集）。 */
export interface LayoutPanelLike {
  chart?: string
  title?: string
  page?: number
  span?: number
}

export const MAX_LAYOUT_KEY = 200

export type LayoutErrorCode = 'LAYOUT_INVALID' | 'LAYOUT_STALE' | 'INVALID_SPEC'

/**
 * 面板身份键：`page|chart|title`；同名同图同页的重复面板按出现次序加 `#2`/`#3`。
 *
 * 为什么用标题而不是索引：索引会随「所有者换位」整体位移，个人版式会错位到别的面板上；
 * 标题/图型/页是**内容身份**——所有者改标题即视为版式过期（fail-safe：宁可重置，不错位）。
 * 为什么重复要加序号：同一份报表允许两个同名同图面板（不同 args），只靠裸键会撞车。
 */
export function layoutKeysOf(panels: readonly LayoutPanelLike[]): string[] {
  const seen = new Map<string, number>()
  return panels.map((p) => {
    const base = `${p.page ?? 1}|${p.chart ?? ''}|${p.title ?? ''}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  })
}

/** 当前面板的版式（编辑器打开时的初始值）。 */
export function layoutItemsOf(panels: readonly LayoutPanelLike[]): LayoutItem[] {
  const keys = layoutKeysOf(panels)
  return panels.map((p, i) => ({ key: keys[i], span: clampSpan(p.span ?? 12) }))
}

export function clampSpan(n: number): number {
  return Math.min(24, Math.max(1, Math.round(n)))
}

/** 入参校验（写路径与服务端共用）：返回 null = 不合法。不做静默截断。 */
export function validateLayoutItems(input: unknown): LayoutItem[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 24) return null
  const seen = new Set<string>()
  const out: LayoutItem[] = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) return null
    const item = raw as { key?: unknown; span?: unknown }
    if (typeof item.key !== 'string' || item.key.length === 0 || item.key.length > MAX_LAYOUT_KEY) return null
    if (typeof item.span !== 'number' || !Number.isInteger(item.span) || item.span < 1 || item.span > 24) return null
    if (seen.has(item.key)) return null
    seen.add(item.key)
    out.push({ key: item.key, span: item.span })
  }
  return out
}

export interface ReorderResult {
  /** 新顺序：元素是原数组下标。 */
  order: number[]
  /** 原下标 → 新 span。 */
  spans: Map<number, number>
}

/**
 * 把版式条目映射回面板下标。
 *
 * 规则：
 *  · 条目键集合必须与当前面板键**完全一致**（多重集相等），否则 LAYOUT_STALE；
 *  · 顺序只在**同页内**生效（跨页顺序由 `page` 归属决定，布局编辑不搬页）；
 *  · 页与页的相对次序保持原样（多页打印顺序不受影响）。
 */
function reorderPanels(panels: readonly LayoutPanelLike[], items: readonly LayoutItem[]): ReorderResult | null {
  const keys = layoutKeysOf(panels)
  if (keys.length !== items.length) return null
  const indexOfKey = new Map(keys.map((k, i) => [k, i]))
  const itemByKey = new Map(items.map((it) => [it.key, it]))
  if (itemByKey.size !== items.length) return null
  for (const k of keys) if (!itemByKey.has(k)) return null

  const spans = new Map<number, number>()
  // 每页一个队列：按条目顺序登记该页的下标。
  const queues = new Map<number, number[]>()
  for (const it of items) {
    const i = indexOfKey.get(it.key)
    if (i === undefined) return null
    spans.set(i, clampSpan(it.span))
    const page = panels[i].page ?? 1
    const q = queues.get(page) ?? []
    q.push(i)
    queues.set(page, q)
  }
  const cursors = new Map<number, number>()
  const order: number[] = []
  for (let i = 0; i < panels.length; i++) {
    const page = panels[i].page ?? 1
    const q = queues.get(page) ?? [i]
    const c = cursors.get(page) ?? 0
    order.push(q[c] ?? i)
    cursors.set(page, c + 1)
  }
  return { order, spans }
}

/**
 * 渲染面用：返回「渲染顺序（原下标）+ 各原下标的 span」；键不匹配 ⇒ null。
 *
 * 为什么给下标而不是重排数组：面板下标是服务端契约的一部分（`panelIndex` 要打回
 * `/receipt`、`/narrative`，服务端按规格下标取面板）。观看面只改**渲染次序与宽度**，
 * 取数与凭证调用必须继续用原下标。
 */
export function layoutOrderOf(
  panels: readonly LayoutPanelLike[], items: readonly LayoutItem[] | null | undefined,
): ReorderResult | null {
  if (items === null || items === undefined || items.length === 0) return null
  return reorderPanels(panels, items)
}

/** 合并进渲染面（前端）：键不匹配 ⇒ 原样返回并标 stale（调用方决定是否提示一次）。 */
export function applyLayoutToPanels<T extends LayoutPanelLike>(
  panels: readonly T[], items: readonly LayoutItem[] | null | undefined,
): { panels: T[]; stale: boolean } {
  if (items === null || items === undefined || items.length === 0) return { panels: [...panels], stale: false }
  const reordered = reorderPanels(panels, items)
  if (reordered === null) return { panels: [...panels], stale: true }
  const out = reordered.order.map((i) => {
    const span = reordered.spans.get(i)
    return (span === undefined ? panels[i] : { ...panels[i], span })
  })
  return { panels: out, stale: false }
}

function rawArrayOf(raw: unknown): { array: unknown[]; kind: 'panels' | 'blocks' } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const kind = o.ir === 2 ? 'blocks' : 'panels'
  const arr = o[kind]
  return Array.isArray(arr) ? { array: arr, kind } : null
}

/**
 * 在**存储的原始 spec** 上应用版式（服务端 `PUT /reports/:id/layout`）。
 *
 * 为什么服务端做而不是客户端改完 PUT /spec：`GET /spec` 回的是归一化 v1，
 * 客户端回写会把 v2 降级成 v1（丢失 datasets/IR 语义）。这里只在原数组上换顺序、改 span，
 * 其余字段逐字保留。
 *
 * 面板下标对齐的依据：`flattenReportSpecV2` 逐块产出一个 v1 面板（长度与顺序一致），
 * 因此「归一化面板下标」与「原始 panels/blocks 下标」一一对应。
 */
export function applyLayoutToRaw(
  raw: unknown, items: unknown,
): { ok: true; raw: Record<string, unknown> } | { ok: false; code: LayoutErrorCode } {
  const validated = validateLayoutItems(items)
  if (validated === null) return { ok: false, code: 'LAYOUT_INVALID' }
  const target = rawArrayOf(raw)
  if (target === null) return { ok: false, code: 'INVALID_SPEC' }
  const parsed = parseStoredSpec(raw)
  if (!parsed.ok) return { ok: false, code: 'INVALID_SPEC' }
  const panels = parsed.spec.panels as readonly LayoutPanelLike[]
  // 长度对齐是下标映射的前提；不对齐说明存储形态变了（防御性 fail-closed）。
  if (panels.length !== target.array.length) return { ok: false, code: 'INVALID_SPEC' }
  const reordered = reorderPanels(panels, validated)
  if (reordered === null) return { ok: false, code: 'LAYOUT_STALE' }

  const nextArray = reordered.order.map((i) => {
    const span = reordered.spans.get(i)
    return { ...(target.array[i] as Record<string, unknown>), ...(span === undefined ? {} : { span }) }
  })
  return { ok: true, raw: { ...(raw as Record<string, unknown>), [target.kind]: nextArray } }
}
