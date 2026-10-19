#!/usr/bin/env node
// scripts/check-recon-caliber.mjs — 「业务规则只定义一次」的静态门禁（architecture §4.1 **B11**）。
//
// 用法：`pnpm exec tsx scripts/check-recon-caliber.mjs [rootDir]`（rootDir 默认仓根，测试用夹具）。
// 纯静态：不连库、不取网络、不起容器、不读 parquet。
// 契约：干净 → exit 0，stdout 一行 `check-recon-caliber: OK（…）`；
//       有违规 → exit 1，stderr 逐条点名（判据 + 怎么修）。
//
// ── 它守的是什么（issue #831 → #917 → #920）────────────────────────────────────
// 口径「净销售额 = 销售侧 − 退货侧」曾经在仓里有 **5 处独立实现**，靠人手同步，酿成两次**静默**事故：
//   · **#813**：容差地板漂移（脚本 200.00 vs 管线 1.00）⇒ 一侧判 DRIFT、一侧判死 ⇒ 排班面天天假红；
//   · **#917**：退货侧赠品判别式只改了构件与复算，两份对账副本没跟上 ⇒ 湖侧净额系统性偏大（3120/10-17 差 130.79）。
// 根因不是「副本多」，是**把两种性质不同的控制写成了同一个算式**：
//   · **复算（内部一致性）**：对手方是同一份原始数据 ⇒ 贴着模型、允许有第二份**独立读路径**的实现（dbt `audit_*`）；
//   · **对账（外部一致性）**：对手方是外部系统 ⇒ **消费者**，读物化结果，**不自带等价算式**。
// 2026-10-19（issue #920）按这个切分重构后，口径只剩 **1 份实现（构件）+ 1 份独立复算**，都在 dbt。
//
// ── 判据（四条）────────────────────────────────────────────────────────────────
//   ① **dbt 三份副本**里，该带的赠品判别式**逐字在场**（构件带两侧；两个复算按各自口径）；
//   ② **对账链路反向外断言**：`scripts/lemeng/recon-preagg.sh` 的 `SQL_PLATFORM` 与
//      `lemeng.recon.preagg*.json` 里**所有 `code.sql` 节点的 SQL**，**不得出现任何口径原子**
//      （两侧赠品判别式 / 折半形态 / 退货侧全额冲减形态）——出现即代表对账侧又自带了一份实现；
//   ③ **消费者必须指向构件**：脚本的 `SQL_PLATFORM` 必须引用 `fct_retail_sale`
//      （只断言「没口径」不够——它也可能悄悄读别的表）；
//   ④ **容差地板同源**：脚本的 `PREAGG_ABS_TOL` / `NET_ABS_TOL` / `PREAGG_MAX_PCT`
//      必须等于 `dbt/seeds/recon_tolerances.csv`（#813 的实证形态就是只差地板）。
//
// ⚠️ **扫描面只取代码**：shell 只扫 `SQL_PLATFORM="…"` 字面量（不扫 `#` 注释），
//    管线只扫 `nodes[].data.properties.sql`（不扫 `_note`）——解释性散文里复述口径**不算违规**。
// ⚠️ **边界**：本门禁判「**在场 / 不在场**」，不判三份 dbt 副本的语义等价（那要靠 dbt 测试与评审）。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-recon-caliber'

/** dbt 侧的三份副本（**允许**有口径实现的地方）。 */
export const DBT_COPIES = [
  {
    key: 'mart',
    path: 'dbt/models/lemeng/marts/fct_retail_sale.sql',
    label: '构件（唯一实现）',
    saleGift: true,
    retGift: true,
  },
  {
    key: 'auditNet',
    path: 'dbt/tests/lemeng/audit_lemeng__retail__net_sales.sql',
    label: '独立复算（净额侧）',
    saleGift: true,
    retGift: true,
  },
  {
    key: 'auditSales',
    path: 'dbt/tests/lemeng/audit_lemeng__retail__sales.sql',
    label: '独立复算（销售侧）',
    saleGift: true,
    retGift: false,
  },
]

/** 对账链路（**禁止**出现口径实现的地方）。 */
export const CONSUMER_SCRIPT = 'scripts/lemeng/recon-preagg.sh'
/** 对账管线的文件名前缀（`lemeng.recon.preagg.json` / `.item.json` / `.backfill.json`）。 */
export const CONSUMER_PIPELINE_PREFIX = 'lemeng.recon.preagg'
/** 脚本里的平台侧 SQL 字面量名（改造后的消费者形态）。 */
export const SCRIPT_SQL_VAR = 'SQL_PLATFORM'
/** 消费者必须指向的构件（判据 ③）。 */
export const CONSUMER_MUST_CITE = 'fct_retail_sale'

