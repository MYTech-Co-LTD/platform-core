#!/usr/bin/env node
// check-org-scope.mjs — 租户隔离第二道防线（B14；数据宪法 2026-11-23 §8「隔离纵深」）。
//
// 用法：pnpm exec tsx scripts/check-org-scope.mjs [rootDir]   （rootDir 默认仓库根；fixture 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-org-scope: OK…`（带检查面计数，防空转）；
//       有违规 → exit 1，stderr 每条一行 `相对路径:行号: [org谓词] 说明`。
// 纯静态（不连库）⇒ 本地可随时跑、CI 挂在 gates（与 lint-architecture 同 job）。
//
// ── 判据 ─────────────────────────────────────────────────────────────────────────
// 第一道防线（纪律 + 已固化门禁：每表 org 列、每查询 org 谓词）靠评审与 check-tenant-isolation
// 的「表必须有 org」；本门禁补的是**代码面**那半：对**租户表**的读/改/删，SQL 字面量必须带
// `org`，否则违规。目标是上线前把「忘写 org 谓词」从运行期事故挪到构建期红灯——纵深防御的
// 价值不在门禁抓过多少，而在它让这类缺陷不可能悄悄上线。
//   1. **租户表集**（静态，从各模块 migrations 提取）：
//      · `create table [if not exists] <模块id>.<表> ( … org … )` ⇒ 租户表；
//      · 增量形态 `alter table <模块id>.<表> add column [if not exists] org …` ⇒ 租户表；
//      · 紧贴其上的 `-- global-table: <理由>` ⇒ 排除（tenant-isolation 同款标记，「这张表不是
//        租户数据表」，如全局字典/平台配置）。
//   2. **代码面**：`modules/<id>/**/*.ts(x)`（非 .test./.gen.）里提取 SQL 字面量；若字面量
//      引用**本模块**的租户表（`from` / `join` / `update` / `delete from`——`insert into` 不在
//      判据面，它无 where 语义，由「每行必须带 org 列」的 T1 管），则要求：
//        · 字面量含 `org`（词边界）⇒ 通过；或
//        · 字面量含 `-- org-exempt: <非空理由>` ⇒ 显式豁免（跨租户运维语句：保留策略清理、
//          健康统计等——**有意的**跨租户操作要可见，不许默默无 org）；空理由 ⇒ 违规；
//        · 字面量含 `${` 插值 ⇒ 动态放行（谓词拼在变量里，静态不可判——见「边界」）。
//
// ── 边界（都写在这里，别当成漏检） ────────────────────────────────────────────────
// · **动态插值面是盲的**：`where ${where}` 形态（本仓分页/筛选的常见写法）放行但不判定——
//   静态数据流分析判不出变量里有没有 org。放行数印在 OK 行（可见），不静默。收紧它需要
//   规约「where 构造必须从 org 谓词起步」（评审守），不在本门禁。
// · 判据是「字面量含 org」不是「WHERE 子句含 org」：`select org, … from t where id=$1`
//   这类形态本门禁放行（org 出现在列清单）——那是评审要抓的刁钻形态；本门禁抓的是**完全
//   没写 org** 的大头（纵深防御的性价比所在，别为边角把门禁做成 SQL 解析器）。
// · 只认自有 schema（三同纪律 id = schema）；跨 schema 读由 B1 + B13 管，本门禁不重复判。
// · 字面量提取是正则级（模板字面量内嵌嵌套模板会截断）——本仓 SQL 字面量形态简单；
//   真撞到误报，加 `-- org-exempt:` 或扩本脚本（方向安全：宁可让人改守卫）。
// · 静态表集是**保守近似**（读不到 dbt/脚本侧建的表，如数据面仓表 load_log/lemeng_daily_sealed
//   —— 它们不在模块 migrations 里，天然不在租户表集 ⇒ 不判）。漏表 = 检查面缩小而非误报；
//   OK 行印表集大小，空转自检在下面。
// · **空转自检**：全仓租户表集为空 ⇒ 违规——「门禁看不见任何表」比误报危险（fetch-depth 教训）。
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { maskSql, parseCreateTableLine } from './check-tenant-isolation.mjs'

