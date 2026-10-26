// report-facts.ts — AI 文本的**事实包**（计划 2026-10-26 Task 5；设计 spec §4.3）。
//
// 事实包是「AI 只能使用报表里已经有的数」这句约束的**机制落点**：模型看到的 facts JSON、
// 数字白名单 `numbers`、确定性模板替换的数值、缓存键里的 `factsHash`，全都由这里产出。
// 三条硬约束（回退任何一条前先回 spec §4.3 / 计划 Task 5）：
//
//  ① **只从报表自身的数据面板取数**（kpi / line / bar / table），且只经 `runQuery` ——
//     主体钉死、指标/维度/参数校验、掩码、审计与 `/query` 同源；**不新写 SQL 通道**。
//     `text` / `ai_text` 面板不是数据源（把它们跳掉，而不是「有字就抓」）。
//  ② **装配与渲染器同源**：args / query body / 对比段全部来自 `report-query` 的两个纯函数
//     （`panelArgsOf` / `panelQueryBodyOf` / `compareRangeOf`）。事实包与屏幕上的面板若各算
//     各的，模型说的数与用户看到的数迟早对不上，而且漂移是静默的。
//  ③ **数值不带货币符号**：facts 里是 `51,273.89` 而不是 `¥51,273.89`（spec §4.3 示例逐字如此，
//     currency 面板也一样）。卡片上的 `¥` 是展示装饰；文本里让模型/模板自然写
//     「销售额 51,273.89」。格式化本身仍走 `report-format`（两位小数、千分位、比率两位百分数），
//     只去掉符号前缀 —— 数字校验白名单与卡片文案因此是同一把尺。
//
// 失败语义：「拿不到」与「没数据」是两回事。查询失败（被拒/仓库错）⇒ 面板进 `missing`，
// 文本里省略或写 `-`；查询成功但合计为空 ⇒ 值写 `-`、**不进** missing（那是「本期没有」，
// 是事实；把两者混成一个 `-` 会让模型把「无数据」说成「报表缺了这块」）。
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { Requester, SlicingSpec, SliceOrderBy } from './authz'
import { runQuery, type QueryDeps, type SqlExecutor } from './query-service'
import { compareRangeOf, panelArgsOf, panelQueryBodyOf, type DataPanel } from './report-query'
import { periodRangeOf } from './report-period'
import { formatDelta, formatValue } from './report-format'
import type { AiTextPanel, KpiPanel, PeriodSpec, ReportSpec } from './report-spec'

export interface FactsDeps {
  pool: Pool
  /** 隔离键 / 审计主体（宿主注入的权威值，与 `/query` 同一个）。 */
  org: string
  /** 必须非空：事实包的每次取数都带身份走 `runQuery`（无身份 = 不取数）。 */
  requester: Requester
  /** 本租户已接入的源（与路由同源的裁剪输入；空集不是默认值，调用方必须显式给）。 */
  adoptedSources: ReadonlySet<string>
  /** 假仓库执行器（测试缝）；缺省 = 真仓库池。 */
  execute?: SqlExecutor
  /** 报表标题（进 facts、进提示词）。 */
  reportTitle: string
  /** 规格键（`published:3` / `draft:5`），缓存与审计的溯源维度。 */
  specKey: string
}

export interface FactKpi {
  panel: string
  metricId: string
  format: KpiPanel['format']
  /** 格式化后的当前值（货币不带 ¥；无数据 ⇒ `-`）。 */
  current: string
  /** 对比期同口径值；无对比段 / 取不到 ⇒ null（不是 `-`：缺席与「为零」可辨）。 */
  previous: string | null
  /** 相对变化率（比率型给 pp）；无法计算 ⇒ `-`。 */
  delta: string
}

export interface FactBreakdown {
  panel: string
  /** 分组维度（多维度用 `/` 连接，与行标签同一拼法）。 */
  dimension: string
  /** 按数值**降序**（模板说「最大原因」= rows[0]），行数上界见 `MAX_BREAKDOWN_ROWS`。 */
  rows: Array<{ label: string; value: string }>
}

