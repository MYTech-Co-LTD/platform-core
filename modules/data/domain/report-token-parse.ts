// report-token-parse.ts — 文本面板里的**语义内嵌 token** 语法（R3 / L2）。
//
// 语法（白名单，写侧与读侧共用这一份解析器）：
//   {{metric:<metricId>|window:<range|prev_period|prev_month|prev_year>|fmt:<currency|number|percent>}}
//   {{delta:<metricId>|vs:<prev_period|prev_month|prev_year>|fmt:<currency|number|percent>}}
//   {{as_of:<metricId>}}
//
// 纪律：
//  · token **只引用**、不定义口径：metricId 必须是报表 plan 里已出现过的指标（写侧校验）。
//  · 不合法（未闭合、未知类型/参数、空 id）一律**拒**，不把 `{{…}}` 当普通文本吞掉——
//    静默展示原文会让读者以为这是数字。
//  · 纯函数、零 IO；解析结果只描述「引用什么」，取值与格式化在 report-tokens.ts（服务端）。
import { z } from 'zod'

export const TOKEN_MAX_PER_TEXT = 20

export const TokenWindow = z.enum(['range', 'prev_period', 'prev_month', 'prev_year'])
export const TokenComparison = z.enum(['prev_period', 'prev_month', 'prev_year'])
export const TokenFormat = z.enum(['currency', 'number', 'percent'])

export interface MetricToken {
  kind: 'metric' | 'delta' | 'as_of'
  metricId: string
  /** metric 的取值窗口（缺省 range = 报表当前期间）。 */
  window?: z.infer<typeof TokenWindow>
  /** delta 的对比基准（缺省 prev_period）。 */
  vs?: z.infer<typeof TokenComparison>
  /** 值的格式（缺省 number；delta 的缺省同样是 number——比率指标请显式 fmt:percent）。 */
  fmt?: z.infer<typeof TokenFormat>
  /** 原文（审计/排错用）。 */
  raw: string
}

export type TokenParseResult =
  | { ok: true; tokens: MetricToken[] }
  | { ok: false; detail: string }

const METRIC_ID = /^[A-Za-z0-9_.:-]+$/

/** 解析一段文本里的全部 token。文本里没有 token ⇒ 空数组（合法）。 */
export function parseTokens(content: string): TokenParseResult {
  const re = /\{\{([^{}]*)\}\}/g
  const bodies: string[] = []
  let leftover = ''
  let last = 0
  for (const m of content.matchAll(re)) {
    leftover += content.slice(last, m.index)
    bodies.push(m[1] ?? '')
    last = m.index + m[0].length
  }
  leftover += content.slice(last)
  // 合法 token 挖掉后仍有 `{{`/`}}` ⇒ 未闭合或野生占位符：拒，不当普通文本吞掉。
  if (leftover.includes('{{') || leftover.includes('}}')) {
    return { ok: false, detail: '含未闭合的 {{ 或 }}' }
  }
  if (bodies.length > TOKEN_MAX_PER_TEXT) {
    return { ok: false, detail: `一段文本最多 ${TOKEN_MAX_PER_TEXT} 个引用` }
  }
  const out: MetricToken[] = []
  for (const body of bodies) {
    const parsed = parseTokenBody(body)
    if (!parsed.ok) return parsed
    out.push(parsed.token)
  }
  return { ok: true, tokens: out }
}

function parseTokenBody(body: string): { ok: true; token: MetricToken } | { ok: false; detail: string } {
  const segments = body.split('|')
  const head = segments[0] ?? ''
  const ci = head.indexOf(':')
  if (ci < 0) return { ok: false, detail: `引用缺少类型：{{${body}}}` }
  const kind = head.slice(0, ci).trim()
  const metricId = head.slice(ci + 1).trim()
  if (kind !== 'metric' && kind !== 'delta' && kind !== 'as_of') {
    return { ok: false, detail: `未知引用类型：${kind}` }
  }
  if (metricId === '' || !METRIC_ID.test(metricId)) {
    return { ok: false, detail: `指标 id 不合法：${metricId}` }
  }
  const params = new Map<string, string>()
  for (const seg of segments.slice(1)) {
    const i = seg.indexOf(':')
    if (i < 0) return { ok: false, detail: `参数缺少值：${seg}` }
    const key = seg.slice(0, i).trim()
    const value = seg.slice(i + 1).trim()
    if (params.has(key)) return { ok: false, detail: `参数重复：${key}` }
    params.set(key, value)
  }
  const allow = kind === 'metric' ? ['window', 'fmt'] : kind === 'delta' ? ['vs', 'fmt'] : []
  for (const key of params.keys()) {
    if (!allow.includes(key)) return { ok: false, detail: `${kind} 不支持参数：${key}` }
  }
  const token: MetricToken = { kind, metricId, raw: `{{${body}}}` }
  if (kind === 'metric') {
    const w = params.get('window')
    if (w !== undefined) {
      const parsed = TokenWindow.safeParse(w)
      if (!parsed.success) return { ok: false, detail: `window 取值不合法：${w}` }
      token.window = parsed.data
    }
  }
  if (kind === 'delta') {
    const vs = params.get('vs')
    if (vs !== undefined) {
      const parsed = TokenComparison.safeParse(vs)
      if (!parsed.success) return { ok: false, detail: `vs 取值不合法：${vs}` }
      token.vs = parsed.data
    }
  }
  const fmt = params.get('fmt')
  if (fmt !== undefined) {
    const parsed = TokenFormat.safeParse(fmt)
    if (!parsed.success) return { ok: false, detail: `fmt 取值不合法：${fmt}` }
    token.fmt = parsed.data
  }
  return { ok: true, token }
}

/**
 * 写侧校验：语法合法 **且** 每个引用的指标都在 `metricIds`（报表 plan 里出现过的指标）中。
 * 返回第一处问题的中文说明；`null` = 通过。
 */
export function tokenIssue(content: string, metricIds: ReadonlySet<string>): string | null {
  if (!content.includes('{{') && !content.includes('}}')) return null
  const parsed = parseTokens(content)
  if (!parsed.ok) return parsed.detail
  for (const token of parsed.tokens) {
    if (!metricIds.has(token.metricId)) return `引用的指标不在本报表里：${token.metricId}`
  }
  return null
}