/** 容差配置的落点。 */
export const TOLERANCES_PATH = 'dbt/seeds/recon_tolerances.csv'

/** 销售侧赠品判别式（**逐字正典**）。 */
export const SALE_GIFT_SQL =
  'order_detail_std_price > 0 and sale_money > 0 and quantity > 0 and abs(discount_money - order_detail_std_price * quantity) <= 0.02'
/** 退货侧赠品判别式（**绝对值形态**，#908）。 */
export const RET_GIFT_SQL =
  'order_detail_std_price > 0 and abs(sale_money) > 0 and abs(quantity) > 0 and abs(abs(discount_money) - order_detail_std_price * abs(quantity)) <= 0.02'
/** 销售侧折半形态（逐单除 2、逐单减 sd —— 除法的舍入位置是口径的一部分）。 */
export const HALVING_SQL = 'sum((ng + tot) / 2 - sd)'
/** 退货侧的**全额冲减**形态。 */
export const RET_SUM_SQL = 'sale_money + order_detail_share_discount'

/** 口径原子（出现在对账链路里即视为「又自带了一份实现」）。 */
export const CALIBER_ATOMS = [
  { label: '销售侧赠品判别式', sql: SALE_GIFT_SQL },
  { label: '退货侧赠品判别式（绝对值形态）', sql: RET_GIFT_SQL },
  { label: '销售侧折半形态', sql: HALVING_SQL },
  { label: '退货侧全额冲减形态', sql: RET_SUM_SQL },
]

/** 脚本里三个容差 env 的键名 → 对应 seed 的 control / 列。 */
export const TOLERANCE_BINDINGS = [
  { env: 'PREAGG_ABS_TOL', control: 'caliber_sale', column: 'abs_tol' },
  { env: 'PREAGG_MAX_PCT', control: 'caliber_sale', column: 'pct_tol' },
  { env: 'NET_ABS_TOL', control: 'caliber_net', column: 'abs_tol' },
]

/**
 * 去 `--` 行注释（SQL 侧）。
 * @param {string} s @returns {string}
 */
function stripLineComments(s) {
  return s
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--')
      return i >= 0 ? line.slice(0, i) : line
    })
    .join('\n')
}

/**
 * 反复把 `cast(<expr> as <type>)` 折成 `<expr>`（直到没有可折的）。
 * @param {string} s @returns {string}
 */
function foldCasts(s) {
  let out = s
  for (;;) {
    const m = /\bcast\s*\(/i.exec(out)
    if (m === null) return out
    const open = m.index + m[0].length - 1
    let depth = 0
    let close = -1
    for (let i = open; i < out.length; i += 1) {
      const c = out[i]
      if (c === '(') depth += 1
      else if (c === ')') {
        depth -= 1
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close < 0) return out
    const inner = out.slice(open + 1, close)
    let d = 0
    let asAt = -1
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i]
      if (c === '(') d += 1
      else if (c === ')') d -= 1
      else if (d === 0 && /^\sas\s/i.test(inner.slice(i, i + 4))) {
        asAt = i
        break
      }
    }
    const expr = asAt >= 0 ? inner.slice(0, asAt) : inner
    out = `${out.slice(0, m.index)} ${expr} ${out.slice(close + 1)}`
  }
}

/**
 * 规范化一段 SQL：剥注释 → 折 cast → 统一列引用/来源 → 去全部空白 → 小写。
 * 目的：让**同一口径的不同写法**（`r['x']` vs `CAST(x AS …)`）折成同一个串。
 * @param {string} sql @returns {string}
 */
export function normalize(sql) {
  let s = stripLineComments(sql)
  s = foldCasts(s)
  s = s.replace(/\br\s*\[\s*'([a-z_]+)'\s*\]/gi, '$1')
  s = s.replace(/::\s*[a-z0-9_]+(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi, '')
  s = s.replace(/\bfrom\s+read_parquet\s*\([^)]*\)\s*r\b/gi, 'from src')
  s = s.replace(/\bfrom\s+"[a-z_]+"/gi, 'from src')
  s = s.replace(/\{\{\s*ref\s*\(\s*'[^']+'\s*\)\s*\}\}/gi, 'src')
  s = s.replace(/\s+/g, '')
  return s.toLowerCase()
}

/**
 * 展开脚本里的 `NAME="…"` 单行赋值（`${X}` → 值）。
 * @param {string} text @returns {string}
 */
function expandShellVars(text) {
  /** @type {Map<string, string>} */
  const vars = new Map()
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)="([^"\n]*)"/gm)) {
    if (m[1] !== undefined && m[2] !== undefined) vars.set(m[1], m[2])
  }
  let out = text
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (all, name) => vars.get(/** @type {string} */ (name)) ?? all)
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 抽出脚本里的平台侧 SQL 字面量（抽不到 → null）。
 * @param {string} text @returns {string | null}
 */