export interface FactBundle {
  reportTitle: string
  specKey: string
  focus: AiTextPanel['focus']
  period: { from: string; to: string; label: string }
  branchNum: string | null
  /** 各查询 `data_as_of` 的**最早**值（保守）；全缺 ⇒ null（文本写「新鲜度未知」）。 */
  dataAsOf: string | null
  kpis: FactKpi[]
  breakdowns: FactBreakdown[]
  /** **第一个** line 面板的日最低/最高；没有 line 面板或取不到 ⇒ 两端 null。 */
  daily: { min: { day: string; value: string } | null; max: { day: string; value: string } | null }
  /** 取数失败（非「无数据」）的面板标题。 */
  missing: string[]
  /** 允许数字白名单：格式化值 + 期间日期（不含 `-`，也不含货币符号）。 */
  numbers: string[]
  /** 期间日期（`from` / `to`），既进白名单也单独给提示词用。 */
  dates: string[]
  /** 规范化 JSON 的 sha256 —— 缓存键的一部分：同一事实必须得到同一串。 */
  factsHash: string
}

/**
 * 拆解行的上界。facts 会整段进提示词：行数不设上限等于把提示词预算交给报表数据
 * （一张 `limit` 未声明的 table 面板可以回 MAX_QUERY_ROWS 行）。排序在截断**之前**做，
 * 故截掉的是尾部小值，模板要的「最大 N 项」永远在。
 */
const MAX_BREAKDOWN_ROWS = 20

/** 事实包里的数值：格式化结果去掉货币符号（spec §4.3 示例：currency 面板也是 `51,273.89`）。 */
export function factValue(v: number | null, format: KpiPanel['format']): string {
  return formatValue(v, format).replace(/^¥/, '')
}

/**
 * `dataAsOf` 取**最早**的非空值（spec §4.3「保守」）。呈现是定长北京时间串
 * `YYYY-MM-DD HH:mm:ss +08:00`（query-service 的唯一格式化器）⇒ 字典序即时间序。
 */
export function earliestDataAsOf(xs: readonly string[]): string | null {
  let min: string | null = null
  for (const x of xs) if (x !== '' && (min === null || x < min)) min = x
  return min
}

function queryDepsOf(deps: FactsDeps): QueryDeps {
  return {
    pool: deps.pool,
    execute: deps.execute,
    // 辅助读（data_as_of / 维度名称）与主计划走**同一个**执行缝：测试里假执行器两处都要认。
    warehouseExec: deps.execute,
    adoptedSources: deps.adoptedSources,
  }
}

/**
 * 面板 → `/query` 的形参。`panelQueryBodyOf` 产出的线上 body（`{metricId,args,slice…}`）
 * 在这里拆回 `runQuery(metricId, args, slicing)` 三个形参 —— 仍只有**一处**装配规则。
 */
function queryOfPanel(p: DataPanel, args: Record<string, unknown>): {
  args: Record<string, unknown>
  dims: string[]
  slicing: SlicingSpec | undefined
} {
  const body = panelQueryBodyOf(p, args)
  const dims = Array.isArray(body.dimensions) ? (body.dimensions as string[]) : []
  const slicing: SlicingSpec = {}
  // `dimensions: []` 是**显式合计**（语义与「没声明分组」不同），存在性判断而非长度判断。
  if (Array.isArray(body.dimensions)) slicing.dimensions = dims
  if (Array.isArray(body.orderBy)) slicing.orderBy = body.orderBy as SliceOrderBy[]
  if (typeof body.limit === 'number') slicing.limit = body.limit
  if (typeof body.total === 'boolean') slicing.total = body.total
  return {
    args: (body.args ?? {}) as Record<string, unknown>,
    dims,
    slicing: Object.keys(slicing).length === 0 ? undefined : slicing,
  }
}

interface ReadValue {
  /** 取数是否成功（false ⇒ 面板进 missing）；「成功但合计为空」是 ok + value null。 */
  ok: boolean
  value: number | null
  /** 本次取数携带的 data_as_of（成功才有）。 */
  asOf: string[]
}