export const SCRIPT_NAME = 'check-org-scope'
const LABEL = 'org谓词'
const DEFAULT_MIGRATIONS_DIR = 'migrations'
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.tmp'])
const CODE_EXT_RE = /\.(ts|tsx)$/
const SKIP_FILE_RE = /\.(test|gen)\./
/** 豁免标记（SQL 注释形态，理由必填）。空白用 [ \t] 不用 \s：\s 会跨行，把下一行 SQL
 *  当成「理由」，空理由就判不出来了（开发期 fixture 实测踩到）。 */
const EXEMPT_RE = /--[ \t]*org-exempt:[ \t]*([^\n]*)/g
/** 租户表引用的四个动词（不含 into——insert 不在此判据面） */
const TARGET_RE = /\b(from|join|update|delete\s+from)\s+([a-z_]+)\.([a-z_][a-z_0-9]*)/gi
/** 增量迁移加 org 列（demo 003 形态） */
const ALTER_ORG_RE = /\balter\s+table\s+(?:if\s+exists\s+)?([a-z_]+)\.([a-z_][a-z_0-9]*)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?org\b/i

/**
 * @typedef {{ file: string, line: number | null, message: string }} Violation
 * @typedef {{ id: string, dirRel: string, migrationsFilСs: string[], codeFiles: string[] }} ModuleFiles
 * @typedef {{ tables: Set<string>, violations: Violation[], markerCount: number }} TenantTables
 * @typedef {{ statements: number, dynamic: number, exempt: number, violations: Violation[] }} CodeScan
 */

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join('/')

/** 递归收集文件（跳过依赖/产物目录） */
/** @param {string} dir @param {(rel: string) => boolean} accept @returns {Promise<string[]>} */
async function walk(dir, accept) {
  /** @type {string[]} */
  const out = []
  /** @param {string} d @param {string} rel */
  const rec = async (d, rel) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await rec(path.join(d, e.name), rel === '' ? e.name : `${rel}/${e.name}`)
      } else if (accept(e.name)) {
        out.push(rel === '' ? e.name : `${rel}/${e.name}`)
      }
    }
  }
  await rec(dir, '')
  return out
}

/**
 * 收集模块与其迁移/代码文件清单。manifest 缺失/YAML 挂 ⇒ 跳过（合法性归 check-manifests）；
 * 无 migrations 目录 ⇒ 无迁移面（表集贡献为空，合法：模块可以不建表）。
 * @param {string} rootDir @returns {Promise<Array<{ id: string, dirRel: string, migrationsDir: string, codeFiles: string[] }>>}
 */
export async function collectModules(rootDir) {
  const modulesDir = path.join(rootDir, 'modules')
  /** @type {Array<{ id: string, dirRel: string, migrationsDir: string, codeFiles: string[] }>} */
  const out = []
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await readdir(modulesDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue
    const dirRel = `modules/${e.name}`
    /** @type {any} */
    let doc
    try {
      doc = parseYaml(await readFile(path.join(modulesDir, e.name, 'manifest.yaml'), 'utf8'))
    } catch {
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    const migrationsDirRel = typeof doc.migrations?.dir === 'string' ? doc.migrations.dir : DEFAULT_MIGRATIONS_DIR
    out.push({
      id: typeof doc.id === 'string' ? doc.id : e.name,
      dirRel,
      migrationsDir: path.join(modulesDir, e.name, migrationsDirRel),
      codeFiles: (await walk(path.join(rootDir, dirRel), (n) => CODE_EXT_RE.test(n) && !SKIP_FILE_RE.test(n)))
        .map((rel) => `${dirRel}/${rel}`),
    })
  }
  return out
}

/**
 * 从模块 migrations 提取租户表集（静态保守近似；见头注「边界」）。
 * global-table 标记紧贴 create 行（中间只许空行——注释在代码位掩码后即空白行）。
 * @param {string} rootDir @param {{ id: string, dirRel: string, migrationsDir: string }} mod
 * @returns {Promise<TenantTables>}
 */
export async function tenantTablesOf(rootDir, mod) {
  /** @type {Set<string>} */
  const tables = new Set()
  /** @type {Violation[]} */
  const violations = []
  let markerCount = 0
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await readdir(mod.migrationsDir, { withFileTypes: true })
  } catch {
    return { tables, violations, markerCount } // 无 migrations/ ⇒ 本模块不建表（合法形态）
  }
  const sqlFiles = entries.filter((f) => f.isFile() && f.name.endsWith('.sql')).map((f) => f.name).sort()
  for (const name of sqlFiles) {
    const rel = toPosix(path.join(mod.dirRel, path.relative(path.join(rootDir, mod.dirRel), mod.migrationsDir), name))
    const text = await readFile(path.join(mod.migrationsDir, name), 'utf8')
    const codeLines = maskSql(text, false).split('\n')
    const markerLines = maskSql(text, true).split('\n')
    for (let i = 0; i < codeLines.length; i++) {
      const hit = parseCreateTableLine(codeLines[i])
      if (hit.kind !== 'table' || hit.schema !== mod.id) continue
      // 块范围：从 create 行到含 `);` 的行使之闭合（无括号建表形态不可能——create table 必有列定义）
      let block = codeLines[i]
      let j = i
      while (!/\)\s*;/.test(block) && j + 1 < codeLines.length && j - i < 200) {
        j++
        block += '\n' + codeLines[j]
      }
      if (!/\borg\b/.test(block)) continue
      // global-table 标记：向上跳过空行（代码位掩码后注释=空白），紧邻首行须是标记
      let k = i - 1
      while (k >= 0 && codeLines[k].trim() === '') k--
      const marker = k >= 0 ? /^\s*--\s*global-table\s*:\s*(.*)$/.exec(markerLines[k]) : null
      if (marker) {
        markerCount++
        if (!marker[1].trim()) {
          violations.push({ file: rel, line: k + 1, message: 'global-table 标记没写理由——空理由 = 豁免变成默认勾选' })
        }
        continue // 全局表：不是租户表
      }
      tables.add(`${mod.id}.${hit.table}`)
    }
    // 增量形态：alter table <id>.<t> add column org
    for (let i = 0; i < codeLines.length; i++) {
      const m = ALTER_ORG_RE.exec(codeLines[i])
      if (m && m[1] === mod.id) tables.add(`${mod.id}.${m[2]}`)
    }
  }
  return { tables, violations, markerCount }
}

