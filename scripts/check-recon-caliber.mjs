#!/usr/bin/env node
// scripts/check-recon-caliber.mjs — 零售净销售额**口径在四份副本间同源**的静态门禁（issue #831）。
//
// 用法：`pnpm exec tsx scripts/check-recon-caliber.mjs [rootDir]`（rootDir 默认仓根，测试用夹具）。
// 纯静态：不连库、不取网络、不起容器、不读 parquet。
// 契约：干净 → exit 0，stdout 一行 `check-recon-caliber: OK（…）`；
//       有违规 → exit 1，stderr 逐条点名（判据 + 怎么修）；
//       跑不起来（文件缺失/抽不出块）→ **也走 exit 1 并点名**，绝不静默跳过。
//
// ── 它盯的是哪条**今天没有任何门禁**盯的耦合（#831 的原始动机）────────────────────
// 「净销售额 = 销售侧 − 退货侧」这一个口径，在仓里以**五份独立副本**存在，靠人手同步：
//
//   | 副本 | 位置 | 带哪些要素 |
//   |---|---|---|
//   | 构件（唯一实现） | `dbt/models/lemeng/marts/fct_retail_sale.sql` | 销售侧 + 退货侧 |
//   | 独立复算（净额） | `dbt/tests/lemeng/audit_lemeng__retail__net_sales.sql` | 销售侧 + 退货侧 |
//   | 独立复算（销售侧） | `dbt/tests/lemeng/audit_lemeng__retail__sales.sql` | 只有销售侧 |
//   | 湖侧自算（脚本） | `scripts/lemeng/recon-preagg.sh` 的 `SQL_LAKE` | 销售侧 + 退货侧 + `ret_side` |
//   | 湖侧自算（管线） | `deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json` 的 `lagg.sql` | 销售侧 + 退货侧 + `ret_side` |
//
// `deploy/data-plane.lock` 只保**文件完整性**（哈希），**不保语义等价**：改了一份、漏了另一份，
// 哈希全对、门禁全绿、对账却在两边算不同的东西。这个形态**已经真实发生过两次**：
//   ① **#813**（2026-10-17 口径改冲退货）：脚本的净额容差地板切成了 `NET_ABS_TOL=200.00`，
//      而当时管线侧的判据闸还是 `greatest(1.00, …)` —— **只差地板**（pct 项完全相同）⇒
//      同一份数据脚本判 `DRIFT`(rc 0)、管线判死(exit 1) ⇒ 排班 + 告警面**天天假红**。
//      缺陷是**人逐行读两份文件**才发现的，静态门禁一个都抓不到。
//   ② **#917**（2026-10-18 #908 给退货侧加赠品判别式）：构件与复算都改了，
//      **两份对账副本没跟** ⇒ 湖侧自算净额在「有赠品行退货」的日上系统性偏大
//      （3120/10-17 实测 402,866.47 vs 402,735.68，差 130.79），被 `NET_ABS_TOL` 垫住 ⇒ 静默。
//
// ── 判据（五条，各自独立；每条都配一个「只违反它一条」的反例，见 .test.ts）──────────
//   ① **销售侧赠品判别式**在该带它的副本里逐字在场（构件 / 两个复算 / 脚本 / 管线，共五份）；
//   ② **退货侧赠品判别式**（绝对值形态）在**有退货侧**的副本里逐字在场（构件 / 净额复算 / 脚本 / 管线）
//      —— #917 缺的就是这条；
//   ③ **销售侧折半形态** `sum((ng + tot) / 2 - sd)` 在**脚本与管线**两份对拍副本里在场
//      （这两份别名同源 `ng`/`tot`/`sd`；构件/复算用的是展开别名，故不参与本判据）；
//   ④ **退货侧不套折半**：脚本与管线的 `ret_side` CTE 体内不得出现 `/`，且必须含
//      `sale_money + order_detail_share_discount`（全额冲减的形态本体）；
//   ⑤ **容差地板同源**：脚本的 `PREAGG_ABS_TOL` / `NET_ABS_TOL` / `PREAGG_MAX_PCT`
//      必须等于 `dbt/seeds/recon_tolerances.csv` 的 `caliber_sale` / `caliber_net` 两行
//      （#831 原文写的是「与管线 `vthresh` 比」——那四个判据闸已于 2026-10-18 退役，
//       容差的**新家**是这个 seed；事实源搬家了，门禁跟着搬，判据不变）。
//
// ⚠️ **本门禁判的是「在场 / 同源」，不是「等价」**：它抓得住**漏改**（真实发生过的两次形态），
//    抓不住「两份都改成了同一个新错」（那要靠 #831 之外的血缘/单源方案）。
//    写清这条边界，是为了别把它读成比它更强的东西。
// ⚠️ **不剥注释**：判据 ①②③④ 都在**规范化后的整份文本**上做子串匹配 —— 规范化会剥掉 `--` 行注释，
//    所以注释里复述判别式**不会**误报；代码里写错/漏写才会。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-recon-caliber'