/** 一次**显式合计**读（`args.total = true`）：合计值由授权核心的 `sum` 计划给出。 */
async function readTotal(
  deps: FactsDeps, metricId: string, args: Record<string, unknown>,
): Promise<ReadValue> {
  const out = await runQuery(queryDepsOf(deps), deps.org, deps.requester, metricId, args)
  if (out.status !== 'ok') return { ok: false, value: null, asOf: [] }
  const raw = out.total
  const n = raw === undefined || raw === null ? null : Number(raw)
  return {
    ok: true,
    value: n !== null && Number.isFinite(n) ? n : null,
    asOf: typeof out.data_as_of === 'string' ? [out.data_as_of] : [],
  }
}

/**
 * KPI 值。比率型（`denominatorMetricId`）**先各自合计再相除** —— 明细行求和/先除后加
 * 都会被 LIMIT 截断或口径错位污染；分母为 0 / 任一合计为空 ⇒ null（格式化后是 `-`）。
 */
async function readKpiValue(
  deps: FactsDeps, p: KpiPanel, totalArgs: Record<string, unknown>,
): Promise<ReadValue> {
  const num = await readTotal(deps, p.metricId, totalArgs)
  if (!num.ok || p.denominatorMetricId === undefined) return num
  const den = await readTotal(deps, p.denominatorMetricId, totalArgs)
  const asOf = [...num.asOf, ...den.asOf]
  if (!den.ok) return { ok: false, value: null, asOf }
  if (num.value === null || den.value === null || den.value === 0) {
    return { ok: true, value: null, asOf }
  }
  return { ok: true, value: num.value / den.value, asOf }
}

/**
 * 构建事实包。`panelIndex` 必须是 ai_text 面板（路由已先校验，这里是防御性断言）；
 * `period` 是**本次观看**的期间（可能来自 URL/筛选栏，不一定等于 spec.period）。
 */
