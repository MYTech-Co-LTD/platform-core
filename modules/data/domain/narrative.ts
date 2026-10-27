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
export const NARRATIVE_PROMPT_VERSION = 'narrative-v4'

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
  '数字必须逐字复制 facts.numbers 中的字符串（包括负号、千分位、百分号、小数位）；不得改写符号、去掉负号、取绝对值或做四舍五入。',
  '输出三段，纯文本，不要 Markdown 表格/HTML：',
  '结论：…',
  '异常：…',
  '行动：…',
  '日期一律写成 facts 里的 YYYY-MM-DD 形式（例如 2026-10-13），不要写「X月X日」。',
  '当前门店以 facts.branchName（缺省 branchNum）为准；reportTitle 只是报表登记标题，不得用于指代当前数据。',
  '费用按项目是净额：写净额合计；有负数明细时说明主要冲减项，不要把正向大项相加当合计。',
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
    // 「去逗号」「去正号」「去单位」「去尾零」组合都要能对上：模型不保证带哪一种。
    for (const noComma of [base, base.replaceAll(',', '')]) {
      for (const noSign of [noComma, noComma.replace(/^\+/, '')]) {
        out.add(noSign)
        const unitMatch = /(%|pp)$/.exec(noSign)
        const unit = unitMatch?.[1] ?? ''
        const bare = unit === '' ? noSign : noSign.slice(0, -unit.length)
        out.add(bare)
        out.add(normalizeNum(bare))
        // 单位保留的形态（5.10% 的模型常写 5.1%）
        out.add(normalizeNum(bare) + unit)
      }
    }
  }
  return out
}

/**
 * 与 `allowedNumbers` 的归一化口径对齐：逗号/正号不改变值；**小数尾零也不改变值**
 * （facts 的 `1,254.60` 与模型写的 `1,254.6` 必须判等，否则格式统一后会新增回退）。
 */
function normalizeNum(s: string): string {
  const t = s.replaceAll(',', '').replace(/^\+/, '')
  return /^-?\d*\.\d+$/.test(t) ? t.replace(/0+$/, '').replace(/\.$/, '') : t
}

/**
 * 文本里的事实之外的数字。先把**完整日期与时间戳**整段抹掉：
 * `dataAsOf` 是定长北京时间串（`YYYY-MM-DD HH:mm:ss +08:00`），提示词要求模型原样抄到末行；
 * 不抹掉的话 `06:00:00 +08:00` 会被拆成 `06/00/08` 判越界 ⇒ 合规输出反而全被替换。
 */