function extractConsumerSql(text) {
  const re = new RegExp(`^\\s*${SCRIPT_SQL_VAR}="([\\s\\S]*?)"\\s*$`, 'm')
  const m = re.exec(expandShellVars(text))
  return m?.[1] === undefined ? null : m[1]
}

/**
 * 列出对账管线文件（含 item / backfill 变体）。
 * @param {string} rootDir @returns {string[]}
 */
function reconPipelineFiles(rootDir) {
  const dir = join(rootDir, 'deploy/duckle/console/pipelines')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(CONSUMER_PIPELINE_PREFIX) && f.endsWith('.json'))
    .sort()
    .map((f) => `deploy/duckle/console/pipelines/${f}`)
}

/**
 * 从一份管线 JSON 里取出所有 `code.sql` 节点的 SQL（只取代码，不取 `_note`）。
 * @param {string} text @returns {string[] | null} null = 不是合法 JSON
 */
function pipelineCodeSqls(text) {
  /** @type {{ nodes?: Array<{ id?: string, data?: { componentId?: string, properties?: { sql?: string } } }> }} */
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  /** @type {string[]} */
  const out = []
  for (const n of doc.nodes ?? []) {
    if (n.data?.componentId !== 'code.sql') continue
    const sql = n.data?.properties?.sql
    if (typeof sql === 'string') out.push(sql)
  }
  return out
}

/**
 * 读脚本里 `KEY=${KEY:-<default>}` 的默认值（读不到 → null）。
 * @param {string} text @param {string} key @returns {string | null}
 */
function envDefault(text, key) {
  const re = new RegExp(`^\\s*${key}=\\$\\{${key}:-([^}]*)\\}`, 'm')
  const m = re.exec(text)
  return m?.[1] === undefined ? null : m[1]
}

/**
 * 解析 `recon_tolerances.csv` → control → { abs_tol, pct_tol }（**只看需要的列**）。
 * @param {string} text @returns {Map<string, { abs_tol: string, pct_tol: string }>}
 */
function parseTolerances(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  /** @type {Map<string, { abs_tol: string, pct_tol: string }>} */
  const out = new Map()
  if (lines.length === 0) return out
  const header = (lines[0] ?? '').split(',').map((c) => c.trim())
  const ci = { control: header.indexOf('control'), abs: header.indexOf('abs_tol'), pct: header.indexOf('pct_tol') }
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const control = cells[ci.control]?.trim() ?? ''
    if (control === '') continue
    out.set(control, { abs_tol: cells[ci.abs]?.trim() ?? '', pct_tol: cells[ci.pct]?.trim() ?? '' })
  }
  return out
}

/** 数值等价比较（`200.00` == `200.0`）。 @param {string} a @param {string} b @returns {boolean} */
function numEq(a, b) {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && x === y
}

/**
 * 跑全部判据，返回违规表（空 = 干净）。
 * @param {string} rootDir 仓根绝对路径
 * @returns {Array<{ file: string, message: string }>} 违规（单形状：字段恒在）
 */
