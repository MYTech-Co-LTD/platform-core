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
import { buildRootCause, type RootCauseBundle } from './report-root-cause'
import { buildDailyReview, DAILY_REVIEW_METRICS, type DailyReviewBundle, type RootCauseDetail } from './report-daily-review'
import type { ToolboxDeps } from './toolbox/registry'
import {
  compareRangeOf, comparisonCovered, coverageArgsOf, coverageOfQueryResult, coverageSlicing,
  panelArgsOf, panelQueryBodyOf, type CoverageInfo, type DataPanel,
} from './report-query'
import { periodRangeOf } from './report-period'
import { analystPool, runWarehouseSqlParams } from './warehouse'
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
  /** 参数化只读执行器（根因探针的 explore_recipe 用；测试缝）；缺省 = analystPool。 */
  exploreExec?: ToolboxDeps['exploreExec']
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
  /**
   * 当前门店名（#1085）：从 `/query` 结果的 `branch_name` 维度列捕获。
   * **不能用 `reportTitle` 代替**——切门店后报表登记标题仍是创建时那家店。
   */
  branchName: string | null
  /** KPI / 拆解 / 日极值是否至少有一个有效值（全无 ⇒ 空态，不编行动建议）。 */
  hasData: boolean
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
  /**
   * 根因探针结果（`root_cause`，或 `daily_review` 营业额环比为负时；其余情况 null）。
   * 数字已并入 `numbers`；narrative 只把它当事实，不重新查数。
   */
  analysis: RootCauseBundle | null
  /**
   * 日报经营体检（仅 `focus='daily_review'`；其余 focus 恒 null）。
   * 数字已并入 `numbers`；三基线/净毛利/MTD 都在这里预计算好。
   */
  dailyReview: DailyReviewBundle | null
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
 * 从 `/query` 回包捕获当前门店名（#1085）。明细形态的查询会由 dimension-labels 追加
 * `branch_name` / `branch_num` 列；只认与请求的 `branchNum` 一致的那一行（多行时不会串店）。
 * 取不到（聚合形态 / 无数据）⇒ null，调用方回落到 branchNum。
 */
export function branchNameOf(
  out: { columns: readonly string[]; rows: readonly unknown[][] },
  branchNum?: string,
): string | null {
  const nameIdx = out.columns.indexOf('branch_name')
  if (nameIdx < 0) return null
  const numIdx = out.columns.indexOf('branch_num')
  for (const row of out.rows) {
    if (branchNum !== undefined && numIdx >= 0 && String(row[numIdx]) !== branchNum) continue
    const name = row[nameIdx]
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  }
  return null
}

/**
 * 日极值里的「日」归一成 `YYYY-MM-DD`（#1083）。
 *
 * pg 的 `date` 列经 node-pg 回来是 **Date 对象**（不是 ISO 串）——`String(Date)` 会得到
 * `Tue Oct 13 2026 00:00:00 GMT+0000 (…)`，模板会把它原样打给用户，模型也会看到这串英文。
 * node-pg 按**本地日历日**解析 `date`（`new Date(y, m-1, d)`），所以取本地分量而不是
 * `toISOString()`——后者在东八区会把 10-13 零点漂成 10-12。
 */
export function dayLabelOf(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
    return m === null ? null : m[1]!
  }
  return null
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

/** 覆盖探测结果：覆盖区间 + 顺带捕获的门店名（#1085）。 */
interface CoverageProbe {
  coverage: CoverageInfo | null
  /** 同一次明细查询顺带捕获的门店名（#1085）；取不到 ⇒ null。 */
  branchName: string | null
}

/**
 * 对比的数据覆盖度（issue #1078）：走 `/query` 的**明细形态** + `bizday asc` + LIMIT 1，
 * 第一行即最早有数日；水位取回包的 `watermark`（数据完整到哪天）。
 *
 * 为什么必须判覆盖：对比期只被覆盖一部分时**也会得数**，于是算出假环比（现场：9-12..30 的
 * 对比期，零售只有 9-23 起）。探测失败 / 空集 ⇒ null，调用方不出对比——宁可不出，不出假数。
 */
