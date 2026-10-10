// check-console-alerts.mjs — console 告警覆盖门禁（issue #565）。
//
// 盯的是**今天没有任何门禁盯的那条耦合**：`schedules/<账套>.json` 里**被调度**的管线 ↔
// `alerts.<源系统>.json` 里**含 failure 的规则集**。
//
// 案例（2026-10-10；PR #562 实证）：`lemeng.dim.item_price.l0.3120` 定时 11:15（北京）429 失败，
// 群里一声不响。引擎侧完全正常——**没有规则命中就不发**（引擎自写台账 `/workspace/.duckle/alert-state.json`
// 的 `lastSent` 里连该管线的键都没有，四条 `.3120` 管线零发送记录）。缝在**规则集与排班之间**：
// 规则只写 `lemeng.dim.*.l0`（按**形态末段**分组，取舍见 alerts.json ⑨），覆盖不到带**账套号后缀**
// 的 id。`check-console-schedules.mjs`（#531）管的是 schedules ↔ `pipelines/` 的存在性与账套隔离
// （错账套排班=静默采错数据），**看不到这条缝** ⇒ 补本条。
//
// 判据（A/B/C 任一条违规 = exit 1；D 是记账，每次运行都打印）：
//   A 文件完整性（逐条规则）：`match` 非空串；`on` 缺省或为已知事件子集；**`channel` 必须在**。
//     ⚠️ `channel` 是 serde flatten **必填** ⇒ 缺一条 = `load()` Err = **整个文件作废**
//     （所有告警一起死，连 lastStatus 都不写），**不是**「少一条规则」。所以它必须在这里被拦，
//     不能等线上报「怎么全不响了」。
//   B 覆盖：每本 `schedules/<账套>.json` 里 `enabled: true` 的条目，其 `pipeline_id` 必须被
//     **同源**（id 首段 == `alerts.<源>.json` 的 `<源>`）且 **`on` 含 `failure`** 的规则 glob 命中。
//     无命中 = 该管线失败时**不产生任何事件行/通知**（即 #562 那个静默）。
//   C 死规则：`match != "*"` 且 `on` 含 `failure` 的规则，必须命中 ≥1 条**已知管线 id**
//     （`pipelines/` 全集 ∪ 排班全集）——盯「规则写了但拼错/写窄了 ⇒ 等于没写」，与 B 同属一个危害面。
//   D 豁免：`EXEMPT` 显式列出 + **必写理由**，且每次运行**打印**（豁免是记账，不是隐身）。
//
// glob 语义**按引擎实测，不按通用 glob 想当然**：`*` **跨 `.`**——引擎台账 `alert-state.json` 里
// `lemeng.recon.*` 命中过 `lemeng.recon.preagg.item`、`lemeng.dim.*.l0` 命中过 `lemeng.dim.alerttest.l0`。
// 单测用这两对钉住语义（引擎若换实现，这里先红）。
//
// 纯静态：只读仓内 JSON，不连库、不取网络。扫描面 = `<root>/schedules/*.json` + `<root>/alerts.*.json`
// + `<root>/pipelines/*.json`（只取文件名当 id，不解析管线体——`name == stem` 由 #531 那条管）。
//
// 用法：pnpm exec tsx scripts/check-console-alerts.mjs [--root <console目录>]（默认仓内正典路径）
// 失败字面量：`ALERT_COVERAGE_FAILED:`（每条违规一行，exit 1）；用法错 exit 2。
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const rootArgIdx = process.argv.indexOf('--root')
const ROOT = rootArgIdx === -1 ? 'deploy/duckle/console' : process.argv[rootArgIdx + 1]
if (typeof ROOT !== 'string' || ROOT.length === 0) {
  console.error('check-console-alerts: --root 需要一个目录参数')
  process.exit(2)
}

/** 引擎事件集（alerts.rs `Event` enum，rename_all=lowercase）。多一个/错一个都让规则永不触发。 */
const EVENTS = ['failure', 'recovery', 'success', 'stale', 'refreshed']
/** `on` 缺省值（源码：缺省 = failure + recovery；success 必须显式订阅）。 */
const DEFAULT_ON = ['failure', 'recovery']

/**
 * 豁免：**必须写理由**，且每次运行打印。空数组 = 今天没有需要豁免的条目。
 * 形状固定（scripts/ 是 checkJs 的单形状纪律）：字段恒在，缺字段就是结构漂移。
 * @type {{ pipeline: string, reason: string }[]}
 */
const EXEMPT = []

/** 单形状纪律：字段恒在，缺了就当结构漂移大声红，不做可辨识联合收窄。 @param {string} p @returns {any} */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/**
 * 告警规则的单形状（scripts/ 是 checkJs：字段可选但恒在键位，值一律 unknown 再由判据收窄，
 * 不做可辨识联合）。`[k: string]: unknown` 兜住引擎将来新增的键，不让它们在解析期炸。
 * @typedef {{ match?: unknown, on?: unknown, channel?: unknown, [k: string]: unknown }} AlertRule
 */

/** @param {any} j @returns {AlertRule[]} */
function rulesOf(j) {
  return Array.isArray(j.rules) ? j.rules : []
}

/** 文件名 stem（去 .json）；管线 id 由它当事实源（`name == stem` 归 #531 管）。 @param {string} f @returns {string} */
const stemOf = (f) => basename(f).replace(/\.json$/, '')