/**
 * JS 注释掩码（等长）：把 `//` 与 `/* *\/` 注释掩成空格，**字符串与模板原文保留**
 * （B14 要读的字面量在字符串里）。模板插值内不深入（见头注「边界」）。
 * @param {string} src @returns {string}
 */
export function maskJsComments(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line'
        out += '  '
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i++
      } else {
        if (c === "'") state = 'sq'
        else if (c === '"') state = 'dq'
        else if (c === '`') state = 'tpl'
        out += c
      }
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += ' '
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code'
        out += '  '
        i++
      } else out += c === '\n' ? '\n' : ' '
      continue
    }
    // 字符串/模板：保留原文；`\x` 转义跳过（不结束字符串）
    if (c === '\\' && i + 1 < src.length) {
      out += c + n
      i++
      continue
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
      out += c
      continue
    }
    if (c === '\n' && state !== 'tpl') {
      state = 'code' // 未闭合的单行串：行尾兜底（不跨行）
      out += c
      continue
    }
    out += c
  }
  return out
}

/** SQL 字面量（反引号模板 / 单双引号串；转义已处理） */
const LITERAL_RE = /(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gs

/**
 * 扫一个模块的代码面。判据见头注。
 * @param {string} rootDir @param {{ dirRel: string, codeFiles: string[] }} mod
 * @param {Set<string>} tenantTables 全仓租户表集（`<schema>.<table>`）
 * @returns {Promise<CodeScan>}
 */
export async function scanModuleCode(rootDir, mod, tenantTables) {
  /** @type {CodeScan} */
  const result = { statements: 0, dynamic: 0, exempt: 0, violations: [] }
  for (const rel of mod.codeFiles) {
    const raw = await readFile(path.join(rootDir, rel), 'utf8')
    const code = maskJsComments(raw) // 等长 ⇒ 行号对齐
    for (const li of code.matchAll(LITERAL_RE)) {
      const sql = li[1]
      if (!/\b(select|update|delete)\b/i.test(sql)) continue
      // 引用本模块租户表吗（insert into 不在此判据面）
      /** @type {string[]} */
      const hits = []
      for (const t of sql.matchAll(TARGET_RE)) {
        const key = `${t[2].toLowerCase()}.${t[3].toLowerCase()}`
        if (tenantTables.has(key)) hits.push(key)
      }
      if (hits.length === 0) continue
      result.statements++
      const line = code.slice(0, li.index).split('\n').length
      // 显式豁免（理由必填）。**先于 org 判据**：标记文本本身含 `org` 一词，若不先剥离，
      // 带标记的语句会被 `\borg\b` 当成「已有 org 谓词」而通过（开发期实测：exempt 计数恒 0）。
      /** @type {string | null} */
      let exemptReason = null
      let hasExemptMarker = false
      for (const m of sql.matchAll(EXEMPT_RE)) {
        hasExemptMarker = true
        if (m[1].trim() !== '') exemptReason = m[1].trim()
      }
      if (hasExemptMarker) {
        if (exemptReason !== null) {
          result.exempt++
          continue
        }
        result.violations.push({
          file: rel,
          line,
          message: '`-- org-exempt:` 没写理由——理由是这条跨租户操作被评审核对的唯一凭据（空理由 = 豁免变成默认勾选）',
        })
        continue
      }
      // org 判据前剥离标记形态的文本（防御：若将来出现别的标记变量，org 不因注释词误判）
      const judged = sql.replace(/--[^\n]*/g, '')
      if (/\borg\b/i.test(judged)) continue
      // 动态插值：只有「WHERE 子句整体是插值」（`where ${…}`）才放行——谓词拼在变量里，
      // 静态不可判。插值在别处（SET 片段、列清单）而 WHERE 是静态的 ⇒ 仍可判 ⇒ 照常违规
      // （否则 `update t set x=${片段} where id=$1` 这类「部分动态」会整条漏网）。
      if (/where\s*\$\{/i.test(sql)) {
        result.dynamic++
        continue
      }
      result.violations.push({
        file: rel,
        line,
        message: `对租户表 ${hits.join(', ')} 的查询没有 org——加 \`org = $n\` 谓词；确属跨租户运维语句就写 \`-- org-exempt: <理由>\`（插值不在 WHERE 处、WHERE 可静态判读的，不算动态放行）`,
      })
    }
  }
  return result
}

/**
 * @param {{ rootDir: string }} args
 * @returns {Promise<{ violations: Violation[], counts: { modules: number, tenantTables: number, statements: number, dynamic: number, exempt: number, globalMarkers: number } }>}
 */
export async function checkOrgScope({ rootDir }) {
  const modules = await collectModules(rootDir)
  /** @type {Violation[]} */
  const violations = []
  /** @type {Set<string>} */
  const tenantTables = new Set()
  let globalMarkers = 0
  for (const mod of modules) {
    const t = await tenantTablesOf(rootDir, mod)
    violations.push(...t.violations)
    globalMarkers += t.markerCount
    for (const k of t.tables) tenantTables.add(k)
  }

  // 空转自检：看不见任何租户表 ⇒ 守卫失效（fail-closed）
  if (tenantTables.size === 0) {
    violations.push({
      file: 'modules/',
      line: null,
      message: '全仓未提取到任何租户表——本门禁的检查面为空（要么模块都不建表，要么提取器坏了）。别让绿灯绿在空转上',
    })
  }

  let statements = 0
  let dynamic = 0
  let exempt = 0
  for (const mod of modules) {
    const s = await scanModuleCode(rootDir, mod, tenantTables)
    statements += s.statements
    dynamic += s.dynamic
    exempt += s.exempt
    violations.push(...s.violations)
  }

  return {
    violations,
    counts: { modules: modules.length, tenantTables: tenantTables.size, statements, dynamic, exempt, globalMarkers },
  }
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const { violations, counts } = await checkOrgScope({ rootDir })
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) {
      const at = v.line === null ? v.file : `${v.file}:${v.line}`
      console.error(`  ${at}: [${LABEL}] ${v.message}`)
    }
    process.exit(1)
  }
  // OK 行带计数：检查面为 0 也是绿的，那种绿要靠人看得见（fetch-depth 教训同源）。
  // 动态放行与显式豁免分别印出——它们是判据的边界，不是通过。
  console.log(
    `${SCRIPT_NAME}: OK（模块 ${counts.modules} / 租户表 ${counts.tenantTables} / 检查语句 ${counts.statements}`
    + ` / 动态放行 ${counts.dynamic} / 显式豁免 ${counts.exempt} / global-table 标记 ${counts.globalMarkers}）`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((err) => {
    console.error(`${SCRIPT_NAME}: ${/** @type {Error} */ (err).message}`)
    process.exit(1)
  })
}