/** 五份副本的仓内路径（唯一事实源；改这里 = 改门禁的瞄准点）。 */
export const CALIBER_PATHS = {
  /** 构件：口径的**唯一实现**（layered ④）。 */
  mart: 'dbt/models/lemeng/marts/fct_retail_sale.sql',
  /** 独立复算（净额侧；刻意不 ref staging）。 */
  auditNet: 'dbt/tests/lemeng/audit_lemeng__retail__net_sales.sql',
  /** 独立复算（**销售侧**；#813 拆三列时新增，= 旧 net_sales 的复算）。只有销售侧，没有退货侧。 */
  auditSales: 'dbt/tests/lemeng/audit_lemeng__retail__sales.sql',
  /** 湖侧自算：免 console 的手工/排障入口。 */
  script: 'scripts/lemeng/recon-preagg.sh',
  /** 湖侧自算：接调度的事实源（判据本体已迁入本管线）。 */
  pipeline: 'deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json',
}

/**
 * 各副本**该带哪些口径要素**（不是所有副本都有退货侧 —— 销售侧复算就只有销售侧）。
 * `recon` = 这份是不是「湖侧自算」的对拍副本（只有它俩有 `ret_side` CTE 与 `ng/tot/sd` 别名）。
 */
export const COPIES = [
  { key: 'mart', path: CALIBER_PATHS.mart, saleGift: true, retGift: true, recon: false },
  { key: 'auditNet', path: CALIBER_PATHS.auditNet, saleGift: true, retGift: true, recon: false },
  { key: 'auditSales', path: CALIBER_PATHS.auditSales, saleGift: true, retGift: false, recon: false },
  { key: 'script', path: CALIBER_PATHS.script, saleGift: true, retGift: true, recon: true },
  { key: 'pipeline', path: CALIBER_PATHS.pipeline, saleGift: true, retGift: true, recon: true },
]

/** 容差配置的落点（#831 原文的 `vthresh` 已于 2026-10-18 退役，新家是这个 seed）。 */
export const TOLERANCES_PATH = 'dbt/seeds/recon_tolerances.csv'

/** 管线里承载湖侧净额 SQL 的节点 id。 */
export const PIPELINE_SQL_NODE = 'lagg'

/** 销售侧赠品判别式（**逐字正典**；与 `audit_lemeng__retail__recon_gift_hit.sql` 同一句）。 */
export const SALE_GIFT_SQL =
  'order_detail_std_price > 0 and sale_money > 0 and quantity > 0 and abs(discount_money - order_detail_std_price * quantity) <= 0.02'
/** 退货侧赠品判别式（**绝对值形态**，#908；源侧退货行符号不一致，带负号那类不排会反向加回）。 */
export const RET_GIFT_SQL =
  'order_detail_std_price > 0 and abs(sale_money) > 0 and abs(quantity) > 0 and abs(abs(discount_money) - order_detail_std_price * abs(quantity)) <= 0.02'
/** 销售侧折半形态（逐单除 2、逐单减 sd —— 除法的舍入位置是口径的一部分）。 */
export const HALVING_SQL = 'sum((ng + tot) / 2 - sd)'
/** 退货侧的**全额冲减**形态（不套折半）。 */
export const RET_SUM_SQL = 'sale_money + order_detail_share_discount'

/** 脚本里三个容差 env 的键名 → 对应 seed 的 control / 列。 */
export const TOLERANCE_BINDINGS = [
  { env: 'PREAGG_ABS_TOL', control: 'caliber_sale', column: 'abs_tol' },
  { env: 'PREAGG_MAX_PCT', control: 'caliber_sale', column: 'pct_tol' },
  { env: 'NET_ABS_TOL', control: 'caliber_net', column: 'abs_tol' },
]

/**
 * 去 `--` 行注释（门禁在**代码**上判，注释里复述判别式不算违规）。
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
    // 顶层 ` as ` 的位置（**锚定**：非锚定的 test 会匹配到 as 前两格，吃掉标识符尾巴）
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
 * 目的只有一个：让**同一口径的不同写法**（`r['x']` vs `CAST(x AS …)`）折成同一个串。
 * @param {string} sql @returns {string}
 */
