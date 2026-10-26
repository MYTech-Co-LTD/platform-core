// narrative.ts — AI 文本（`ai_text`）的生成核心：提示词 / 数字校验 / 确定性模板 / 缓存编排。
//
// 设计正典：`docs/superpowers/specs/2026-10-26-ai-narrative-component-design.md` §4.4–§7
// （计划 2026-10-26 Task 6）。三条硬约束，回退任一条前先回正典：
//
//  ① **数字只来自事实包**：模型输出里的每个数字都必须在 `facts.numbers`（+ 期间日期 + 小序号）
//     里；越界 ⇒ 流式发 `replace`（模板，`reason:'number_check'`）、JSON 带严格提示重生成一次。
//     最终都回退确定性模板 ⇒ **错数不留在屏幕上**，且永远不会空白。
//  ② **原始 reasoning 不外泄**：`completeStream` 的 `reasoning` 只用于「模型在动」的进度感，
//     一个字符都不进用户文本（spec §4.4：可能是英文/冗长/含中间算式）。
//  ③ **缓存内容寻址**：键 = (org, 报表, spec 快照, 面板, focus, 期间, 门店, factsHash,
//     提示词版本, 模型)。命中不调模型；同一份事实的模板结果同样写缓存（审计一行不落）。
//
// 流式与 JSON 的区别只有「校验时机」：SSE 已把内容流给用户，越界只能 `replace`（整段替换，
// 客户端不得拼接）；JSON 端点在返回前完整校验，允许一次带严格提示的重生成（spec §6）。
import type { Pool } from 'pg'
import type { StreamingChatModel } from './llm'
import type { FactBundle } from './report-facts'
import type { AiTextPanel } from './report-spec'
import {
  getCachedNarrative,
  putNarrative,
  type NarrativeKey,
} from './report-narrative-store'

/** 参与缓存键；**改提示词 = 升版本号**（旧缓存自然不再命中）。 */
export const NARRATIVE_PROMPT_VERSION = 'narrative-v1'

/** 与 spec §4.1 同形的 SSE 事件。`replace` 表示「已流出的内容作废」，客户端必须整段替换。 */
export type NarrativeEvent =
  | { type: 'phase'; phase: 'facts' | 'thinking' | 'writing'; label: string }
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string; reason: 'number_check' | 'llm_failed' }
  | {
      type: 'done'
      text: string
      fallback: boolean
      dataAsOf: string | null
      generatedAt: string
      cached: boolean
    }
  | { type: 'error'; reason: string }

export interface NarrativeResult {
  text: string
  fallback: boolean
  dataAsOf: string | null
  generatedAt: string
  cached: boolean
}

export interface NarrativeDeps {
  pool: Pool
  /** 隔离键 / 审计主体（宿主注入的权威值）。 */
  org: string
  reportId: string
  /** `published:3` / `draft:5`——缓存与审计的溯源维度。 */
  specKey: string
  panelIndex: number
  facts: FactBundle
  focus: AiTextPanel['focus']
  /** 生成人（`created_by`）。 */
  userId: string
  /** 未配 LLM ⇒ null（直接模板 + `fallback:true`，不是错误）。 */
  model: (StreamingChatModel & { id?: string }) | null
  /** 可选的日志缝（失败原因只进日志，不回显给前端）。 */
  log?: (message: string) => void
}

const SYSTEM = [
  '你是门店经营分析助手。只能使用 facts 中的数字和项目名；不得编造、不得做 facts 之外的算术；缺失写 "-"。',
  '输出三段，纯文本，不要 Markdown 表格/HTML：',
  '结论：…',
  '异常：…',
  '行动：…',
  '全文不超过 400 个汉字；末尾单独一行写：数据截至 <dataAsOf>（缺失写「新鲜度未知」）。',
  '不要推测外部原因（天气/竞品/促销），只写数据内可见的构成与需要核对的事项。',
].join('\n')

