#!/usr/bin/env node
// check-doc-citations.mjs — 文档引用门禁（issue #771）。
//
// 用法：tsx scripts/check-doc-citations.mjs [baseRef]   # baseRef 默认 origin/main
// 契约：干净 → exit 0，stdout 一行 `check-doc-citations: OK（…）`；
//       有违规 → exit 1，stderr 每条一行 `✗ <文档>:<行>` + 说明。
//
// ── 判据（写死，别扩）──────────────────────────────────────────────────────────
//   **变更中的文档里，能唯一解析到仓内文件的 `file:line` 引用，行号必须在范围内。**
//
//   支持形态：`file.ts:42` / `file.ts:10-20` / `file.ts:1,5,9`。
//
// ── ⚠️ 为什么**不判**「文件不存在」——实测数据决定的，别好心加回来 ────────────────
//   2026-10-17 全量实测（135 份文档 / 4658 处引用）：
//     · 行号越界      4 处 —— **全是真错**（文件后来变短了），近零噪声  ⇒ 本门禁
//     · 文件不存在  538 处（收窄到「仓内相对路径」仍有 114 处 / 39 份文档）
//       其中绝大多数是**合法**引用：仓外（`explore 仓 docs/adr/…`）、数据面文件
//       （`owners.json` / `alerts.json`）、已迁移退役（`duckle/common/*.json` →
//       `deploy/duckle/console/…`）、**计划里待建的文件**（`report-scope.ts` 等）。
//       ⇒ 判了就是噪声，**真违规会被淹掉**；而本仓规矩是判据必须能变异确认。
//     · 文件名歧义  337 处 —— `manifest.yaml` / `index.ts` 这类裸名，人读得懂 ⇒ 不判
//   ⇒ 解析不到 / 歧义一律**不判**。本门禁只回答「这个行号在这个文件里存在吗」。
//
// ── ⚠️ 为什么只查**变更中的**文档，不是全量 ────────────────────────────────────
//   那 4 处越界**全在两份历史文档**里（`2026-09-17-issue-68-hono-client-step2.md` × 3、
//   `2026-09-15-aftersales-module-design.md` × 1），而本仓既有纪律是
//   「`docs/superpowers/specs/**` 是**历史快照，正文一律不改**」（`docs/architecture.md` §6.1）。
//   ⇒ 全量门会红 4 处而这 4 处**不许改** ⇒ 只能 diff-scoped
//   （与 `scripts/check-dev-discipline.sh` 同款 idiom）。
//
// ── ⚠️ base ref 解析不到必须**响亮失败** ────────────────────────────────────────
//   浅克隆下 `origin/main` 不存在 ⇒ `git diff` 失败 ⇒ 若被当成「没有变更」就 **exit 0 静默通过**，
//   守卫看着绿、实则一次都没跑。`.github/workflows/ci.yml` 的 `fetch-depth: 0` 注释记着同一个坑
//   （`git log origin/main..HEAD` 直接失败那条）。故这里**先 rev-parse 校验**，失败即抛。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

export const SCRIPT_NAME = 'check-doc-citations'

/** @typedef {{ file: string, line: number, message: string }} Violation */

/**
 * 引用的形态：反引号包着 `路径[:行号规格]`。
 * 行号规格 = `42` / `10-20` / `1,5,9`（逗号与短横可混用，见 parseLineSpec）。
 * ⚠️ 只认**反引号内**的引用——散在正文里的裸路径不是本门禁的对象（那会误伤英文里的句点）。
 */
