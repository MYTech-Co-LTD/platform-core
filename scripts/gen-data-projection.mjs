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
//   · `--seed`  从现存投影反抽 `expr` 回填契约（只填空缺项；见 Phase 3）
//
// ## 未回填 `expr` 的契约一律跳过
//
// `expr` 是「该列从输入关系到该列的完整 SQL 表达式」。契约 `columns[].expr` 缺省（空串）=
// 尚未回填 ⇒ **整份契约跳过**（③ 与 ④ 都不动；否则会拿空表达式覆盖掉现存投影）。
// 这正是「先 --seed 回填，再生成」的两步式（设计稿 §4）。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONTRACT_DIR,
  NON_CONTRACT,
  collectJson,
  findProducerPipelines,
  findProjectionNode,
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
 * 列区边界：开头 `SELECT` 的起点 … 顶层 `FROM` 前那个换行的下标。
 * 找不着（无 SELECT / 无顶层 FROM）返回 null。
 *
 * @param {string} sql
 * @returns {{ selectStart: number, fromStart: number } | null}
 */
export function selectListBounds(sql) {
  const sel = /^\s*select\b/i.exec(sql)
  if (!sel) return null
  const rest = sql.slice(sel.index)
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
 * 生成主流程。对每份**已回填 `expr`** 的契约，重写其全部生产者管线的投影节点列区。
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
    if (c.columns.some((x) => x.expr === '')) {
      // 未回填 `expr` ⇒ 不动任何产出（否则会拿空表达式覆盖现存投影）。
      missing++
      continue
    }
    const colNames = c.columns.map((x) => x.name)

    // ③ 生产面：该契约的每条生产者管线各重写其投影节点。
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
      const next = rewriteSelectList(proj.sql, buildPipelineSelect(c.columns))
      if (next === proj.sql) continue
      changed++
      if (!opts.check) {
        for (const n of doc.nodes) if (n?.id === proj.id) n.data.properties.sql = next
        writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n')
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
  if (flag === 'seed') {
    console.error('gen-data-projection: --seed 在 Phase 3 落地')
    process.exit(2)
  }
  process.exit(runGenerate(root, { check: flag === 'check' }))
}