/**
 * 允许数字集合。**只收事实包里出现过的格式化值**（`facts.numbers` 已含期间日期），
 * 再按模型常见的书写变体归一化：
 *  · 去货币符号（facts 里本来就没有 `¥`，但模型爱写）
 *  · 去千分位逗号 / 去正号（模型常写 `1234` 或 `6.82`）
 *  · 去单位（模型有时只写数字不写 `%` / `pp`）
 * 小序号 `1/2/3` 与 `-` 是模板/行文固定写法，恒放行。
 */
export function allowedNumbers(facts: FactBundle): Set<string> {
  const out = new Set<string>(['1', '2', '3', '-'])
  for (const n of [...facts.numbers, ...facts.dates]) {
    out.add(n)
    const base = n.replace(/^¥/, '')
    // 「去逗号」「去正号」「去单位」两两组合都要能对上：模型不保证同时带或不带。
    for (const noComma of [base, base.replaceAll(',', '')]) {
      for (const noSign of [noComma, noComma.replace(/^\+/, '')]) {
        out.add(noSign)
        out.add(noSign.replace(/(%|pp)$/, ''))
      }
    }
  }
  return out
}

/** 与 `allowedNumbers` 的归一化口径对齐（逗号/正号在数字内部不改变值）。 */
function normalizeNum(s: string): string {
  return s.replaceAll(',', '').replace(/^\+/, '')
}

/**
 * 文本里的事实之外的数字。先把**完整日期与时间戳**整段抹掉：
 * `dataAsOf` 是定长北京时间串（`YYYY-MM-DD HH:mm:ss +08:00`），提示词要求模型原样抄到末行；
 * 不抹掉的话 `06:00:00 +08:00` 会被拆成 `06/00/08` 判越界 ⇒ 合规输出反而全被替换。
 */
export function badNumbers(text: string, allowed: Set<string>): string[] {
  const noDates = text.replace(
    /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:\s*(?:\+08:00|Z))?|\d{2}-\d{2}/g,
    ' ',
  )
  const out: string[] = []
  for (const m of noDates.matchAll(/-?\d[\d,]*(?:\.\d+)?(?:%|pp)?/g)) {
    const raw = m[0]
    if (!allowed.has(raw) && !allowed.has(normalizeNum(raw))) out.push(raw)
  }
  return out
}

function userPrompt(facts: FactBundle, strictNote = ''): string {
  return [
    `focus=${facts.focus}。请严格按 system 约束写三段。`,
    '重点：结论先销售额/订单/客单价与对比；异常写最低销售日、报损最大原因、费用最大两项（有数才写）；行动 2-3 条，带金额/项目名。',
    ...(strictNote === '' ? [] : [strictNote]),
    `facts=${JSON.stringify(facts)}`,
  ].join('\n')
}

/** 确定性模板：只用 facts 的格式化值，缺失项写 `-`（spec §6 逐字结构）。 */
export function templateOf(f: FactBundle): string {
  const k = (name: string) => f.kpis.find((x) => x.panel === name)
  const loss = f.breakdowns.find((b) => b.panel.includes('报损'))
  const expense = f.breakdowns.find((b) => b.panel.includes('费用'))
  const lossTop = loss?.rows[0]
  const expTop = expense?.rows.slice(0, 2).map((r) => r.label).join('、')
  return [
    `结论：本期销售额 ${k('销售额')?.current ?? '-'}，订单 ${k('订单数')?.current ?? '-'}，客单价 ${k('客单价')?.current ?? '-'}；会员销售占比 ${k('会员销售占比')?.current ?? '-'}。`,
    `异常：最低销售日 ${f.daily.min?.day ?? '-'}（${f.daily.min?.value ?? '-'}）；报损 ${k('报损金额')?.current ?? '-'}（${lossTop?.label ?? '-'} ${lossTop?.value ?? '-'}）；费用 ${k('费用合计（净费用）')?.current ?? k('费用合计')?.current ?? '-'}（${expTop ?? '-'}）。`,
    '行动：① 核对最低销售日是否采集缺口/闭店；② 复盘报损最大原因明细；③ 复盘费用最大两项的投放产出。',
    `数据截至 ${f.dataAsOf ?? '新鲜度未知'}。`,
  ].join('\n')
}