/**
 * 引擎 glob → RegExp：`*` 跨 `.`（实测），`?` 单字符，其余字面量。
 * @param {string} glob @returns {RegExp}
 */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`)
}

/** @type {string[]} 违规明细（每条一行） */
const violations = []
/** @type {Map<string, { file: string, rules: any[] }>} 源系统 → 该源的告警文件与规则 */
const alertSources = new Map()

// ── ① 告警文件：完整性（判据 A）+ 收规则 ──────────────────────────────────────
for (const f of readdirSync(ROOT).filter((n) => /^alerts\..+\.json$/.test(n)).sort()) {
  const source = f.slice('alerts.'.length, -'.json'.length)
  const j = readJson(join(ROOT, f))
  const rules = rulesOf(j)
  if (rules.length === 0) {
    violations.push(`${f} 的 rules 为空或不是数组——一个源的告警集空转本身就可疑`)
    continue
  }
  rules.forEach((r, i) => {
    const at = `${f}[${i}]`
    if (typeof r.match !== 'string' || r.match.length === 0) {
      violations.push(`${at} match 缺/非空字符串（引擎比不了任何管线 id）`)
    }
    if (r.on !== undefined) {
      if (!Array.isArray(r.on) || r.on.some((e) => typeof e !== 'string' || !EVENTS.includes(e))) {
        violations.push(`${at} on=${JSON.stringify(r.on)} 含未知事件（合法集：${EVENTS.join('/')}）——静默不触发`)
      }
    }
    if (r.channel === undefined || r.channel === null || r.channel === '') {
      violations.push(`${at} 缺 channel——serde flatten 必填 ⇒ 整个文件作废（所有告警一起死），不是少一条`)
    }
  })
  alertSources.set(source, { file: f, rules })
}
if (alertSources.size === 0) {
  console.error(`ALERT_COVERAGE_FAILED: ${ROOT} 下一个 alerts.*.json 都没有——门禁没东西可判本身就可疑`)
  process.exit(1)
}

// ── ② 已知管线 id 集（判据 C 的靶场）+ 排班（判据 B 的被检方）────────────────
/** @type {Set<string>} */
const knownPipelines = new Set()
for (const f of readdirSync(join(ROOT, 'pipelines'))) {
  if (f.endsWith('.json')) knownPipelines.add(stemOf(f))
}

const scheduleFiles = readdirSync(join(ROOT, 'schedules')).filter((f) => f.endsWith('.json')).sort()
if (scheduleFiles.length === 0) {
  console.error('ALERT_COVERAGE_FAILED: schedules/ 下一本排班都没有——门禁没东西可判本身就可疑')
  process.exit(1)
}
/** @type {{ book: string, entry: string, pipeline: string }[]} 被检的 enabled 条目 */
const checked = []
for (const f of scheduleFiles) {
  const book = stemOf(f)
  const entries = readJson(join(ROOT, 'schedules', f))
  if (!Array.isArray(entries)) {
    violations.push(`schedules/${f} 顶层不是数组（结构漂移）`)
    continue
  }
  for (const entry of entries) {
    const pid = entry.pipeline_id
    // pipeline_id 的存在性/拼写归 #531 那条门禁；这里只管「跑了却没人告警」。
    if (typeof pid !== 'string' || pid.length === 0) continue
    knownPipelines.add(pid)
    if (entry.enabled !== true) continue
    if (EXEMPT.some((e) => e.pipeline === pid)) continue
    checked.push({ book, entry: String(entry.id), pipeline: pid })
  }
}

// ── ③ 判据 C：死规则（写了却什么都命中不到，等于没写）───────────────────────
for (const { file, rules } of alertSources.values()) {
  rules.forEach((r, i) => {
    if (r.match === '*' || typeof r.match !== 'string') return
    const on = Array.isArray(r.on) ? r.on : DEFAULT_ON
    if (!on.includes('failure')) return
    const re = globToRegExp(r.match)
    if (![...knownPipelines].some((id) => re.test(id))) {
      violations.push(`${file}[${i}] 规则 match="${r.match}" 命中不到任何已知管线 id——拼错/写窄了？豁免要写进 EXEMPT`)
    }
  })
}

// ── ④ 判据 B：覆盖（被调度的每条管线都必须有人接 failure）───────────────────
for (const c of checked) {
  const source = c.pipeline.split('.')[0]
  const entry = alertSources.get(source)
  if (entry === undefined) {
    violations.push(`book=${c.book} entry=${c.entry} 管线 ${c.pipeline} 无同源告警文件 alerts.${source}.json——该源全线无告警`)
    continue
  }
  const re = []
  for (const r of entry.rules) {
    if (typeof r.match !== 'string') continue
    const on = Array.isArray(r.on) ? r.on : DEFAULT_ON
    if (!on.includes('failure')) continue
    re.push({ match: r.match, hit: globToRegExp(r.match).test(c.pipeline) })
  }
  if (!re.some((x) => x.hit)) {
    violations.push(
      `book=${c.book} entry=${c.entry} 管线 ${c.pipeline} 无含 failure 的规则覆盖——失败时**不产生任何事件行/通知**（#565 案例形态；现含 ${re.length} 条 failure 规则：${re.map((x) => x.match).join(' , ') || '无'}）`,
    )
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`ALERT_COVERAGE_FAILED: ${v}`)
  process.exit(1)
}
const exemptLine = EXEMPT.length === 0 ? '无' : EXEMPT.map((e) => `${e.pipeline}（${e.reason}）`).join(' ; ')
console.log(
  `check-console-alerts: OK（${scheduleFiles.length} 本排班 / enabled 受检 ${checked.length} 条 / ` +
    `源 ${[...alertSources.keys()].join(',')} / 已知管线 ${knownPipelines.size} 条 / 豁免 ${exemptLine}）`,
)
