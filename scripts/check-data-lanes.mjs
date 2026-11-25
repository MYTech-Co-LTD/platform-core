// scripts/check-data-lanes.mjs — 数据新鲜度双车道的静态门禁（路线图 §4 的 A4/A5）。
//
// A4（覆盖性）：`dbt/models/**` 里每个 `materialized='incremental'` 模型必须**恰好属于一个车道**
//   （retail_10m / nonretail_1h.<domain> / daily_report）。漏归属、重复归属、配置了不存在的模型、
//   把 table 模型塞进增量车道 —— 全部判红。
// A5（起点）：nonretail_1h 的起点必须紧随最后一个「小时级 L0」采集偏移（gap ≤ maxGapMinutes，
//   且不得同分钟）；retail_10m 的物化偏移必须与采集 tick 的步长/起点对齐。
//
// 为什么是静态门禁：这两条都属于「人一改就忘」的类别——新增一个增量模型忘了分车道、新增一个
// 采集源排在物化起点之后。CI 上跑一次，比事后在报表上发现「这个数一直没更新」便宜得多。
//
// 用法：
//   pnpm exec tsx scripts/check-data-lanes.mjs [rootDir]
// 事实源：`scripts/lemeng/data-lanes.json`（车道归属）；采集偏移取
//   `deploy/duckle/console/schedules/{3120,64188}.json`；物化偏移取 registry 的 data.dbt_tick。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SHANGHAI_TZ } from './lib/time-semantics.mjs'

export const SCRIPT_NAME = 'check-data-lanes'
export const LANES_REL = 'scripts/lemeng/data-lanes.json'
export const SLA_REL = 'scripts/lemeng/sla.json'
const DBT_MODELS_REL = 'dbt/models'
const SCHEDULES_REL = [
  'deploy/duckle/console/schedules/3120.json',
  'deploy/duckle/console/schedules/64188.json',
]
const REGISTRY_REL = 'apps/server/src/scheduler/registry.ts'

/**
 * 递归列出 `*.sql`（相对 rootDir）。
 * @param {string} rootDir
 * @param {string} rel
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkSql(rootDir, rel, out = []) {
  const abs = join(rootDir, rel)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs)) {
    const childRel = `${rel}/${name}`
    const childAbs = join(rootDir, childRel)
    if (statSync(childAbs).isDirectory()) walkSql(rootDir, childRel, out)
    else if (name.endsWith('.sql')) out.push(childRel)
  }
  return out
}

/**
 * 从模型正文抽 `materialized='...'`（也认双引号）；没有显式声明 ⇒ null（dbt 默认 view）。
 * @param {string} src
 * @returns {string | null}
 */
function materializationOf(src) {
  const m = src.match(/materialized\s*=\s*['"]([a-z_-]+)['"]/)
  return m ? m[1] : null
}

/**
 * @typedef {{ file: string, materialized: string | null }} ModelMeta
 */

/**
 * 收集 `{ 模型名 → { file, materialized } }`；同名重复直接记错误。
 * @param {string} rootDir
 * @returns {{ models: Map<string, ModelMeta>, errors: string[] }}
 */
function collectModels(rootDir) {
  /** @type {Map<string, ModelMeta>} */
  const models = new Map()
  /** @type {string[]} */
  const errors = []
  for (const rel of walkSql(rootDir, DBT_MODELS_REL)) {
    const name = rel.slice(rel.lastIndexOf('/') + 1, -'.sql'.length)
    const prev = models.get(name)
    if (prev) {
      errors.push(`模型名重复：${name}（${prev.file} / ${rel}）`)
      continue
    }
    models.set(name, { file: rel, materialized: materializationOf(readFileSync(join(rootDir, rel), 'utf8')) })
  }
  return { models, errors }
}

/**
 * 解析 `2-59/10` 形态的分钟字段 → { start, end, step }；不匹配返回 null。
 * @param {string} field
 * @returns {{ start: number, end: number, step: number } | null}
 */
function parseMinuteRange(field) {
  const m = /^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(field)
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), step: Number(m[3]) }
}

/**
 * A5：读两份 console 排班，算小时级 L0 的最大分钟偏移 + tick 步长。
 * @param {string} rootDir
 * @returns {{ errors: string[], hourly: Array<{ id: string, minute: number }>, ticks: Array<{ id: string, step: number }>, allIds: Set<string> }}
 */