export async function buildFacts(
  deps: FactsDeps,
  spec: ReportSpec,
  panelIndex: number,
  period: PeriodSpec,
  branchNum?: string,
): Promise<FactBundle> {
  const ai = spec.panels[panelIndex]
  if (ai === undefined || ai.chart !== 'ai_text') throw new Error('NOT_AI_TEXT_PANEL')

  const range = periodRangeOf(period, new Date())
  const dataPanels = spec.panels.filter(
    (p): p is DataPanel => p.chart !== 'text' && p.chart !== 'ai_text',
  )
  const dates = [range.from, range.to]
  const asOfList: string[] = []
  const kpis: FactKpi[] = []
  const breakdowns: FactBreakdown[] = []
  const missing: string[] = []
  let minRaw: { day: string; value: number } | null = null
  let maxRaw: { day: string; value: number } | null = null
  // 日趋势只认**第一个** line 面板：多个 line 面板混算会把不同指标（金额/件数/比率）
  // 的最低最高揉成一对不属于任何指标的值。报表顺序即声明顺序，作者可控。
  let dailyPanelSeen = false

  for (const p of dataPanels) {
    const args = panelArgsOf(p, range, branchNum)
    const q = queryOfPanel(p, args)

    if (p.chart === 'kpi') {
      const cur = await readKpiValue(deps, p, q.args)
      asOfList.push(...cur.asOf)
      if (!cur.ok) missing.push(p.title)

      // 对比段只对**期间型**面板有意义：`timeScoped === false` 的面板有自己固定的窗口
      // （字典 / 排行快照），拿报表期间的前移段去比是错口径；而且它的 args 里没有期间注入，
      // 强行塞 bizday 还会撞 unknown_param（被拒 → 对比恒缺，审计里多一条假拒绝）。
      const prevRange = compareRangeOf(p, period.mode, range)
      const prev = cur.ok && prevRange !== null && p.timeScoped !== false
        ? await readKpiValue(deps, p, { ...q.args, bizday: prevRange })
        : null
      if (prev !== null) asOfList.push(...prev.asOf)
      const prevValue = prev !== null && prev.ok ? prev.value : null

      kpis.push({
        panel: p.title,
        metricId: p.metricId,
        format: p.format,
        current: factValue(cur.value, p.format),
        previous: prevValue === null ? null : factValue(prevValue, p.format),
        delta: cur.value === null || prevValue === null
          ? '-' : formatDelta(cur.value, prevValue, p.format),
      })
      continue
    }

    const out = await runQuery(
      queryDepsOf(deps), deps.org, deps.requester, p.metricId, q.args, q.slicing,
    )
    if (out.status !== 'ok') { missing.push(p.title); continue }
    if (typeof out.data_as_of === 'string') asOfList.push(out.data_as_of)

    if (p.chart === 'line') {
      if (!dailyPanelSeen) {
        dailyPanelSeen = true
        const xIdx = q.dims.length === 0 ? -1 : out.columns.indexOf(q.dims[0]!)
        const vIdx = out.columns.indexOf('value')
        if (xIdx >= 0 && vIdx >= 0) {
          for (const row of out.rows) {
            const value = Number(row[vIdx])
            if (!Number.isFinite(value)) continue
            const day = String(row[xIdx])
            if (minRaw === null || value < minRaw.value) minRaw = { day, value }
            if (maxRaw === null || value > maxRaw.value) maxRaw = { day, value }
          }
        }
      }
      continue
    }

    // bar / table ⇒ 拆解。行标签 = 声明维度的值按 `/` 连接；无维度 ⇒ 单行即合计。
    const vIdx = out.columns.indexOf('value')
    const rows = out.rows.map((row) => {
      const label = q.dims.length === 0
        ? '合计'
        : q.dims.map((d) => String(row[out.columns.indexOf(d)] ?? '')).join(' / ')
      const value = vIdx < 0 ? NaN : Number(row[vIdx])
      return { label, value: Number.isFinite(value) ? value : null }
    })
    // 降序在截断之前：模板的「最大原因/最大两项」依赖 rows[0..n] 就是最大的那几项。
    const sortKey = (r: { value: number | null }): number =>
      r.value ?? -Number.MAX_SAFE_INTEGER
    rows.sort((a, b) => sortKey(b) - sortKey(a))
    breakdowns.push({
      panel: p.title,
      dimension: q.dims.join('/'),
      rows: rows.slice(0, MAX_BREAKDOWN_ROWS).map((r) => ({
        label: r.label,
        value: r.value === null ? '-' : factValue(r.value, 'number'),
      })),
    })
  }

  const daily: FactBundle['daily'] = {
    min: minRaw === null ? null : { day: minRaw.day, value: factValue(minRaw.value, 'currency') },
    max: maxRaw === null ? null : { day: maxRaw.day, value: factValue(maxRaw.value, 'currency') },
  }

  // 白名单只收**事实里出现过的格式化值**与期间日期：未格式化的变体（去千分位/去符号/去
  // 百分号）由 narrative 的 allowedNumbers 统一归一化推导 —— 白名单不在两处各维护一份。
  const numbers = new Set<string>(dates)
  const addNumber = (s: string | null): void => {
    if (s !== null && s !== '') numbers.add(s)
  }
  for (const k of kpis) {
    if (k.current !== '-') addNumber(k.current)
    if (k.previous !== null && k.previous !== '-') addNumber(k.previous)
    if (k.delta !== '-') addNumber(k.delta)
  }
  for (const b of breakdowns) for (const r of b.rows) if (r.value !== '-') addNumber(r.value)
  for (const d of [daily.min, daily.max]) if (d !== null) addNumber(d.value)

  const facts: Omit<FactBundle, 'factsHash'> = {
    reportTitle: deps.reportTitle,
    specKey: deps.specKey,
    focus: ai.focus,
    period: { from: range.from, to: range.to, label: `${range.from} ~ ${range.to}` },
    branchNum: branchNum ?? null,
    dataAsOf: earliestDataAsOf(asOfList),
    kpis,
    breakdowns,
    daily,
    missing,
    numbers: [...numbers],
    dates,
  }
  const factsHash = createHash('sha256').update(canonicalJson(facts)).digest('hex')
  return { ...facts, factsHash }
}

/**
 * 键序无关的 JSON（对象键递归排序）：`factsHash` 必须只由**内容**决定——上游若换了字段
 * 插入顺序（重构、展开运算符顺序）而内容不变，缓存不该失效；反之内容变一位必须换串。
 * 数组保持顺序（kpis/breakdowns 的顺序是报表声明顺序，属于内容的一部分）。
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}
