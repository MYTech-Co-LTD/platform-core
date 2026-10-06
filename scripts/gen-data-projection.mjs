#!/usr/bin/env node
// scripts/gen-data-projection.mjs — 契约 → 管线投影 / staging 投影生成器。
//
// 设计稿：docs/superpowers/specs/2026-10-06-contract-projection-generator-design.md。
// 让 `contracts/**/*.json` 成为湖列集的**唯一事实源**：改契约一处，生成器重写
//   ③ 生产面（管线 `code.sql` 投影）与 ④ 消费面（dbt staging 投影）。
//
// ## 形态契约：只重写「SELECT … 顶层 FROM」之间的列区
//
// `FROM` 及其之后**逐字保留**（`FROM input o CROSS JOIN UNNEST(…)` / `from read_parquet(…) r, … sealed
// where …` 都是**管线/模型结构**，不是契约能决定的）。故本生成器**不是**通用 SQL 格式化器——
// 它只认「选列里无子查询」的两种现存形态，越界即报错（fail loud，不猜）。
//
// ## 三档 CLI
//
//   · 默认     写文件（生成物 == committed 的**产出**动作）
//   · `--check` 若任一文件将被改动则 exit 1（CI 用；判据「生成物没被手改」）
//   · `--seed`  从现存投影反抽 `expr` 回填契约（只填空缺项，已有值不覆盖）。写回用**就地文本插入**
//               （只在该列对象里插 `"expr"`），**保留契约原有紧凑格式** —— 不重排（见 seedContractText）。
//
// ## 未回填 `expr` 的契约一律跳过
//
// `expr` 是「该列从输入关系到该列的完整 SQL 表达式」。契约 `columns[].expr` 缺省（空串）=
// 尚未回填 ⇒ **整份契约跳过**（③ 与 ④ 都不动；否则会拿空表达式覆盖掉现存投影）。
// 这正是「先 --seed 回填，再生成」的两步式（设计稿 §4）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONTRACT_DIR,
  NON_CONTRACT,
  collectJson,
  findProducerPipelines,
  findProjectionNode,
  maskSqlComments,
  readContractDoc,
} from './lib/data-contract.mjs'

/**
 * 顶层逗号切分（忽略括号与单引号内的逗号）。
 *
 * @param {string} s
 * @returns {string[]}
 */
export function splitTopLevelCommas(s) {
  /** @type {string[]} */
  const out = []
  let depth = 0
  let quote = false
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      cur += c
      if (c === "'") quote = false
      continue
    }
    if (c === "'") {
      quote = true
      cur += c
      continue
    }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

/**
 * 列区边界：**第一个** `SELECT` 的起点 … 紧随其后的顶层 `FROM` 前那个换行的下标。
 * 找不着（无 SELECT / 无顶层 FROM）返回 null。
 *
 * ⚠️ 先在**掩掉注释**的文本上定位（索引与原串等长，可直接用于原串）——两个原因：
 *   ① 管线投影以 `SELECT` 开头，但 **staging 模型不是**：它前面有 `{{ config(...) }}` 块
 *      与文件头注释（`-- …`）。若锚在 `^\s*select`，staging 恒返回 null ⇒ ④ 永远抛错。
 *   ② 注释里「select」二字满天飞（本仓散文式注释尤甚）⇒ 不掩就会锚错。
 * 定位「第一个 `select`」而非「行首 select」：Jinja 块与注释已被掩/跳过后，第一个 `select`
 * 就是投影关键字。越界形态（选列里带子查询等）由调用方 `rewriteSelectList` 抛错兜底。
 *
 * @param {string} sql
 * @returns {{ selectStart: number, fromStart: number } | null}
 */
export function selectListBounds(sql) {
  const masked = maskSqlComments(sql)
  const sel = /\bselect\b/i.exec(masked)
  if (!sel) return null
  const rest = masked.slice(sel.index)
  const from = /\n\s*from\b/i.exec(rest)
  if (!from) return null
  return { selectStart: sel.index, fromStart: sel.index + from.index }
}