export function normalize(sql) {
  let s = stripLineComments(sql)
  s = foldCasts(s)
  s = s.replace(/\br\s*\[\s*'([a-z_]+)'\s*\]/gi, '$1') // r['col'] → col
  s = s.replace(/::\s*[a-z0-9_]+(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi, '') // ::int / ::numeric(20,2)
  s = s.replace(/\bfrom\s+read_parquet\s*\([^)]*\)\s*r\b/gi, 'from src') // 湖扫描 → src
  s = s.replace(/\bfrom\s+"lguard"/gi, 'from src') // 管线物化表 → src
  s = s.replace(/\{\{\s*ref\s*\(\s*'[^']+'\s*\)\s*\}\}/gi, 'src') // dbt ref → src
  s = s.replace(/\s+/g, '')
  return s.toLowerCase()
}

/**
 * 展开脚本里的 `NAME="…"` 单行赋值（`${GIFT}` → 判别式本体）。
 * **为什么必须做**：脚本把销售侧判别式抽成了 shell 变量 `GIFT`，`SQL_LAKE` 里写的是 `${GIFT}`
 * —— 不展开的话门禁看到的是占位符，会**误报「缺销售侧判别式」**（本门禁首跑就咬到这一口）。
 * 找不到的变量原样留下（不去猜）。
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
 * 抽出脚本里的 `SQL_LAKE="…"` 字面量（抽不到 → null）。
 * @param {string} text @returns {string | null}
 */
function extractSqlLake(text) {
  const m = /^\s*SQL_LAKE="([\s\S]*?)"\s*$/m.exec(text)
  return m?.[1] === undefined ? null : m[1]
}

/**
 * 从管线 JSON 里抽出 `lagg` 节点的 sql（抽不到 → null）。
 * @param {string} text @returns {string | null}
 */
function extractLaggSql(text) {
  /** @type {{ nodes?: Array<{ id?: string, data?: { properties?: { sql?: string } } }> }} */
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const node = (doc.nodes ?? []).find((n) => n.id === PIPELINE_SQL_NODE)
  return node?.data?.properties?.sql ?? null
}

/**
 * 抽出 `ret_side AS ( … )` 的 CTE 体（按括号配对；抽不到 → null）。
 * @param {string} sql @returns {string | null}
 */
function extractRetSide(sql) {
  const m = /\bret_side\s+as\s*\(/i.exec(sql)
  if (m === null) return null
  const open = m.index + m[0].length - 1
  let depth = 0
  for (let i = open; i < sql.length; i += 1) {
    const c = sql[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return sql.slice(open + 1, i)
    }
  }
  return null
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

  // ── 五份副本取文本 + 规范化 ─────────────────────────────────────────────────
  /** @type {Record<string, string>} */
  const raw = {}
  /** @type {Record<string, string>} */
  const norm = {}
  /** @type {Record<string, string | null>} */
  const texts = {}
  for (const copy of COPIES) texts[copy.key] = readIfExists(copy.path)

  const scriptText = texts.script ?? null
  const pipelineText = texts.pipeline ?? null

  for (const copy of COPIES) {
    if (texts[copy.key] !== null) continue
    violations.push({ file: copy.path, message: '副本不在场——口径靠这几份互相印证，少一份门禁就没得比（是删了、改名了，还是搬走了？）' })
  }

  if (scriptText !== null) {
    const lake = extractSqlLake(expandShellVars(scriptText))
    if (lake === null) {
      violations.push({
        file: CALIBER_PATHS.script,
        message: '抽不到 `SQL_LAKE="…"` 字面量——脚本结构变了，门禁无从判（改名/拆函数都要同步本门禁）',
      })
    } else raw.script = lake
  }
  if (pipelineText !== null) {
    const lagg = extractLaggSql(pipelineText)
    if (lagg === null) {
      violations.push({
        file: CALIBER_PATHS.pipeline,
        message: `抽不到节点 \`${PIPELINE_SQL_NODE}\` 的 sql——节点改名/搬走了，门禁无从判（同步本门禁的 PIPELINE_SQL_NODE）`,
      })
    } else raw.pipeline = lagg
  }
  for (const copy of COPIES) {
    const t = texts[copy.key]
    if (t === null) continue
    if (copy.key !== 'script' && copy.key !== 'pipeline') raw[copy.key] = t
  }
  for (const [k, v] of Object.entries(raw)) norm[k] = normalize(v)

  const SALE_GIFT = normalize(SALE_GIFT_SQL)
  const RET_GIFT = normalize(RET_GIFT_SQL)
  const HALVING = normalize(HALVING_SQL)
  const RET_SUM = normalize(RET_SUM_SQL)

  // ── 判据 ①②：两侧赠品判别式在各副本里逐字在场 ───────────────────────────────
  /** @type {Array<{ flag: 'saleGift' | 'retGift', label: string, atom: string, why: string }>} */
  const giftChecks = [
    {
      flag: 'saleGift',
      label: '销售侧赠品判别式',
      atom: SALE_GIFT,
      why: '赠品行按判别式排除（正典 docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md §0）',
    },
    {
      flag: 'retGift',
      label: '退货侧赠品判别式（绝对值形态）',
      atom: RET_GIFT,
      why: '赠品行不进销售侧，其退货也不该进退货侧；源侧退货行**符号不一致**，带负号那类不排会反向加回（#908 / #917）',
    },
  ]
  for (const check of giftChecks) {
    for (const copy of COPIES) {
      if (!copy[check.flag]) continue
      const text = norm[copy.key]
      if (text === undefined || text.includes(check.atom)) continue
      violations.push({
        file: copy.path,
        message:
          `缺${check.label}（规范化后逐字比对不中）—— ${check.why}；` +
          '各副本必须在**同一次改动**里一起改（判据清单见本文件头注）',
      })
    }
  }

  // ── 判据 ③：销售侧折半形态（两份「湖侧自算」对拍副本）──────────────────────
  for (const copy of COPIES) {
    if (!copy.recon) continue
    const text = norm[copy.key]
    if (text === undefined || text.includes(HALVING)) continue
    violations.push({
      file: copy.path,
      message:
        `销售侧折半形态 \`${HALVING_SQL}\` 不在场——除法必须在**逐单层**（sum 的参数表达式里），` +
        '不是先和后除；逐分归零是按这个形状验证的（别引入第三种除法形态）',
    })
  }

  // ── 判据 ④：退货侧不套折半（两份对拍副本的 ret_side 体）──────────────────────
  for (const copy of COPIES) {
    if (!copy.recon) continue
    const key = copy.key
    const sql = raw[key]
    if (sql === undefined) continue
    const body = extractRetSide(sql)
    if (body === null) {
      violations.push({
        file: CALIBER_PATHS[/** @type {keyof typeof CALIBER_PATHS} */ (key)],
        message: '抽不到 `ret_side AS ( … )` —— 退货侧的 CTE 改名/改形了，判据 ④ 无从判（同步本门禁）',
      })
      continue
    }
    // ⚠️ 必须在**规范化后**判 `/`：裸文本里 `read_parquet('s3://…/system_book=…')` 的路径满是 `/`，
    //    直接 `includes('/')` 会**恒红**（假阳性）。规范化会把湖扫描折成 `from src`，路径随之消失。
    if (normalize(body).includes('/')) {
      violations.push({
        file: CALIBER_PATHS[/** @type {keyof typeof CALIBER_PATHS} */ (key)],
        message:
          '退货侧套了折半（`ret_side` 体内出现 `/`）—— 退货项是**全额冲减、不套折半**：' +
          '整单退货的 `order_total_money = −Σsale_money`，套折半恒得 0（spec §1.2 要点 1）',
      })
    }
    if (!normalize(body).includes(RET_SUM)) {
      violations.push({
        file: CALIBER_PATHS[/** @type {keyof typeof CALIBER_PATHS} */ (key)],
        message: `退货侧体内没有 \`${RET_SUM_SQL}\` —— 全额冲减的形态本体不见了（退货侧 = Σ(sale_money + order_detail_share_discount)）`,
      })
    }
  }

  // ── 判据 ⑤：容差地板同源（脚本 env 默认值 ↔ recon_tolerances.csv）────────────
  const tolText = readIfExists(TOLERANCES_PATH)
  if (tolText === null) {
    violations.push({ file: TOLERANCES_PATH, message: '容差配置不在场——判据 ⑤ 无从比（它是容差的**新家**，2026-10-18 起）' })
  } else if (scriptText !== null) {
    const tols = parseTolerances(tolText)
    for (const b of TOLERANCE_BINDINGS) {
      const actual = envDefault(scriptText, b.env)
      const row = tols.get(b.control)
      if (actual === null) {
        violations.push({ file: CALIBER_PATHS.script, message: `读不到 \`${b.env}=\${${b.env}:-…}\` —— 容差常量改名/改形了（判据 ⑤ 无从比）` })
        continue
      }
      if (row === undefined) {
        violations.push({ file: TOLERANCES_PATH, message: `缺 \`${b.control}\` 行——脚本的 \`${b.env}\` 没有可比的对象` })
        continue
      }
      const expected = row[/** @type {'abs_tol' | 'pct_tol'} */ (b.column)]
      if (!numEq(actual, expected)) {
        violations.push({
          file: CALIBER_PATHS.script,
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
  console.log(`${SCRIPT_NAME}: OK（口径五副本同源 + 容差地板同源）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