const CITE_RE = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|mjs|cjs|js|json|yml|yaml|sql|sh|md))(?::(\d+(?:[-,]\d+)*))?`/g

/** 遍历时跳过的目录：既不是仓内源码，也不该被当成引用目标。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.superpowers', 'coverage'])

/**
 * 仓内所有文件（相对仓根的 POSIX 路径）。
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function listRepoFiles(rootDir) {
  /** @type {string[]} */
  const out = []
  const walk = (/** @type {string} */ dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(join(dir, e.name))
        continue
      }
      if (!e.isFile()) continue
      out.push(relative(rootDir, join(dir, e.name)).split(sep).join('/'))
    }
  }
  walk(rootDir)
  return out
}

/**
 * 把一个引用解析到**唯一的**仓内文件。
 *
 * 先按整路径精确匹配；不中再按后缀匹配。后缀匹配**要求唯一**——歧义（`manifest.yaml` 有 N 个）
 * 一律返回 null（= 不判），见文件头「为什么不做存在性判据」。
 *
 * @param {readonly string[]} files
 * @param {string} ref
 * @returns {string | null}
 */
export function resolveRepoFile(files, ref) {
  if (files.includes(ref)) return ref
  const suffix = `/${ref}`
  /** @type {string | null} */
  let hit = null
  for (const f of files) {
    if (!f.endsWith(suffix)) continue
    if (hit !== null) return null // 歧义 ⇒ 不判
    hit = f
  }
  return hit
}

/**
 * 数一个文件有多少行——**按 `wc -l` 的口径**（结尾的换行符不额外算一行）。
 *
 * ⚠️ 别用 `text.split('\n').length`：`"a\nb\nc\n"` 它会给出 **4**，而编辑器与 `wc -l` 都说 **3**。
 *    差这一行会让**每个**「指向末行之后一位」的错引用被放过（假阴性）——
 *    正是本门禁唯一要抓的东西。2026-10-17 由单测抓出，别改回去。
 *
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

/**
 * 解析行号规格。返回其中**越界**的那些行号（空数组 = 全在范围内）。
 *
 * @param {string} spec `42` / `10-20` / `1,5,9`
 * @param {number} lineCount 被引用文件的总行数
 * @returns {number[]}
 */
export function parseLineSpec(spec, lineCount) {
  /** @type {number[]} */
  const bad = []
  for (const part of spec.split(',')) {
    if (part === '') continue
    const dash = part.indexOf('-')
    const from = Number(dash === -1 ? part : part.slice(0, dash))
    const to = dash === -1 ? from : Number(part.slice(dash + 1))
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue
    if (from < 1 || to < from) bad.push(from)
    // 区间只报端点：`10-999` 报 999 就够定位了，逐个报会把输出刷屏。
    if (to > lineCount) bad.push(to)
  }
  return bad
}

/**
 * 门禁核心：给定仓根与**显式**的文档清单（由调用方决定查哪些），返回违规。
 *
 * 刻意不在这里读 git —— 那样单测就得先造一个 git 仓。git 面在 `changedDocs()` 里，
 * 是薄壳；本函数是纯的（只读文件系统）。
 *
 * @param {string} rootDir
 * @param {readonly string[]} docPaths 相对仓根的文档路径
 * @returns {Violation[]}
 */
export function checkDocCitations(rootDir, docPaths) {
  /** @type {Violation[]} */
  const violations = []
  const files = listRepoFiles(rootDir)
  /** @type {Map<string, number>} */
  const lineCounts = new Map()

  for (const doc of docPaths) {
    /** @type {string} */
    let text
    try {
      text = readFileSync(join(rootDir, doc), 'utf8')
    } catch (e) {
      // 变更清单里点名的文档读不到 ⇒ 响亮失败（不是静默跳过）
      violations.push({ file: doc, line: 0, message: `读不到文档：${/** @type {Error} */ (e).message}` })
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      CITE_RE.lastIndex = 0
      for (const m of raw.matchAll(CITE_RE)) {
        const ref = m[1] ?? ''
        const spec = m[2]
        if (spec === undefined) continue // 没有行号 ⇒ 不在本门禁的对象内
        const target = resolveRepoFile(files, ref)
        if (target === null) continue // 解析不到 / 歧义 ⇒ 不判
        let n = lineCounts.get(target)
        if (n === undefined) {
          n = countLines(readFileSync(join(rootDir, target), 'utf8'))
          lineCounts.set(target, n)
        }
        const bad = parseLineSpec(spec, n)
        if (bad.length === 0) continue
        violations.push({
          file: doc,
          line: i + 1,
          message:
            `\`${ref}:${spec}\` 的行号越界——解析到 \`${target}\`（共 ${n} 行），`
            + `不存在的行号：${bad.join(', ')}。`
            + '多半是文件后来变短/被改短了，或行号抄错。请回源头重新核对（别按记忆补）。',
        })
      }
    }
  }
  return violations
}

/**
 * 变更中的文档清单（相对 baseRef 的 merge-base）。
 *
 * @param {string} rootDir
 * @param {string} baseRef
 * @returns {string[]}
 */
export function changedDocs(rootDir, baseRef) {
  const run = (/** @type {string[]} */ args) => {
    const r = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' })
    if (r.error !== undefined && r.error !== null) throw r.error
    if (r.status !== 0) {
      throw new Error(`\`git ${args.join(' ')}\` 失败（退出码 ${r.status}）：${(r.stderr ?? '').trim()}`)
    }
    return r.stdout ?? ''
  }
  // ⚠️ 先校验 base ref 真的解析得到——否则下面的 diff 失败会被当成「没有变更」而静默 exit 0。
  run(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])
  const out = run(['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`, '--', 'docs/'])
  return out.split('\n').map((s) => s.trim()).filter((p) => p.endsWith('.md'))
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv) {
  const root = process.cwd()
  const base = argv.slice(2).find((a) => !a.startsWith('--')) ?? 'origin/main'
  /** @type {string[]} */
  let docs
  try {
    docs = changedDocs(root, base)
  } catch (e) {
    console.error(`${SCRIPT_NAME}: 取变更清单失败 —— ${/** @type {Error} */ (e).message}`)
    console.error('  这条**必须响亮失败**：浅克隆下 base ref 不存在时，静默当成「没有变更」会让本门禁'
      + '一次都没跑却显示绿。CI 侧靠 checkout 的 fetch-depth: 0 保证 base ref 在场。')
    return 1
  }
  const violations = checkDocCitations(root, docs)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: 发现 ${violations.length} 条违规`)
    for (const v of violations) {
      console.error(`  ✗ ${v.file}:${v.line}\n      ${v.message}`)
    }
    console.error('\n修法：回源头重新核对行号（`grep -n` 或读文件），别按记忆补。'
      + '历史快照（本仓纪律：specs/plans 正文一律不改）不受本门禁约束——它只查**变更中的**文档。')
    return 1
  }
  console.log(`${SCRIPT_NAME}: OK（变更中的文档 ${docs.length} 份，行号引用全部在范围内）`)
  return 0
}

const invoked = process.argv[1] ? relative(process.cwd(), process.argv[1]).split(sep).join('/') : ''
if (invoked.endsWith(`scripts/${SCRIPT_NAME}.mjs`)) {
  process.exit(main(process.argv))
}