/**
 * 用新的列区替换旧的；无法界定即抛错（不猜）。
 *
 * @param {string} sql
 * @param {string} newSelectList
 * @returns {string}
 */
export function rewriteSelectList(sql, newSelectList) {
  const b = selectListBounds(sql)
  if (!b) throw new Error('无法界定 SELECT … 顶层 FROM —— 该投影不支持生成')
  return sql.slice(0, b.selectStart) + newSelectList + sql.slice(b.fromStart)
}

/**
 * 契约列 → 管线投影列区文本。
 *
 * @param {{ name: string, expr: string }[]} columns
 * @returns {string}
 */
export function buildPipelineSelect(columns) {
  return 'SELECT\n' + columns.map((c) => `  ${c.expr} AS ${c.name}`).join(',\n')
}

/**
 * 从现有投影反抽 `别名 → 表达式`（`--seed` 用）。
 *
 * @param {string} sql
 * @returns {Record<string, string>}
 */
export function extractPipelineExprs(sql) {
  const b = selectListBounds(sql)
  if (!b) return {}
  const body = sql.slice(b.selectStart, b.fromStart).replace(/^\s*select\s+/i, '')
  /** @type {Record<string, string>} */
  const out = {}
  for (const part of splitTopLevelCommas(body)) {
    const t = part.trim()
    const m = /\bAS\s+([a-z][a-z0-9_]*)\s*$/i.exec(t)
    if (m) out[m[1]] = t.slice(0, m.index).trim()
  }
  return out
}

/**
 * 契约类型 → staging 的 DuckDB SQL 类型文本。
 *
 * ⚠️ **宽度与精度必须逐列照抄契约，不能塌成「通用整数」或裸 `numeric`**：
 *   · `int` 是 **32 位** —— 把契约的 `bigint` 写成 `::int` 会把 INT64 **窄化**成 INT32
 *     （实测 `3000000000::BIGINT::int` ⇒ `Conversion Error … out of range for INT32`）。
 *   · 裸 `::numeric` 在 DuckDB 是 **DECIMAL(18,3)** —— 把 `decimal(18,8)` 写成 `::numeric`
 *     会**静默**把值截断到 3 位小数（实测 `340.34443333::DECIMAL(18,8)::numeric = 340.344`）。
 * 契约 `type` 本身就是「DuckDB SQL 类型名」（见 `_schema.schema.json` 的 `columnType` 描述）
 * ⇒ cast 目标 = 契约类型本身，这正是设计稿 §2.4「每列显式 ::type、类型不变」的落地形态。
 *
 * @param {{ type: string, precision?: number, scale?: number }} col
 * @returns {string}
 */
export function sqlType(col) {
  if (col.type === 'decimal') {
    return typeof col.precision === 'number' && typeof col.scale === 'number'
      ? `numeric(${col.precision},${col.scale})`
      : 'numeric'
  }
  if (col.type === 'integer') return 'int'
  // bigint / smallint / varchar / date / timestamp / boolean / … 逐字照抄契约类型
  return col.type
}

/**
 * 契约列 → staging 列区文本（每列显式 cast；`org` 注入在 orgAfter 之后）。
 *
 * @param {{ name: string, type: string, precision?: number, scale?: number }[]} columns
 * @param {string} orgAfter
 * @returns {string}
 */
export function buildStagingSelect(columns, orgAfter) {
  /** @type {string[]} */
  const lines = []
  for (const c of columns) {
    lines.push(`  r['${c.name}']::${sqlType(c)} as ${c.name}`)
    if (c.name === orgAfter) lines.push('  {{ subject_org() }}       as org')
  }
  return 'select\n' + lines.join(',\n')
}

/**
 * 每条**生产者管线**里定位到的投影节点（③ 的定位面）——`--seed` 与生成共用同一实现。
 *
 * @param {string} rootDir
 * @param {{ prefix: string, columns: { name: string }[] }} c
 * @returns {{ abs: string, doc: any, id: string, sql: string }[]}
 */