/** 缓存键：内容寻址。`branchNum=null` ⇒ `*`；未配模型 ⇒ `none`（模板结果也缓存）。 */
export function narrativeKeyOf(deps: NarrativeDeps): NarrativeKey {
  return {
    org: deps.org,
    reportId: deps.reportId,
    specKey: deps.specKey,
    panelIndex: deps.panelIndex,
    focus: deps.focus,
    periodKey: `${deps.facts.period.from}..${deps.facts.period.to}`,
    branchKey: deps.facts.branchNum ?? '*',
    factsHash: deps.facts.factsHash,
    promptVersion: NARRATIVE_PROMPT_VERSION,
    model: deps.model?.id ?? 'none',
  }
}

function doneEvent(
  text: string,
  fallback: boolean,
  facts: FactBundle,
  cached = false,
): NarrativeEvent {
  return {
    type: 'done',
    text,
    fallback,
    dataAsOf: facts.dataAsOf,
    generatedAt: new Date().toISOString(),
    cached,
  }
}

/** 把模板落缓存并返回最终结果（流式与 JSON 共用，保证「回退也留审计」）。 */
async function fallbackResult(
  deps: NarrativeDeps,
  key: NarrativeKey,
  log?: string,
): Promise<NarrativeResult> {
  const text = templateOf(deps.facts)
  await putNarrative(deps.pool, key, text, true, deps.userId)
  if (log !== undefined) deps.log?.(log)
  return {
    text,
    fallback: true,
    dataAsOf: deps.facts.dataAsOf,
    generatedAt: new Date().toISOString(),
    cached: false,
  }
}

/**
 * JSON 形态：缓存 → 模型（**最多两次**）→ 模板。
 * 第一次输出有越界数字或为空 ⇒ 带严格提示重生成一次；仍不过 ⇒ 模板 + `fallback:true`。
 * 模型异常（HTTP/超时/非 SSE）同样回退模板——**永远不空白**（spec §6）。
 */
export async function generateNarrative(deps: NarrativeDeps): Promise<NarrativeResult> {
  const key = narrativeKeyOf(deps)
  const cached = await getCachedNarrative(deps.pool, key)
  if (cached !== null) {
    return {
      text: cached.text,
      fallback: cached.fallback,
      dataAsOf: deps.facts.dataAsOf,
      generatedAt: cached.createdAt,
      cached: true,
    }
  }
  const model = deps.model
  if (model === null) return fallbackResult(deps, key)

  const allowed = allowedNumbers(deps.facts)
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = ''
    try {
      for await (const d of model.completeStream(
        [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: userPrompt(
              deps.facts,
              attempt === 0 ? '' : '上一次输出包含 facts 之外的数字；只允许复制 facts 的 formatted 值。',
            ),
          },
        ],
        [],
        { temperature: 0.2, maxTokens: 1500, signal: AbortSignal.timeout(30000) },
      )) {
        // reason 只用于进度感，不进正文（不读即不泄）
        if (d.content !== undefined) text += d.content
      }
    } catch (err) {
      deps.log?.(`narrative_llm_failed: ${err instanceof Error ? err.message : String(err)}`)
      text = ''
    }
    // 空输出与越界同罪：空白文本不能当成功缓存（spec §6「永远不空白」）
    if (text.trim() !== '' && badNumbers(text, allowed).length === 0) {
      await putNarrative(deps.pool, key, text, false, deps.userId)
      return {
        text,
        fallback: false,
        dataAsOf: deps.facts.dataAsOf,
        generatedAt: new Date().toISOString(),
        cached: false,
      }
    }
  }
  return fallbackResult(deps, key, 'narrative_number_check_failed')
}

/**
 * SSE 形态：`phase(facts)` 由路由在事实包完成前发；本函数从缓存/`phase(thinking)` 接手。
 *
 * 增量校验：维护「未闭合数字」缓冲，只在数字 token 闭合后校验，避免把跨 chunk 的
 * `51,2` 误判成 `51,2`。越界 ⇒ **立即 abort 模型**、`replace` 模板、再 `done`（状态收敛）。
 */