async function coverageOf(
  deps: FactsDeps, metricId: string, args: Record<string, unknown>,
): Promise<CoverageProbe> {
  const probeArgs = coverageArgsOf(args)
  const out = await runQuery(
    queryDepsOf(deps), deps.org, deps.requester, metricId, probeArgs, coverageSlicing(),
  )
  if (out.status !== 'ok') return { coverage: null, branchName: null }
  const branch = typeof probeArgs.branch_num === 'string' ? probeArgs.branch_num : undefined
  return { coverage: coverageOfQueryResult(out), branchName: branchNameOf(out, branch) }
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
const WEATHER_BASE = process.env['WEATHER_API_BASE'] ?? 'https://api.open-meteo.com'
const WEATHER_LAT = process.env['WEATHER_LAT'] ?? '25.60'
const WEATHER_LON = process.env['WEATHER_LON'] ?? '103.82'

/** WMO weather code → 中文描述（只用于背景陈述，不推断因果）。 */
function weatherCondition(code: number): string {
  if (code === 0) return '晴'
  if (code <= 3) return '多云'
  if (code === 45 || code === 48) return '雾'
  if (code >= 51 && code <= 57) return '毛毛雨'
  if (code >= 61 && code <= 67) return '雨'
  if (code >= 71 && code <= 77) return '雪'
  if (code >= 80 && code <= 82) return '阵雨'
  if (code >= 85 && code <= 86) return '阵雪'
  if (code >= 95) return '雷雨'
  return `天气码 ${code}`
}

interface WeatherDayJson { day: string; tempMax: string; tempMin: string; precipitation: string; condition: string }

async function fetchWeather(targetDay: string, yesterdayDay: string): Promise<{
  target: WeatherDayJson; yesterday: WeatherDayJson | null; source: string; note: string
} | null> {
  const url = (base: string): string => {
    const u = new URL('/v1/forecast', base)
    if (base.includes('archive-api')) u.pathname = '/v1/archive'
    u.searchParams.set('latitude', WEATHER_LAT)
    u.searchParams.set('longitude', WEATHER_LON)
    u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode')
    u.searchParams.set('start_date', yesterdayDay)
    u.searchParams.set('end_date', targetDay)
    u.searchParams.set('timezone', 'Asia/Shanghai')
    return u.toString()
  }
  const parse = (raw: unknown): WeatherDayJson[] => {
    const daily = (raw as { daily?: Record<string, unknown[]> } | null)?.daily
    if (daily === undefined) return []
    const times = daily['time'] as string[] | undefined
    const tmax = daily['temperature_2m_max'] as number[] | undefined
    const tmin = daily['temperature_2m_min'] as number[] | undefined
    const precip = daily['precipitation_sum'] as number[] | undefined
    const code = daily['weathercode'] as number[] | undefined
    if (times === undefined || tmax === undefined || tmin === undefined || precip === undefined || code === undefined) return []
    return times.map((day, i) => ({
      day,
      tempMax: `${Number(tmax[i]).toFixed(1)}°C`,
      tempMin: `${Number(tmin[i]).toFixed(1)}°C`,
      precipitation: `${Number(precip[i]).toFixed(1)}mm`,
      condition: weatherCondition(Number(code[i])),
    }))
  }
  for (const base of [WEATHER_BASE, 'https://archive-api.open-meteo.com']) {
    try {
      const res = await fetch(url(base), { signal: AbortSignal.timeout(6000) })
      if (!res.ok) continue
      const days = parse(await res.json())
      const target = days.find((d) => d.day === targetDay)
      if (target === undefined) continue
      return {
        target,
        yesterday: days.find((d) => d.day === yesterdayDay) ?? null,
        source: base.includes('archive') ? 'Open-Meteo Archive' : 'Open-Meteo',
        note: '天气为格点近似，不是门店实测；只作背景解释，不推断因果。',
      }
    } catch {
      // 天气 fail-open：取不到就不写，不阻断日报。
    }
  }
  return null
}

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
  // 指标格式：bar/table/line 面板本身不声明 format；同名 KPI 的 format 是作者的口径声明，
  // 用它来格式化拆解值与日极值（否则金额会丢尾零：1,254.6 / 1,136）。无同名 KPI ⇒ number。
  const formatByMetric = new Map<string, KpiPanel['format']>()
  for (const panel of spec.panels) {
    if (panel.chart === 'kpi' && !formatByMetric.has(panel.metricId)) {
      formatByMetric.set(panel.metricId, panel.format)
    }
  }
  let dailyFormat: KpiPanel['format'] = 'number'

  // 同一 (metricId, args) 的覆盖探测在本事实包内只查一次：8 张 KPI 会复用同一批指标
  // （销售额既是「销售额」也是客单价/会员占比的分母）。
  const coverageCache = new Map<string, Promise<CoverageProbe>>()
  const coverageFor = (metricId: string, args: Record<string, unknown>): Promise<CoverageProbe> => {
    const key = `${metricId}\u0000${canonicalJson(coverageArgsOf(args))}`
    let p = coverageCache.get(key)
    if (p === undefined) {
      p = coverageOf(deps, metricId, args)
      coverageCache.set(key, p)
    }
    return p
  }
  // 当前门店名：只从查询回包的维度列里取；同一个事实包内捕获一次即可。
  // **只在本次观看明确了门店（branchNum）时捕获**——多店视图取第一行会张冠李戴。
  // 用对象承载：闭包里的赋值不会被 TS 的控制流分析跟踪（直接 let 会被窄化成 null）。
  const branchInfo: { name: string | null } = { name: null }
  const captureBranch = (name: string | null): void => {
    if (branchNum === undefined) return
    if (branchInfo.name === null && name !== null) branchInfo.name = name
  }

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
      // 对比期**整段**落在数据覆盖内才做对比（issue #1078）：只判「查询得数」会把
      // 部分覆盖算成完整环比（9-12..30 只覆盖 8/19 天也照样出百分比）。
      const prevRange = compareRangeOf(p, period.mode, range)
      let prev: ReadValue | null = null
      if (cur.ok && prevRange !== null && p.timeScoped !== false) {
        const numCov = await coverageFor(p.metricId, q.args)
        const denCov = p.denominatorMetricId === undefined
          ? null
          : await coverageFor(p.denominatorMetricId, q.args)
        captureBranch(numCov.branchName)
        captureBranch(denCov?.branchName ?? null)
        const covered = comparisonCovered(prevRange, numCov.coverage)
          && (p.denominatorMetricId === undefined || comparisonCovered(prevRange, denCov?.coverage ?? null))
        if (covered) prev = await readKpiValue(deps, p, { ...q.args, bizday: prevRange })
      }
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
    captureBranch(branchNameOf(out, branchNum))
    if (typeof out.data_as_of === 'string') asOfList.push(out.data_as_of)

    if (p.chart === 'line') {
      if (!dailyPanelSeen) {
        dailyPanelSeen = true
        dailyFormat = formatByMetric.get(p.metricId) ?? 'number'
        const xIdx = q.dims.length === 0 ? -1 : out.columns.indexOf(q.dims[0]!)
        const vIdx = out.columns.indexOf('value')
        if (xIdx >= 0 && vIdx >= 0) {
          for (const row of out.rows) {
            const value = Number(row[vIdx])
            if (!Number.isFinite(value)) continue
            const day = dayLabelOf(row[xIdx])
            if (day === null) continue // 取不到可信的日历日 ⇒ 不拿它进极值（不编）
            if (minRaw === null || value < minRaw.value) minRaw = { day, value }
            if (maxRaw === null || value > maxRaw.value) maxRaw = { day, value }
          }
        }
      }
      continue
    }

    // 无 `slice` 的 bar/table 是**原始 grain 明细**（旧规格形态），不是语义拆解：
    // 直接跳过。否则会按「显式合计」把每行标成「合计」（#1093 现场：连续无业绩天数
    // 19 行全 0、6 列明细），既污染提示词也没有信息量。
    if (p.slice === undefined) continue

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
        value: r.value === null ? '-' : factValue(r.value, formatByMetric.get(p.metricId) ?? 'number'),
      })),
    })
  }

  const daily: FactBundle['daily'] = {
    min: minRaw === null ? null : { day: minRaw.day, value: factValue(minRaw.value, dailyFormat) },
    max: maxRaw === null ? null : { day: maxRaw.day, value: factValue(maxRaw.value, dailyFormat) },
  }

  // 白名单只收**事实里出现过的格式化值**与期间日期：未格式化的变体（去千分位/去符号/去
  // 百分号）由 narrative 的 allowedNumbers 统一归一化推导 —— 白名单不在两处各维护一份。
  const numbers = new Set<string>(dates)
  // 门店号是文本要引用的**事实**（提示词要求写当前门店）；不放进白名单的话，模型写
  // 「85」会被数字校验判成越界 ⇒ 好文本被模板替换（#1085 回归点）。
  if (branchNum !== undefined) numbers.add(branchNum)
  // 门店名里的数字同样是专名的一部分（如「测试99店」），不是数据主张。
  if (branchInfo.name !== null) for (const d of branchInfo.name.match(/\d+/g) ?? []) numbers.add(d)
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

  const dataAsOf = earliestDataAsOf(asOfList)
  const kpiArgs = spec.panels.find((p) => p.chart === 'kpi')
  const reportSystemBook = kpiArgs !== undefined && typeof kpiArgs.args?.['system_book'] === 'string'
    ? kpiArgs.args['system_book'] : null
  // 根因探针只在 `focus='root_cause'` 时跑：overview 的既有行为/缓存键一字不动。
  // 探针只走 `runDetailQuery` / `executeExplore`（与 /query、下钻、分析师面同一授权链）。
  let analysis = ai.focus === 'root_cause'
    ? await buildRootCause(
        {
          pool: deps.pool, org: deps.org, requester: deps.requester,
          adoptedSources: deps.adoptedSources, execute: deps.execute,
          branchNum: branchNum ?? null,
          systemBook: reportSystemBook,
          ...(deps.exploreExec === undefined ? {} : { exploreExec: deps.exploreExec }),
        },
        spec, range, period.mode,
        { kpis, breakdowns, daily, dataAsOf },
      )
    : null
  if (analysis !== null) {
    for (const n of analysis.numbers) if (n !== '' && n !== '-') numbers.add(n)
  }
  // 日报目标日/三基线/净毛利/MTD：只在 daily_review 时跑；走同一 runQuery 通道。
  const dailyReview = ai.focus === 'daily_review'
    ? await buildDailyReview({
        spec, period, range,
        ...(branchNum === undefined ? {} : { branchNum }),
        readWeather: fetchWeather,
        readSeries: async (metricId, args) => {
          const out = await runQuery(
            queryDepsOf(deps), deps.org, deps.requester, metricId, args,
            { dimensions: ['bizday'], orderBy: [{ column: 'bizday', dir: 'asc' }], limit: 1000 },
          )
          if (out.status !== 'ok') return null
          return {
            columns: out.columns,
            rows: out.rows,
            dataAsOf: typeof out.data_as_of === 'string' ? out.data_as_of : null,
          }
        },
      })
    : null
  if (dailyReview !== null) {
    for (const n of dailyReview.numbers) if (n !== '' && n !== '-') numbers.add(n)
    // 日报也带根因：营业额环比为负时复用有界探针（单日、同店），输出维度/明细证据。
    const revDelta = dailyReview.comparisons.yesterday?.delta.revenue
      ?? dailyReview.comparisons.mtdAvg.delta.revenue
    if (revDelta.startsWith('-')) {
      const prev = dailyReview.comparisons.yesterday?.baseline
        ?? dailyReview.comparisons.mtdAvg.baseline
      const syntheticKpis: FactKpi[] = []
      for (const p of spec.panels) {
        if (p.chart !== 'kpi') continue
        const isAov = p.metricId === DAILY_REVIEW_METRICS.revenue
          && p.denominatorMetricId === DAILY_REVIEW_METRICS.orders
        if (p.metricId === DAILY_REVIEW_METRICS.revenue || isAov) {
          syntheticKpis.push({
            panel: p.title, metricId: p.metricId, format: p.format,
            current: isAov ? dailyReview.today.aov : dailyReview.today.revenue,
            previous: isAov ? prev.aov : prev.revenue,
            delta: isAov ? dailyReview.comparisons.yesterday?.delta.aov ?? '-'
              : dailyReview.comparisons.yesterday?.delta.revenue ?? '-',
          })
        } else if (p.metricId === DAILY_REVIEW_METRICS.orders) {
          syntheticKpis.push({
            panel: p.title, metricId: p.metricId, format: p.format,
            current: dailyReview.today.orders, previous: prev.orders,
            delta: dailyReview.comparisons.yesterday?.delta.orders ?? '-',
          })
        } else if (p.metricId === DAILY_REVIEW_METRICS.gross) {
          syntheticKpis.push({
            panel: p.title, metricId: p.metricId, format: p.format,
            current: dailyReview.today.gross, previous: prev.gross,
            delta: dailyReview.comparisons.yesterday?.delta.gross ?? '-',
          })
        }
      }
      analysis = await buildRootCause(
        {
          pool: deps.pool, org: deps.org, requester: deps.requester,
          adoptedSources: deps.adoptedSources, execute: deps.execute,
          branchNum: branchNum ?? null,
          systemBook: reportSystemBook,
          skipDegenerate: true,
          extraMetrics: [{ metricId: 'lemeng:retail:item_profit', metricTitle: '零售商品毛利', format: 'currency' }],
          ...(deps.exploreExec === undefined ? {} : { exploreExec: deps.exploreExec }),
        },
        spec,
        { from: dailyReview.targetDay, to: dailyReview.targetDay },
        'day',
        {
          kpis: syntheticKpis,
          breakdowns: [],
          daily: {
            min: { day: dailyReview.targetDay, value: dailyReview.today.revenue },
            max: { day: dailyReview.targetDay, value: dailyReview.today.revenue },
          },
          dataAsOf: earliestDataAsOf(asOfList),
        },
      )
      if (analysis !== null) {
        for (const n of analysis.numbers) if (n !== '' && n !== '-') numbers.add(n)
        // 商品维度的 finding 行只有 item_num；补一次名称映射，避免模型把内部编码当商品名输出
        // （2026-11-10 实测：次一级商品全写成「商品 312005897」）。只查当日同店同账套，有界。
        if (branchNum !== undefined && reportSystemBook !== null) {
          const itemFindings = analysis.findings.filter((f) => f.dimension === 'item_num')
          const codes = [...new Set(itemFindings.flatMap((f) => f.rows.map((r) => r.label)))]
          if (codes.length > 0) {
            try {
              const out = await runWarehouseSqlParams(
                analystPool(),
                `select item_num::text as item_num, any_value(item_name) as item_name
                   from fct_retail_item_profit
                  where system_book = $1::int and branch_num = $2::int and bizday = $3
                    and item_num::text = any($4::text[])
                  group by item_num`,
                [reportSystemBook, branchNum, dailyReview.targetDay, codes],
              )
              const nameOf = new Map<string, string>()
              for (const r of out.rows) {
                const rec = Object.fromEntries(out.columns.map((c, i) => [c, r[i]]))
                const num = typeof rec['item_num'] === 'string' ? rec['item_num'] : ''
                const name = typeof rec['item_name'] === 'string' ? rec['item_name'] : ''
                if (num !== '' && name !== '') nameOf.set(num, name)
              }
              for (const f of itemFindings) {
                for (const row of f.rows) {
                  const name = nameOf.get(row.label)
                  if (name !== undefined) {
                    row.rawLabel = row.label
                    row.label = `${name}（${row.label}）`
                    // 商品名自带数字（如「沙琪玛260g」）必须进白名单，否则模型照抄名称会被判越界。
                    for (const m of name.match(/\d+/g) ?? []) {
                      numbers.add(m)
                      analysis.numbers.push(m)
                    }
                  }
                }
              }
            } catch {
              // 名称是增强项；取不到就保留编码，不影响主分析。
            }
          }
        }
        const top = analysis.findings.find((f) => (f.kind === 'variance' || f.kind === 'top') && f.rows.length > 0)
        const row = top?.rows[0]
        // 建议放在商品拆解之后再加：item_num 要先解析成商品名，不能把内部编码直接抛给读者。
        const pushRootCauseSuggestion = (label: string): void => {
          if (top === undefined || row === undefined) return
          if (dailyReview.suggestions.some((s) => s.includes(row.label))) return
          const delta = row.delta === undefined ? '' : `，变化 ${row.delta}`
          dailyReview.suggestions.unshift(`针对根因 ${label}（${row.value}${delta}），核对销量、售价与成本构成`)
          dailyReview.suggestions.splice(3)
        }
        // 商品根因拆解：只对同店、单账套、有 item_num 的 finding 跑一条定点查询。
        if (top?.dimension === 'item_num' && row !== undefined && branchNum !== undefined
          && reportSystemBook !== null && dailyReview.yesterday !== null) {
          const itemCode = row.rawLabel ?? row.label
          try {
            const out = await runWarehouseSqlParams(
              analystPool(),
              `select bizday::text as day, item_name, sale_num::text as qty,
                      sale_money_no_coupon::text as revenue, sale_cost::text as cost
                 from fct_retail_item_profit
                where system_book = $1::int and branch_num = $2::int and item_num = $3::int
                  and bizday in ($4, $5)`,
              [reportSystemBook, branchNum, itemCode, dailyReview.yesterday, dailyReview.targetDay],
            )
            const byDay = new Map<string, Record<string, unknown>>()
            for (const r of out.rows) {
              const rec = Object.fromEntries(out.columns.map((c, i) => [c, r[i]]))
              if (typeof rec['day'] === 'string') byDay.set(rec['day'], rec)
            }
            const cur = byDay.get(dailyReview.targetDay)
            const prev = byDay.get(dailyReview.yesterday)
            const qtyOf = (x: Record<string, unknown> | undefined): number => Number(x?.['qty'] ?? 0)
            const numOf = (x: Record<string, unknown> | undefined, k: string): number => Number(x?.[k] ?? 0)
            const qtyT = qtyOf(cur), qtyP = qtyOf(prev)
            const revT = numOf(cur, 'revenue'), revP = numOf(prev, 'revenue')
            const costT = numOf(cur, 'cost'), costP = numOf(prev, 'cost')
            if (cur !== undefined && prev !== undefined && qtyT >= 0 && qtyP >= 0) {
              const priceT = qtyT > 0 ? revT / qtyT : null
              const priceP = qtyP > 0 ? revP / qtyP : null
              const unitCostT = qtyT > 0 ? costT / qtyT : null
              const unitCostP = qtyP > 0 ? costP / qtyP : null
              const profitT = revT - costT
              const profitP = revP - costP
              const deltaProfit = profitT - profitP
              const volumeEffect = priceP !== null && unitCostP !== null ? (qtyT - qtyP) * (priceP - unitCostP) : null
              const priceEffect = priceT !== null && priceP !== null ? (priceT - priceP) * qtyT : null
              const costEffect = unitCostT !== null && unitCostP !== null ? -(unitCostT - unitCostP) * qtyT : null
              const name = typeof cur['item_name'] === 'string' && cur['item_name'] !== '' ? cur['item_name'] : null
              const money = (v: number | null): string => v === null ? '-' : formatValue(v, 'currency').replace(/^¥/, '')
              const qty = (v: number): string => formatValue(v, 'number')
              const itemLabel = name === null ? `商品 ${itemCode}` : `${name}（${itemCode}）`
              pushRootCauseSuggestion(itemLabel)
              let summary: string
              if (qtyT === 0 && qtyP > 0) {
                summary = `${itemLabel} 当天无销售（昨天 ${qty(qtyP)} 件），毛利减少 ${money(Math.abs(deltaProfit))}；重点核对缺货/下架/漏单`
              } else if (volumeEffect !== null && Math.abs(volumeEffect) >= Math.abs(priceEffect ?? 0) && Math.abs(volumeEffect) >= Math.abs(costEffect ?? 0)) {
                summary = `${itemLabel} 主要因销量 ${qty(qtyP)}→${qty(qtyT)}（销量效应 ${money(volumeEffect)}），毛利减少 ${money(Math.abs(deltaProfit))}`
              } else if (priceEffect !== null && Math.abs(priceEffect) >= Math.abs(costEffect ?? 0)) {
                summary = `${itemLabel} 主要因单价 ${money(priceP)}→${money(priceT)}（价格效应 ${money(priceEffect)}），毛利减少 ${money(Math.abs(deltaProfit))}`
              } else {
                summary = `${itemLabel} 主要因单位成本 ${money(unitCostP)}→${money(unitCostT)}（成本效应 ${money(costEffect)}），毛利减少 ${money(Math.abs(deltaProfit))}`
              }
              const detail: RootCauseDetail = {
                itemNum: itemCode,
                itemName: name,
                day: dailyReview.targetDay,
                prevDay: dailyReview.yesterday,
                qtyToday: qty(qtyT),
                qtyPrev: qty(qtyP),
                priceToday: money(priceT),
                pricePrev: money(priceP),
                costToday: money(unitCostT),
                costPrev: money(unitCostP),
                profitDelta: money(deltaProfit),
                volumeEffect: money(volumeEffect),
                priceEffect: money(priceEffect),
                costEffect: money(costEffect),
                summary,
              }
              dailyReview.rootCauseDetail = detail
              for (const v of [detail.qtyToday, detail.qtyPrev, detail.priceToday, detail.pricePrev,
                detail.costToday, detail.costPrev, detail.profitDelta, detail.volumeEffect,
                detail.priceEffect, detail.costEffect]) {
                if (v !== '-' && v !== '') numbers.add(v)
              }
            }
          } catch {
            // 商品拆解是增强项；取不到不影响主日报。
          }
        }
        // 拆解没跑成（非商品维度 / 缺门店 / 查询失败）时退回编码级建议；
        // 已按商品名加过（上面）则这里的 includes 会命中并跳过。
        if (top !== undefined && row !== undefined) {
          pushRootCauseSuggestion(
            top.dimension === 'item_num'
              ? (row.rawLabel !== undefined ? row.label : `商品 ${row.label}`)
              : `${top.dimension} ${row.label}`,
          )
        }
      }
    }
  }

  // 「有没有数据」是事实，不是推断。注意**全 0 的合成序列不算数据**：无业绩门店的
  // 「连续无业绩天数」仍会返回逐日 0 行（实测店 91 有 31 行 0）；只看「有行」会把空店
  // 判成有数据。判据：KPI 本期值 / 日极值 / 非零拆解行 / 根因探针行，任一存在即有数据。
  const nonZero = (s: string): boolean => {
    const n = Number(s.replaceAll(',', ''))
    return Number.isFinite(n) && n !== 0
  }
  const hasData =
    kpis.some((k) => k.current !== '-') ||
    breakdowns.some((b) => b.rows.some((r) => nonZero(r.value))) ||
    daily.min !== null || daily.max !== null ||
    (analysis?.findings.some((f) => f.rows.length > 0) ?? false) ||
    (dailyReview !== null && dailyReview.today.revenue !== '-')

  const facts: Omit<FactBundle, 'factsHash'> = {
    reportTitle: deps.reportTitle,
    specKey: deps.specKey,
    focus: ai.focus,
    period: { from: range.from, to: range.to, label: `${range.from} ~ ${range.to}` },
    branchNum: branchNum ?? null,
    branchName: branchInfo.name,
    hasData,
    dataAsOf,
    kpis,
    breakdowns,
    daily,
    missing,
    numbers: [...numbers],
    dates,
    analysis,
    dailyReview,
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