function producerProjections(rootDir, c) {
  const colNames = c.columns.map((x) => x.name)
  /** @type {{ abs: string, doc: any, id: string, sql: string }[]} */
  const out = []
  for (const p of findProducerPipelines(rootDir, c.prefix)) {
    const abs = join(rootDir, p)
    /** @type {any} */
    let doc
    try {
      doc = JSON.parse(readFileSync(abs, 'utf8'))
    } catch {
      continue
    }
    const proj = findProjectionNode(doc, colNames)
    if (!proj) continue
    out.push({ abs, doc, id: proj.id, sql: proj.sql })
  }
  return out
}

/**
 * 在一份契约**文本**里给若干列就地插入 `expr`（`--seed` 用；**保持原文件格式**，不重排）。
 *
 * 契约 `columns[]` 的元素是列对象（单行、多行两种形态都有）。本函数定位 `"name": "<列名>"`
 * 所在的那个对象，用括号配对（跳过字符串）找到它的闭合 `}`，把 `"expr"` 插在它前面 ——
 * **只改这一处，其余字节逐字保留** ⇒ `git diff` 只显示新增的 `expr`，不是整份文件重排
 * （对比 `JSON.stringify(doc,null,2)`：那会把 3 份契约从 ~220 行膨胀到 ~950 行的纯格式 churn）。
 * 某个待填列没定位到、或对象括号不配对 ⇒ **抛错**（fail loud，不产半成品）。
 *
 * @param {string} text
 * @param {Record<string, string>} fills 列名 → expr（只含**待填**的列）
 * @returns {string}
 */