export function badNumbers(text: string, allowed: Set<string>): string[] {
  // 日期形态整段抹掉：ISO / 中文全日期与年份（2026年10月13日、2026年、2026年度）/
  // 中文月日与单月（10月13日、10月）/ 日号时分（10日、10号、10 时、10:30）/
  // 点号或斜杠日期（2026.10.21、2026/10/21）/ **裸年份**（1900–2099 的独立 4 位数，
  // 如「2026 10月21日」「2026 全年」）。中文形态是 #1083/#1107 的现场根因；空格/省写是
  // 模型常见的排版。裸年份用 lookaround 排除小数/长数字。
  const noDates = text.replace(
    /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:\s*(?:\+08:00|Z))?|\d{4}\s*年(?:\s*度|\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?)?|\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?|\d{1,2}\s*[日号时点分秒]|\d{1,2}:\d{2}(?::\d{2})?|\d{4}[./]\d{1,2}[./]\d{1,2}|\d{2}-\d{2}|(?<![\d.,])(?:19|20)\d{2}(?![\d.,])/g,
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
    '重点：结论首句写当前门店（branchName，缺省 branchNum），再写销售额/订单/客单价与对比；异常写最低销售日、报损最大原因、费用最大正向项与主要冲减项（有负数才写）；行动 2-3 条，带金额/项目名。',
    ...(facts.hasData ? [] : ['facts.hasData=false：只写一句「该期间门店无有效数据（未接入或未物化）」，不要写异常/行动。']),
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
  const expRows = expense?.rows ?? []
  const numOf = (s: string): number => Number(s.replaceAll(',', ''))
  const expTop = expRows.slice(0, 2).map((r) => r.label).join('、')
  // 费用是**净额**：有负数明细时必须写主要冲减项，否则读者会把正向大项相加当合计（#1085）。
  const negTop = expRows
    .filter((r) => Number.isFinite(numOf(r.value)) && numOf(r.value) < 0)
    .sort((a, b) => numOf(a.value) - numOf(b.value))[0]
  // 当前门店：优先名称，其次编号；**不用 reportTitle**（切店后它仍是登记时那家店）。
  const branchLabel = f.branchNum === null
    ? ''
    : `门店 ${f.branchNum}${f.branchName === null ? '' : `（${f.branchName}）`}，`
  const asOfLine = `数据截至 ${f.dataAsOf ?? '新鲜度未知'}。`
  if (!f.hasData) {
    return [`结论：${branchLabel}该期间无有效数据（未接入或未物化）。`, asOfLine].join('\n')
  }
  // 缺数据时不输出空括号：`-（）` / `-（- -）` 只会让回退文本更像故障（#1083）。
  const withDetail = (base: string, detail: string): string =>
    detail === '' ? base : `${base}（${detail}）`
  const minText = f.daily.min === null ? '-' : `${f.daily.min.day}（${f.daily.min.value}）`
  const lossDetail = lossTop === undefined ? '' : `${lossTop.label} ${lossTop.value}`
  const expDetail = [
    expTop,
    negTop === undefined ? '' : `冲减 ${negTop.label} ${negTop.value}`,
  ].filter((s) => s !== '').join('；')
  return [
    `结论：${branchLabel}本期销售额 ${k('销售额')?.current ?? '-'}，订单 ${k('订单数')?.current ?? '-'}，客单价 ${k('客单价')?.current ?? '-'}；会员销售占比 ${k('会员销售占比')?.current ?? '-'}。`,
    `异常：最低销售日 ${minText}；${withDetail(`报损 ${k('报损金额')?.current ?? '-'}`, lossDetail)}；${withDetail(`费用 ${k('费用合计（净费用）')?.current ?? k('费用合计')?.current ?? '-'}`, expDetail)}。`,
    '行动：① 核对最低销售日是否采集缺口/闭店；② 复盘报损最大原因明细；③ 复盘费用最大两项的投放产出。',
    asOfLine,
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

// ── 同事实的单飞（in-process single-flight，#1105）────────────────────────────
//
// 同一条缓存键（org/报表/快照/面板/期间/门店/factsHash/prompt/模型）并发观看时，
// 只让**一个**请求调模型；其余请求 await 同一份结果再回放。
//  · 范围是**单进程**：platform-core 的 server 是单容器；跨实例需要 DB/Redis 租约
//    （未做，见 issue #1105 的「不在本轮」）。
//  · 失败/客户端中断也必须 settle（用模板兜底）——否则等待者会永久挂起。
interface SharedNarrative { text: string; fallback: boolean }

const inflightNarratives = new Map<string, Promise<SharedNarrative>>()

/** 缓存键的稳定字符串（顺序固定，避免 JSON 键序带来的伪不同）。 */
function keyStringOf(k: NarrativeKey): string {
  return [k.org, k.reportId, k.specKey, k.panelIndex, k.focus, k.periodKey,
    k.branchKey, k.factsHash, k.promptVersion, k.model].join('\u0000')
}

function beginShared(k: NarrativeKey): {
  promise: Promise<SharedNarrative>
  settle: (v: SharedNarrative) => void
} {
  let settle!: (v: SharedNarrative) => void
  const promise = new Promise<SharedNarrative>((resolve) => { settle = resolve })
  inflightNarratives.set(keyStringOf(k), promise)
  return { promise, settle }
}

/** 测试钩子：清空单飞表（用例之间避免互相等待）。 */
export function resetNarrativeInflight(): void {
  inflightNarratives.clear()
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
  cache = true,
): Promise<NarrativeResult> {
  const text = templateOf(deps.facts)
  // 有模型时的失败回退**不落缓存**：一次瞬时失败/格式偏差不能钉死同一事实的后续观看
  // （#1083）；未配模型（model=null）才缓存模板——那没有「下次重试」可言。
  if (cache) await putNarrative(deps.pool, key, text, true, deps.userId)
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

  // 同事实并发：等先到者的结果，不再调一次模型（单飞）。
  const sharedKey = keyStringOf(key)
  const shared = inflightNarratives.get(sharedKey)
  if (shared !== undefined) {
    const r = await shared
    return {
      text: r.text,
      fallback: r.fallback,
      dataAsOf: deps.facts.dataAsOf,
      generatedAt: new Date().toISOString(),
      cached: true,
    }
  }
  const flight = beginShared(key)
  let settled = false
  const settleOnce = (v: SharedNarrative): void => {
    if (settled) return
    settled = true
    flight.settle(v)
  }
  try {
    const allowed = allowedNumbers(deps.facts)
    let lastLog = 'narrative_number_check_failed'
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
                attempt === 0 ? '' : '上一次输出包含 facts 之外的数字；只允许复制 facts 的 formatted 值，日期写 YYYY-MM-DD。',
              ),
            },
          ],
          [],
          { temperature: 0, maxTokens: 1500, signal: AbortSignal.timeout(30000) },
        )) {
          // reason 只用于进度感，不进正文（不读即不泄）
          if (d.content !== undefined) text += d.content
        }
      } catch (err) {
        lastLog = `narrative_llm_failed: ${err instanceof Error ? err.message : String(err)}`
        deps.log?.(lastLog)
        text = ''
      }
      // 空输出与越界同罪：空白文本不能当成功缓存（spec §6「永远不空白」）
      const bad = text.trim() === '' ? [] : badNumbers(text, allowed)
      if (text.trim() !== '' && bad.length === 0) {
        await putNarrative(deps.pool, key, text, false, deps.userId)
        settleOnce({ text, fallback: false })
        return {
          text,
          fallback: false,
          dataAsOf: deps.facts.dataAsOf,
          generatedAt: new Date().toISOString(),
          cached: false,
        }
      }
      if (bad.length > 0) {
        lastLog = 'narrative_number_check_failed'
        deps.log?.(`narrative_number_check: ${bad.join(',')}`)
      }
    }
    const fb = await fallbackResult(deps, key, lastLog, false)
    settleOnce({ text: fb.text, fallback: fb.fallback })
    return fb
  } finally {
    // 异常 / 提前返回也必须 settle：等待者不能永久挂起。
    if (!settled) settleOnce({ text: templateOf(deps.facts), fallback: true })
    inflightNarratives.delete(sharedKey)
  }
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

  const model = deps.model
  if (model === null) {
    yield { type: 'phase', phase: 'thinking', label: '正在分析…' }
    const text = templateOf(deps.facts)
    await putNarrative(deps.pool, key, text, true, deps.userId)
    yield doneEvent(text, true, deps.facts)
    return
  }

  // 同事实并发：等待先到者，完成后整段回放（不再调模型）。
  const sharedKey = keyStringOf(key)
  const shared = inflightNarratives.get(sharedKey)
  if (shared !== undefined) {
    yield { type: 'phase', phase: 'writing', label: '等待同一事实的生成…' }
    const r = await shared
    yield { type: 'delta', text: r.text }
    yield doneEvent(r.text, r.fallback, deps.facts, true)
    return
  }
  const flight = beginShared(key)
  let settled = false
  const settleOnce = (v: SharedNarrative): void => {
    if (settled) return
    settled = true
    flight.settle(v)
  }
  try {
  yield { type: 'phase', phase: 'thinking', label: '正在分析…' }

  const allowed = allowedNumbers(deps.facts)
  // 与 JSON 端点对齐：数字校验失败重试一次（#1083 现场模型写「10月13日」被误判越界）。
  // 模型**异常**不重试——瞬时故障走模板，避免 2×30s 长挂。
  const MAX_ATTEMPTS = 2
  let lastReason: 'number_check' | 'llm_failed' = 'number_check'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // 第一遍可能已向客户端吐过正文：整段清空，否则两遍文本会拼在一起。
      yield { type: 'replace', text: '', reason: 'number_check' }
      yield { type: 'phase', phase: 'thinking', label: '正在重新核对数字…' }
    }
    const controller = new AbortController()
    // 与 JSON 端点同一口径（spec §4.4：`signal=AbortSignal.timeout(30000)`）：
    // 模型卡住 ⇒ 超时 abort ⇒ catch 走模板，绝不让浏览器无限等。
    const timer = setTimeout(() => controller.abort(), 30000)
    let full = ''
    let pending = ''
    let sawContent = false
    let failed: 'number_check' | 'llm_failed' | null = null
    try {
      for await (const d of model.completeStream(
        [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: userPrompt(
              deps.facts,
              attempt === 0 ? '' : '上一次输出包含 facts 之外的数字；只允许复制 facts 的 formatted 值，日期写 YYYY-MM-DD。',
            ),
          },
        ],
        [],
        { temperature: 0, maxTokens: 1500, signal: controller.signal },
      )) {
        if (d.content === undefined) continue // reasoning 不展示、也不拼进正文
        if (!sawContent) {
          sawContent = true
          yield { type: 'phase', phase: 'writing', label: '正在生成…' }
        }
        full += d.content
        pending += d.content
        // 只校验已闭合的数字：以数字/逗号/点/空白结尾说明 token 可能还没完
        // （空白后可能接「年/月/日/时」——模型会把日期写成「10 月 21 日」），留到下一块。
        if (!/[0-9,.\s]$/.test(pending)) {
          const bad = badNumbers(pending, allowed)
          pending = ''
          if (bad.length > 0) {
            controller.abort()
            failed = 'number_check'
            deps.log?.(`narrative_number_check: ${bad.join(',')}`)
            break
          }
        }
        yield { type: 'delta', text: d.content }
      }
      // 流结束再全文校验一次（末块可能停在数字上，逐块校验覆盖不到）
      if (failed === null && (full.trim() === '' || badNumbers(full, allowed).length > 0)) {
        failed = 'number_check'
        deps.log?.(`narrative_number_check_failed: ${badNumbers(full, allowed).join(',')}`)
      }
    } catch (err) {
      failed = 'llm_failed'
      deps.log?.(`narrative_llm_failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
    if (failed === null) {
      await putNarrative(deps.pool, key, full, false, deps.userId)
      settleOnce({ text: full, fallback: false })
      yield doneEvent(full, false, deps.facts)
      return
    }
    lastReason = failed
    if (failed === 'llm_failed') break
  }
  const text = templateOf(deps.facts)
  settleOnce({ text, fallback: true })
  yield { type: 'replace', text, reason: lastReason }
  yield doneEvent(text, true, deps.facts)
  // 有模型时回退**不落缓存**：下一次观看重新尝试，瞬时失败不再钉死整天（#1083）。
  } finally {
    // 客户端中断 / 异常：等待者不能永久挂起（用模板兜底）。
    if (!settled) settleOnce({ text: templateOf(deps.facts), fallback: true })
    inflightNarratives.delete(sharedKey)
  }
}