export async function* streamNarrative(
  deps: NarrativeDeps,
): AsyncGenerator<NarrativeEvent> {
  const key = narrativeKeyOf(deps)
  const cached = await getCachedNarrative(deps.pool, key)
  if (cached !== null) {
    yield { type: 'phase', phase: 'writing', label: '读取缓存' }
    yield { type: 'delta', text: cached.text }
    // `generatedAt` 是**原文生成时刻**（缓存行的 created_at），不是回放时刻——
    // 前端页脚「AI 分析 · 数据截至 X」旁边的时间指向的应是这条文本的出处。
    yield {
      type: 'done',
      text: cached.text,
      fallback: cached.fallback,
      dataAsOf: deps.facts.dataAsOf,
      generatedAt: cached.createdAt,
      cached: true,
    }
    return
  }

  yield { type: 'phase', phase: 'thinking', label: '正在分析…' }
  const model = deps.model
  if (model === null) {
    const text = templateOf(deps.facts)
    await putNarrative(deps.pool, key, text, true, deps.userId)
    yield doneEvent(text, true, deps.facts)
    return
  }

  const allowed = allowedNumbers(deps.facts)
  const controller = new AbortController()
  // 与 JSON 端点同一口径（spec §4.4：`signal=AbortSignal.timeout(30000)`）：
  // 模型卡住 ⇒ 超时 abort ⇒ catch 走模板，绝不让浏览器无限等。
  const timer = setTimeout(() => controller.abort(), 30000)
  let full = ''
  let pending = ''
  let sawContent = false
  // 终态只许一次：`return` 会触发 for-await 调底层 `return()`，若它抛错（连接已断的极端情形），
  // 外层 catch 不能再发一次 `replace`/`done`——客户端会看到两个 done。
  let settled = false
  try {
    for await (const d of model.completeStream(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(deps.facts) },
      ],
      [],
      { temperature: 0.2, maxTokens: 1500, signal: controller.signal },
    )) {
      if (d.content === undefined) continue // reasoning 不展示、也不拼进正文
      if (!sawContent) {
        sawContent = true
        yield { type: 'phase', phase: 'writing', label: '正在生成…' }
      }
      full += d.content
      pending += d.content
      // 只校验已闭合的数字：以数字/逗号/点结尾说明 token 可能还没完，留到下一块
      if (!/[0-9,.]$/.test(pending)) {
        const bad = badNumbers(pending, allowed)
        pending = ''
        if (bad.length > 0) {
          controller.abort()
          settled = true
          deps.log?.(`narrative_number_check: ${bad.join(',')}`)
          const text = templateOf(deps.facts)
          yield { type: 'replace', text, reason: 'number_check' }
          yield doneEvent(text, true, deps.facts)
          await putNarrative(deps.pool, key, text, true, deps.userId)
          return
        }
      }
      yield { type: 'delta', text: d.content }
    }
    // 流结束再全文校验一次（末块可能停在数字上，逐块校验覆盖不到）
    if (full.trim() === '' || badNumbers(full, allowed).length > 0) {
      settled = true
      deps.log?.('narrative_number_check_failed')
      const text = templateOf(deps.facts)
      yield { type: 'replace', text, reason: 'number_check' }
      yield doneEvent(text, true, deps.facts)
      await putNarrative(deps.pool, key, text, true, deps.userId)
      return
    }
    await putNarrative(deps.pool, key, full, false, deps.userId)
    settled = true
    yield doneEvent(full, false, deps.facts)
  } catch (err) {
    if (settled) return
    deps.log?.(`narrative_llm_failed: ${err instanceof Error ? err.message : String(err)}`)
    const text = templateOf(deps.facts)
    yield { type: 'replace', text, reason: 'llm_failed' }
    yield doneEvent(text, true, deps.facts)
    await putNarrative(deps.pool, key, text, true, deps.userId)
  } finally {
    clearTimeout(timer)
  }
}