function collectScheduleFacts(rootDir) {
  /** @type {string[]} */
  const errors = []
  /** @type {Array<{ id: string, minute: number }>} */
  const hourly = []
  /** @type {Array<{ id: string, step: number }>} */
  const ticks = []
  /** @type {Set<string>} */
  const allIds = new Set()
  for (const rel of SCHEDULES_REL) {
    const abs = join(rootDir, rel)
    if (!existsSync(abs)) {
      errors.push(`缺少排班文件：${rel}`)
      continue
    }
    /** @type {any[]} */
    let list
    try {
      list = JSON.parse(readFileSync(abs, 'utf8'))
    } catch (e) {
      errors.push(`${rel} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    for (const s of list) {
      if (s?.id) allIds.add(String(s.id))
      if (s?.enabled === false) continue
      if (s?.kind?.type !== 'cron') continue
      if (s?.timezone !== SHANGHAI_TZ) continue
      const parts = String(s.kind.expr ?? '').trim().split(/\s+/)
      const [min, hour] = parts
      if (min === undefined || hour === undefined) continue
      // 小时级 L0：单分钟 + 9-23 每小时的整点档（如 `58 9-23 * * *`）。
      if (/^\d{1,2}$/.test(min) && hour === '9-23') hourly.push({ id: s.id, minute: Number(min) })
      // 采集 tick：`*/10 9-23,0-1`（10 分钟步长）。
      else if (/^\*\/\d+$/.test(min) && /9-23/.test(hour)) ticks.push({ id: s.id, step: Number(min.slice(2)) })
    }
  }
  return { errors, hourly, ticks, allIds }
}

/**
 * @typedef {{ ok: boolean, errors: string[], stats: {
 *   incremental?: number, lanes?: number, table?: number, hourlySources?: number,
 *   maxSourceMinute?: number | null, startMinute?: number | null, gap?: number | null
 * } }} CheckResult
 */

/**
 * 主检查：返回 { ok, errors, stats }。rootDir 默认仓根（测试传临时 fixture）。
 * @param {string} [rootDir]
 * @returns {CheckResult}
 */
export function checkDataLanes(rootDir = fileURLToPath(new URL('..', import.meta.url))) {
  /** @type {string[]} */
  const errors = []
  const lanesAbs = join(rootDir, LANES_REL)
  if (!existsSync(lanesAbs)) {
    return { ok: false, errors: [`缺少车道事实源：${LANES_REL}`], stats: {} }
  }
  /** @type {any} */
  let lanes
  try {
    lanes = JSON.parse(readFileSync(lanesAbs, 'utf8'))
  } catch (e) {
    return { ok: false, errors: [`${LANES_REL} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`], stats: {} }
  }

  const { models, errors: modelErrors } = collectModels(rootDir)
  errors.push(...modelErrors)

  // ── A4：车道归属 ────────────────────────────────────────────────────────────────
  /** @type {string[] | null} */
  const ten = Array.isArray(lanes?.lanes?.retail_10m?.models) ? lanes.lanes.retail_10m.models : null
  /** @type {string[] | null} */
  const daily = Array.isArray(lanes?.lanes?.daily_report?.models) ? lanes.lanes.daily_report.models : null
  const domains = lanes?.lanes?.nonretail_1h?.domains
  if (!ten) errors.push('data-lanes.json: lanes.retail_10m.models 必须是数组')
  if (!daily) errors.push('data-lanes.json: lanes.daily_report.models 必须是数组')
  if (!domains || typeof domains !== 'object' || Array.isArray(domains)) {
    errors.push('data-lanes.json: lanes.nonretail_1h.domains 必须是对象')
  }

  /** @type {Record<string, unknown>} */
  const domainsObj = domains && typeof domains === 'object' && !Array.isArray(domains) ? domains : {}
  /** @type {Array<{ domain: string, model: string }>} */
  const oneHour = Object.entries(domainsObj).flatMap(([domain, list]) => {
    if (!Array.isArray(list)) {
      errors.push(`data-lanes.json: nonretail_1h.domains.${domain} 必须是数组`)
      return []
    }
    return list.map((/** @type {unknown} */ model) => ({ domain, model: String(model) }))
  })

  /** @type {Array<{ lane: string, model: string }>} */
  const listed = [
    ...(ten ?? []).map((model) => ({ lane: 'retail_10m', model })),
    ...oneHour.map(({ domain, model }) => ({ lane: `nonretail_1h.${domain}`, model })),
    ...(daily ?? []).map((model) => ({ lane: 'daily_report', model })),
  ]

  // 重复归属（同一模型出现在多个车道）
  /** @type {Map<string, { lane: string, model: string }>} */
  const byModel = new Map()
  for (const item of listed) {
    const prev = byModel.get(item.model)
    if (prev) errors.push(`模型 ${item.model} 同时属于 ${prev.lane} 和 ${item.lane}`)
    else byModel.set(item.model, item)
  }

  const incremental = new Map([...models].filter(([, m]) => m.materialized === 'incremental'))
  const table = new Map([...models].filter(([, m]) => m.materialized === 'table'))

  // 配置了不存在的模型
  for (const { lane, model } of listed) {
    const meta = models.get(model)
    if (!meta) errors.push(`${lane} 配置了不存在的模型：${model}`)
    else if (meta.materialized !== 'incremental') {
      errors.push(`${lane} 的 ${model} 物化方式不是 incremental（实际 ${meta.materialized ?? '未声明'}）`)
    }
  }

  // 每个增量模型必须恰好归属一个车道
  for (const [model, meta] of incremental) {
    if (!byModel.has(model)) errors.push(`增量模型未归属车道：${model}（${meta.file}）`)
  }

  // D2 定案守卫：10m 车道只允许 fct_retail_sale（改它必须先改路线图决策）
  if (ten && JSON.stringify([...ten].sort()) !== JSON.stringify(['fct_retail_sale'])) {
    errors.push(`retail_10m 只允许 fct_retail_sale（D2 定案）；实际：${JSON.stringify(ten)}`)
  }

  // table 模型不应出现在增量车道（上面的物化检查已覆盖，但给一条更直白的提示）
  for (const { lane, model } of listed) {
    if (table.has(model)) errors.push(`${lane} 不允许包含 table 模型：${model}`)
  }

  // ── A5：起点对齐 ────────────────────────────────────────────────────────────────
  const sched = collectScheduleFacts(rootDir)
  errors.push(...sched.errors)

  const oneHourSchedule = lanes?.lanes?.nonretail_1h?.schedule
  const startMinute = Number(oneHourSchedule?.startMinuteCst)
  const maxGap = Number(oneHourSchedule?.maxGapMinutes)
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 59) {
    errors.push('data-lanes.json: nonretail_1h.schedule.startMinuteCst 必须是 0-59 的整数')
  }
  if (!Number.isInteger(maxGap) || maxGap < 1 || maxGap > 59) {
    errors.push('data-lanes.json: nonretail_1h.schedule.maxGapMinutes 必须是 1-59 的整数')
  }

  const maxSourceMinute = sched.hourly.length > 0 ? Math.max(...sched.hourly.map((s) => s.minute)) : null
  /** @type {number | null} */
  let gap = null
  if (maxSourceMinute === null) {
    errors.push('没有找到任何小时级 L0 排班（单分钟 + 9-23）——A5 无法验起点')
  } else if (Number.isInteger(startMinute) && Number.isInteger(maxGap)) {
    gap = ((startMinute - maxSourceMinute) % 60 + 60) % 60
    if (gap === 0) {
      errors.push(`1h 起点与最后一个采集偏移同分钟（:${String(maxSourceMinute).padStart(2, '0')}）——会读到未写完的批`)
    } else if (gap > maxGap) {
      errors.push(`1h 起点 :${String(startMinute).padStart(2, '0')} 距最后一个采集偏移 :${String(maxSourceMinute).padStart(2, '0')} 有 ${gap} 分钟 > maxGapMinutes=${maxGap}`)
    }
  }

  // 10m：采集 tick 的步长 / 物化偏移
  const tenSchedule = lanes?.lanes?.retail_10m?.schedule
  const buildOffset = Number(tenSchedule?.buildOffsetMinutes)
  if (!Number.isInteger(buildOffset) || buildOffset < 1 || buildOffset > 9) {
    errors.push('data-lanes.json: retail_10m.schedule.buildOffsetMinutes 必须是 1-9 的整数')
  }
  const tickSteps = [...new Set(sched.ticks.map((t) => t.step))]
  if (sched.ticks.length === 0) {
    errors.push('没有找到采集 tick 排班（*/N + 9-23）')
  } else if (tickSteps.length !== 1 || tickSteps[0] !== 10) {
    errors.push(`采集 tick 的步长应恒为 10 分钟；实际：${JSON.stringify(tickSteps)}`)
  }

  const registryAbs = join(rootDir, REGISTRY_REL)
  if (!existsSync(registryAbs)) {
    errors.push(`缺少 registry：${REGISTRY_REL}`)
  } else {
    const regText = readFileSync(registryAbs, 'utf8')
    const line = regText.split('\n').find((l) => l.includes("key: 'data.dbt_tick'"))
    const cron = line?.match(/cron:\s*'([^']+)'/)?.[1]
    if (!cron) {
      errors.push('registry 里找不到 data.dbt_tick 的 cron')
    } else {
      const [minuteField] = cron.trim().split(/\s+/)
      const range = parseMinuteRange(minuteField)
      if (!range) {
        errors.push(`data.dbt_tick 的分钟字段不是 \`a-b/N\` 形态：${minuteField}`)
      } else {
        if (range.step !== 10) errors.push(`data.dbt_tick 步长应为 10；实际 ${range.step}（${cron}）`)
        if (Number.isInteger(buildOffset) && range.start !== buildOffset) {
          errors.push(`data.dbt_tick 的物化偏移 ${range.start} 与 data-lanes.json 的 buildOffsetMinutes=${buildOffset} 不一致`)
        }
      }
    }

    // A3：每个 nonretail_1h 域必须有一个 registry job（`hourlyLaneJob('<domain>'`），
    // 且不能出现配置里没有的域——否则拆车道后某个域**静默不跑**或跑错车道。
    const configDomains = Object.keys(domainsObj)
    const calls = [...regText.matchAll(/hourlyLaneJob\('([^']+)'/g)].map((m) => m[1])
    for (const d of configDomains) {
      if (!calls.includes(d)) errors.push(`data-lanes.json 的域 ${d} 没有对应的 hourlyLaneJob('${d}')（A3 registry job 缺失）`)
    }
    for (const c of calls) {
      if (!configDomains.includes(c)) errors.push(`registry 的 hourlyLaneJob('${c}') 不在 data-lanes.json 的 nonretail_1h.domains 里`)
    }
  }

  // ── D1：SLA 覆盖（每个 nonretail_1h 域必须有 job + sources；源 id 必须真实存在）─────────────
  const slaAbs = join(rootDir, SLA_REL)
  if (!existsSync(slaAbs)) {
    errors.push(`缺少 SLA 事实源：${SLA_REL}`)
  } else {
    /** @type {any} */
    let sla
    try {
      sla = JSON.parse(readFileSync(slaAbs, 'utf8'))
    } catch (e) {
      errors.push(`${SLA_REL} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
      sla = null
    }
    if (sla) {
      const products = sla.products ?? {}
      if (!products.retail_10m?.job) errors.push('sla.json: products.retail_10m.job 缺失')
      if (!products.daily?.job) errors.push('sla.json: products.daily.job 缺失')
      const slaDomains = products.nonretail_1h?.domains ?? {}
      const laneDomains = Object.keys(domainsObj)
      for (const d of laneDomains) {
        const entry = slaDomains[d]
        if (!entry) { errors.push(`sla.json 缺域 ${d} 的 SLA 条目`); continue }
        if (!entry.job) errors.push(`sla.json 域 ${d} 缺 job`)
        if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
          errors.push(`sla.json 域 ${d} 的 sources 必须是非空数组`)
          continue
        }
        for (const s of entry.sources) {
          if (!sched.allIds.has(String(s))) errors.push(`sla.json 域 ${d} 的源 ${s} 不在 console 排班里（拼错或已退役）`)
        }
      }
      for (const d of Object.keys(slaDomains)) {
        if (!laneDomains.includes(d)) errors.push(`sla.json 的域 ${d} 不在 data-lanes.json 的 nonretail_1h.domains 里`)
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      incremental: incremental.size,
      lanes: byModel.size,
      table: table.size,
      hourlySources: sched.hourly.length,
      maxSourceMinute,
      startMinute: Number.isInteger(startMinute) ? startMinute : null,
      gap,
    },
  }
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const { ok, errors, stats } = checkDataLanes(rootDir)
  if (!ok) {
    console.error(`${SCRIPT_NAME}: ${errors.length} 处违规`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(
    `${SCRIPT_NAME}: OK（增量模型 ${stats.incremental} 全部归属；车道 ${stats.lanes}；`
    + `table ${stats.table}；小时级源 ${stats.hourlySources}，最后偏移 :${String(stats.maxSourceMinute).padStart(2, '0')}`
    + ` → 1h 起点 :${String(stats.startMinute).padStart(2, '0')}，gap ${stats.gap} 分钟）`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