export function seedContractText(text, fills) {
  let out = text
  for (const [name, expr] of Object.entries(fills)) {
    // 列名是 `[a-z_][a-z0-9_]*`；转义以防将来出现正则元字符（如列名 `type`）
    const key = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`"name"\\s*:\\s*${key}`).exec(out)
    if (!m) throw new Error(`--seed: 契约文本里找不到列 ${name} 的对象`)
    const open = out.lastIndexOf('{', m.index)
    if (open < 0) throw new Error(`--seed: 列 ${name} 的对象起点异常`)
    // 括号配对，找该对象的闭合 `}`（跳过双引号字符串，含转义）
    let depth = 0
    let i = open
    let inStr = false
    for (; i < out.length; i++) {
      const ch = out[i]
      if (inStr) {
        if (ch === '\\') i++
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
    if (depth !== 0) throw new Error(`--seed: 列 ${name} 的对象括号不配对`)
    const before = out.slice(0, i)
    const body = before.replace(/\s+$/, '')
    const ws = before.slice(body.length)
    if (ws.includes('\n')) {
      // 多行对象：`"expr"` 另起一行，缩进沿用最后一个字段行（与 JSON.stringify(…, 2) 同形）
      const fieldIndent = /(?:^|\n)([ \t]*)\S[^\n]*$/.exec(body)?.[1] ?? ''
      out =
        body +
        ',\n' +
        fieldIndent +
        `"expr": ${JSON.stringify(expr)}\n` +
        ws.replace(/^.*\n/, '') +
        out.slice(i)
    } else {
      // 单行对象：`… "desc" }` ⇒ `… "desc", "expr": … }`
      out = body + `, "expr": ${JSON.stringify(expr)}` + ws + out.slice(i)
    }
  }
  return out
}

/**
 * 生成主流程。
 *
 * · 默认 / `--check`：对每份**已回填 `expr`** 的契约，重写其全部生产者管线的投影节点列区（③）
 *   与对应 staging 模型的列区（④，`org` 注入在 `system_book` 之后，无则首列之后）。
 * · `--seed`：从现存投影反抽 `expr`，**只回填空缺列**（已有值不覆盖）写回契约；不动 ③/④。
 *
 * @param {string} rootDir 仓根
 * @param {{ seed?: boolean, check?: boolean }} [opts]
 * @returns {number} 退出码（0 = 已对齐；`--check` 下有将被改动者 = 1）
 */
export function runGenerate(rootDir, opts = {}) {
  const contracts = collectJson(rootDir, CONTRACT_DIR).filter(
    (p) => !NON_CONTRACT.has(p.split('/').pop() ?? ''),
  )
  let changed = 0
  let missing = 0
  for (const rel of contracts) {
    const c = readContractDoc(rootDir, rel)
    if (!c) continue
    const colNames = c.columns.map((x) => x.name)
    const projections = producerProjections(rootDir, c)

    if (opts.seed) {
      // 从现存投影反抽 `expr` → 只回填**空缺**列（已有值不覆盖）。
      /** @type {Record<string, string>} */
      const fills = {}
      for (const proj of projections) {
        const exprs = extractPipelineExprs(proj.sql)
        for (const col of c.columns) {
          if (col.expr !== '' || exprs[col.name] === undefined) continue
          if (fills[col.name] !== undefined && fills[col.name] !== exprs[col.name]) {
            throw new Error(`--seed: ${rel} 列 ${col.name} 在多条生产者管线里表达式不一致`)
          }
          fills[col.name] = exprs[col.name]
        }
      }
      if (Object.keys(fills).length > 0) {
        const abs = join(rootDir, rel)
        const raw = readFileSync(abs, 'utf8')
        const next = seedContractText(raw, fills)
        if (next !== raw) {
          changed++
          if (!opts.check) writeFileSync(abs, next)
        }
      }
      if (c.columns.some((x) => x.expr === '' && fills[x.name] === undefined)) missing++
      continue
    }

    if (c.columns.some((x) => x.expr === '')) {
      // 未回填 `expr` ⇒ 不动任何产出（否则会拿空表达式覆盖现存投影）。
      missing++
      continue
    }

    // ③ 生产面：该契约的每条生产者管线各重写其投影节点。
    for (const proj of projections) {
      const next = rewriteSelectList(proj.sql, buildPipelineSelect(c.columns))
      if (next === proj.sql) continue
      changed++
      if (!opts.check) {
        for (const n of proj.doc.nodes) if (n?.id === proj.id) n.data.properties.sql = next
        writeFileSync(proj.abs, JSON.stringify(proj.doc, null, 2) + '\n')
      }
    }

    // ④ 消费面：staging 模型列区归一（每列显式 ::type）+ org 注入。
    const stgRel = `dbt/models/common/staging/stg_${c.domain}_${c.table}.sql`
    const stgAbs = join(rootDir, stgRel)
    if (existsSync(stgAbs)) {
      const stgSql = readFileSync(stgAbs, 'utf8')
      const orgAfter = colNames.includes('system_book') ? 'system_book' : (colNames[0] ?? '')
      const nextStg = rewriteSelectList(stgSql, buildStagingSelect(c.columns, orgAfter))
      if (nextStg !== stgSql) {
        changed++
        if (!opts.check) writeFileSync(stgAbs, nextStg)
      }
    }
  }
  if (missing > 0) {
    console.error(`gen-data-projection: ${missing} 份契约尚未回填 expr —— 生成器跳过（先跑 --seed）`)
  }
  return changed > 0 && opts.check ? 1 : 0
}

const invoked = process.argv[1]?.endsWith('scripts/gen-data-projection.mjs') ?? false
if (invoked) {
  // ⚠️ 位置参数（仓根）与旗标必须分开取：`argv[2]` 在 `--check` 形态下就是旗标本身，
  //    直接当 root 会拼出 `<cwd>/--check/contracts`（不存在）⇒ 静默 0 契约 ⇒ 闸恒绿而形同虚设。
  const args = process.argv.slice(2)
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd()
  const flag = args.includes('--check') ? 'check' : args.includes('--seed') ? 'seed' : ''
  const code = flag === 'seed' ? runGenerate(root, { seed: true }) : runGenerate(root, { check: flag === 'check' })
  process.exit(code)
}
