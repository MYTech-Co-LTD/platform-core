// scripts/lib/data-contract.mjs — 数据契约的**共享取列/定位库**。
//
// 为什么抽出来：`scripts/check-data-contract.mjs`（B10 门禁）与 `scripts/gen-data-projection.mjs`
// （契约生成器）要做同一批事——掩 SQL 注释、取投影别名、解析契约、找生产者管线、找投影节点。
// 两处各写一份 = 判据迟早分叉（生成器认为的「投影节点」与门禁认为的不是同一个 ⇒ 生成器写绿、门禁报红）。
// 故此处是**唯一实现**，两方都 import。
//
// 设计稿：docs/superpowers/specs/2026-10-06-contract-projection-generator-design.md。
// 本文件是**纯函数 + 只读文件**——无写盘、无网络、无其它副作用。
//
// 用法：`import { readContractDoc, findProjectionNode, … } from './lib/data-contract.mjs'`。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 契约目录（相对仓根）。 */
export const CONTRACT_DIR = 'contracts'
/** 管线目录（相对仓根）——生产者的推导面。 */
export const PIPELINE_DIRS = ['deploy/duckle/console/pipelines', 'duckle']
/** 契约里不是「真契约」的文件名（元 schema 与模板）。 */
export const NON_CONTRACT = new Set(['_schema.schema.json', '_template.contract.json'])
/** dbt 在 staging 层注入的列（不属契约；见 dbt/macros/subject_org.sql）。 */
export const INJECTED_STAGING_COLUMNS = ['org']

/**
 * 掩掉 SQL 注释（`--` 行注释与块注释）。**不掩字符串**——取列正则只认小写标识符，
 * 字符串里的内容不会误命中。与 check-tenant-isolation / check-data-models 同一手法。
 *
 * @param {string} src
 * @returns {string}
 */
export function maskSqlComments(src) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '-' && n === '-') {
        state = 'line'
        out += '  '
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i++
      } else out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += ' '
      continue
    }
    // block
    if (c === '*' && n === '/') {
      state = 'code'
      out += '  '
      i++
    } else out += c === '\n' ? '\n' : ' '
  }
  return out
}

/**
 * 从管线 `code.sql` 的 SQL 里取输出别名序列。
 *
 * 只认**小写**标识符（排除 `CAST(x AS JSON)` 这类大写类型名），且别名后**不许紧跟 `(`**
 * （排除 `CROSS JOIN UNNEST(...) AS u(d)` 那种表别名）。
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function extractPipelineAliases(sql) {
  /** @type {string[]} */
  const out = []
  const re = /\bAS\s+([a-z][a-z0-9_]*)\b(?!\s*\()/g
  let m
  while ((m = re.exec(maskSqlComments(sql))) !== null) out.push(m[1])
  return out
}

/**
 * 从 staging 模型的 SQL 里取投影别名序列（先掩注释；`as` 一律小写是本仓写法）。
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function extractStagingAliases(sql) {
  /** @type {string[]} */
  const out = []
  const re = /\bas\s+([a-z][a-z0-9_]*)\b/g
  let m
  const masked = maskSqlComments(sql)
  while ((m = re.exec(masked)) !== null) out.push(m[1])
  return out
}

/**
 * 递归收集目录下的 `.json` 文件（相对仓根的 posix 路径）。
 *
 * @param {string} root
 * @param {string} relDir
 * @returns {string[]}
 */
export function collectJson(root, relDir) {
  const abs = join(root, relDir)
  if (!existsSync(abs)) return []
  /** @type {string[]} */
  const out = []
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${ent.name}`
    if (ent.isDirectory()) out.push(...collectJson(root, rel))
    else if (ent.name.endsWith('.json')) out.push(rel)
  }
  return out
}

/**
 * 读一份契约的关键字段。**单形状**（字段恒在）——缺字段时由调用方报违规。
 * `columns[].expr` 缺失时回落空串（生成器据此判「未回填」）。
 * `precision` / `scale` 只在 `decimal` 列上有值 —— 生成器用它产出 `numeric(p,s)` 的**精确**
 * cast 目标（裸 `numeric` 在 DuckDB 会塌成 DECIMAL(18,3)，见 gen-data-projection 的 sqlType）。
 *
 * @param {string} root
 * @param {string} rel
 * @returns {{ rel: string, domain: string, table: string, prefix: string, schemaVersion: unknown, consumerVersion: unknown, columns: { name: string, type: string, nullable: boolean, expr: string, precision?: number, scale?: number }[] } | null}
 */
export function readContractDoc(root, rel) {
  /** @type {any} */
  let doc
  try {
    doc = JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch {
    return null
  }
  const layout = doc && typeof doc.layout === 'object' && doc.layout !== null ? doc.layout : {}
  const cols = Array.isArray(doc?.columns) ? doc.columns : []
  return {
    rel,
    domain: String(doc?.domain ?? ''),
    table: String(doc?.table ?? ''),
    prefix: String(layout.prefix ?? ''),
    schemaVersion: doc?.schemaVersion,
    consumerVersion: doc?.consumerVersion,
    columns: cols.map((/** @type {any} */ c) => ({
      name: String(c?.name ?? ''),
      type: String(c?.type ?? ''),
      nullable: Boolean(c?.nullable),
      expr: String(c?.expr ?? ''),
      precision: typeof c?.precision === 'number' ? c.precision : undefined,
      scale: typeof c?.scale === 'number' ? c.scale : undefined,
    })),
  }
}

/**
 * 生产者 = 有 `snk.*` 节点的属性里写着该 prefix 的管线（**排除只读的 `src.*` 引用**，
 * 该收窄见 #447，与 B10 规则② 同源）。
 *
 * @param {string} root
 * @param {string} prefix
 * @returns {string[]}
 */
export function findProducerPipelines(root, prefix) {
  return PIPELINE_DIRS.flatMap((d) => collectJson(root, d)).filter((p) => {
    try {
      /** @type {any} */
      const doc = JSON.parse(readFileSync(join(root, p), 'utf8'))
      const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
      return nodes.some(
        (/** @type {any} */ n) =>
          typeof n?.data?.componentId === 'string' &&
          n.data.componentId.startsWith('snk.') &&
          JSON.stringify(n?.data?.properties ?? {}).includes(prefix),
      )
    } catch {
      return false
    }
  })
}

/**
 * 投影节点 = 该管线里**唯一**一个 `code.sql`，其输出别名序列 == 契约列序（逐列同序）。
 * 返回 null 表示 0 个或 ≥2 个（调用方报错，不猜）。
 *
 * @param {unknown} doc
 * @param {string[]} columnNames
 * @returns {{ id: string, sql: string, aliases: string[] } | null}
 */
export function findProjectionNode(doc, columnNames) {
  /** @type {any} */
  const d = doc
  const nodes = Array.isArray(d?.nodes) ? d.nodes : []
  /** @type {{ id: string, sql: string, aliases: string[] }[]} */
  const hits = []
  for (const n of nodes) {
    if (n?.data?.componentId !== 'code.sql') continue
    const sql = n?.data?.properties?.sql
    if (typeof sql !== 'string') continue
    const aliases = extractPipelineAliases(sql)
    if (aliases.length > 0 && aliases.join('\u0000') === columnNames.join('\u0000')) {
      hits.push({ id: String(n?.id ?? ''), sql, aliases })
    }
  }
  return hits.length === 1 ? hits[0] : null
}