export function findViolations(rootDir) {
  /** @type {Array<{ file: string, message: string }>} */
  const violations = []
  /** @param {string} rel @returns {string | null} */
  const readIfExists = (rel) => {
    const abs = join(rootDir, rel)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null
  }

  const SALE_GIFT = normalize(SALE_GIFT_SQL)
  const RET_GIFT = normalize(RET_GIFT_SQL)

  // ── 判据 ①②：dbt 三份副本里该带的判别式逐字在场 ──────────────────────────────
  for (const copy of DBT_COPIES) {
    const text = readIfExists(copy.path)
    if (text === null) {
      violations.push({ file: copy.path, message: `${copy.label}不在场——口径实现靠这份，删了它 = 门禁没了瞄准点` })
      continue
    }
    const n = normalize(text)
    if (copy.saleGift && !n.includes(SALE_GIFT)) {
      violations.push({
        file: copy.path,
        message:
          '缺销售侧赠品判别式（规范化后逐字比对不中）—— 赠品行按判别式排除' +
          '（正典 docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md §0）',
      })
    }
    if (copy.retGift && !n.includes(RET_GIFT)) {
      violations.push({
        file: copy.path,
        message:
          '缺退货侧赠品判别式（绝对值形态）—— 赠品行不进销售侧，其退货也不该进退货侧；' +
          '源侧退货行**符号不一致**，带负号那类不排会反向加回（#908 / #917）',
      })
    }
  }

  // ── 判据 ②③：对账链路**不得**自带口径实现，且必须指向构件 ─────────────────────
  /** @type {Array<{ file: string, sql: string }>} */
  const consumerSqls = []
  const scriptText = readIfExists(CONSUMER_SCRIPT)
  if (scriptText === null) {
    violations.push({ file: CONSUMER_SCRIPT, message: '对账脚本不在场——判据 ②③ 无从判' })
  } else {
    const sql = extractConsumerSql(scriptText)
    if (sql === null) {
      violations.push({
        file: CONSUMER_SCRIPT,
        message: `抽不到 \`${SCRIPT_SQL_VAR}="…"\` 字面量——脚本结构变了，门禁无从判（改名要同步本门禁）`,
      })
    } else {
      consumerSqls.push({ file: CONSUMER_SCRIPT, sql })
      if (!sql.includes(CONSUMER_MUST_CITE)) {
        violations.push({
          file: CONSUMER_SCRIPT,
          message:
            `${SCRIPT_SQL_VAR} 没有引用 \`${CONSUMER_MUST_CITE}\` —— 对账侧的平台侧数**必须**来自构件` +
            '（architecture §4.1 B11：对账是消费者；读别的表 = 又自立了一份口径）',
        })
      }
    }
  }

  const pipelineFiles = reconPipelineFiles(rootDir)
  if (pipelineFiles.length === 0) {
    violations.push({
      file: 'deploy/duckle/console/pipelines',
      message: `找不到任何 \`${CONSUMER_PIPELINE_PREFIX}*.json\` —— 对账管线不在场，判据 ② 无从判`,
    })
  }
  for (const rel of pipelineFiles) {
    const text = readIfExists(rel)
    if (text === null) continue
    const sqls = pipelineCodeSqls(text)
    if (sqls === null) {
      violations.push({ file: rel, message: '不是合法 JSON —— 判据 ② 无从判' })
      continue
    }
    for (const sql of sqls) consumerSqls.push({ file: rel, sql })
  }

  for (const { file, sql } of consumerSqls) {
    const n = normalize(sql)
    for (const atom of CALIBER_ATOMS) {
      if (!n.includes(normalize(atom.sql))) continue
      violations.push({
        file,
        message:
          `对账链路出现了口径原子「${atom.label}」—— **对账是消费者，不许自带等价算式**` +
          '（architecture §4.1 B11）。口径只许在 dbt 的构件与复算里实现；这里应当读物化结果' +
          '（`fct_retail_sale`）。两次静默事故（#813 / #917）都是这个形态。',
      })
    }
  }

  // ── 判据 ④：容差地板同源 ────────────────────────────────────────────────────
  const tolText = readIfExists(TOLERANCES_PATH)
  if (tolText === null) {
    violations.push({ file: TOLERANCES_PATH, message: '容差配置不在场——判据 ④ 无从比' })
  } else if (scriptText !== null) {
    const tols = parseTolerances(tolText)
    for (const b of TOLERANCE_BINDINGS) {
      const actual = envDefault(scriptText, b.env)
      const row = tols.get(b.control)
      if (actual === null) {
        violations.push({ file: CONSUMER_SCRIPT, message: `读不到 \`${b.env}=\${${b.env}:-…}\` —— 容差常量改名/改形了（判据 ④ 无从比）` })
        continue
      }
      if (row === undefined) {
        violations.push({ file: TOLERANCES_PATH, message: `缺 \`${b.control}\` 行——脚本的 \`${b.env}\` 没有可比的对象` })
        continue
      }
      const expected = row[/** @type {'abs_tol' | 'pct_tol'} */ (b.column)]
      if (!numEq(actual, expected)) {
        violations.push({
          file: CONSUMER_SCRIPT,
          message:
            `\`${b.env}=${actual}\` 与 \`${TOLERANCES_PATH}\` 的 ${b.control}.${b.column}=${expected} **不同源**` +
            ' ——两侧必须在同一次改动里一起改（#813 的实证形态：只差地板 ⇒ 一侧判 DRIFT、一侧判死 ⇒ 排班面天天假红）',
        })
      }
    }
  }

  return violations.sort((a, b) => (a.file === b.file ? a.message.localeCompare(b.message) : a.file.localeCompare(b.file)))
}

/** CLI 入口。 @returns {void} */
function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}: ${v.message}`)
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK（口径只在 dbt 的三份副本里实现；对账链路是消费者；容差地板同源）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
