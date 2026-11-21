#!/usr/bin/env node
// scripts/lemeng/console-drift.mjs — duckle console 工作区的「运行态 vs 声明真相」对账（#2629）。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────────────────
// duckle 的模型是「桌面/Git = authoring 与唯一事实源；服务器 = runtime，只运行不编辑」。
// 但它**没有回拉、也没有漂移检测**（源码里 reconcile/drift/desync 语义均无）⇒
// 「有人在服务器改了管线」「实验残留没清」这两类**永远不会自己暴露**。
// 2026-11-21 实测：3120/64188 两卷里各有 16 / 11 个仓内不存在的管线（movement 回填冲刺的实验件），
// 另有 ~150 个实验 run 记录——排班表干净、湖写入正常，所以**没有任何红灯**。
//
// 数据面早就有这套（契约 + `drift` + B10 生成器）；运行面一直没有。本脚本补的就是这一块。
//
// ── 三条判据（方向不同，处置不同）────────────────────────────────────────────────────
//   ① **缺失/漂移**（声明有、卷里没有或不一致）⇒ ERR —— 部署没落地 / 有人手改。
//      这是 seed-console.sh --check 已经在做的一半；本脚本复用**同一套归属规则**。
//   ② **多余**（卷里有、声明没有）⇒ WARN —— #2629 的形态。**不阻断**（历史实验件无害），
//      但必须可见：它会让 catalog/新鲜度/排障视野变脏，且实验件可能误撞生产前缀。
//   ③ **孤儿 run**（`runs/` 里没有对应管线的记录）⇒ 只进 detail 的计数，不单独判红
//      （run 记录 50 条/管线滚动，孤儿多说明清理欠账，但本身不改数）。
//
// ── 归属规则（照抄 #531 约定，别另发明）────────────────────────────────────────────
//   `.3120.json` / `.64188.json` ⇒ 该账套专属，只应出现在那一卷；
//   无后缀 ⇒ 共享族，两卷都应有；
//   `forms.*` ⇒ forms console 专属，不属于这两卷 —— 跳过。
//
// ── 只读 ─────────────────────────────────────────────────────────────────────────────
//   **只读两卷与镜像内清单，绝不写**。清理是人的动作（#2629 的 _archive 流程），本脚本只报。

import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emitProbe, emitFailure } from '../probe-emit.mjs'

const require = createRequire(import.meta.url)

/** 默认两卷挂载点（data-compose 的 scheduler 服务已只读挂上）+ 镜像内仓内清单。 */
export const DEFAULTS = {
  repoDir: 'deploy/duckle/console/pipelines',
  workspaces: { 3120: '/data/ws3120', 64188: '/data/ws64188' },
}

/** @typedef {{ check: string, ok: boolean, verdict?: 'OK'|'WARN'|'ERR', detail: string }} Verdict */

/** @param {string} dir @returns {string[]} */
export function listJson(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/**
 * 某个管线文件属于哪个/哪些账套。返回 `null` = 与这两卷无关（如 forms）。
 * @param {string} file
 * @returns {string[]|null}
 */
export function booksFor(file) {
  if (file.startsWith('forms.')) return null
  const m = file.match(/\.(3120|64188)\.json$/)
  if (m) return [m[1]]
  return ['3120', '64188'] // 共享族：两卷都应有
}

/**
 * 纯函数：算一份对账结果（单测直接测它，不碰文件系统）。
 * @param {string[]} repoFiles 仓内清单（文件名）
 * @param {Record<string, string[]>} wsFiles 账套 → 卷内 pipelines 文件名
 * @param {Record<string, number>} orphanRuns 账套 → 孤儿 run 数
 * @returns {Verdict[]}
 */
export function diffWorkspaces(repoFiles, wsFiles, orphanRuns = {}) {
  /** @type {Verdict[]} */
  const out = []
  const repoSet = new Set(repoFiles.filter((f) => booksFor(f) !== null))
  for (const book of Object.keys(wsFiles).sort()) {
    const ws = new Set(wsFiles[book] ?? [])
    // ① 声明有、卷里没有
    const missing = repoFiles.filter((f) => {
      const b = booksFor(f)
      return b !== null && b.includes(book) && !ws.has(f)
    })
    // ② 卷里有、声明没有（#2629 形态）
    // ⚠️ 同样要过 `booksFor`：`forms.*` 是 forms console 专属件、与本两卷无关
    //   （实测两卷里都留着一份 forms 产物，是建 forms 专属 console 之前的分发残留），
    //   不能算进这两个账套的「多余」。归属规则必须两处一致，否则判据自相矛盾。
    const extra = [...ws].filter((f) => booksFor(f) !== null && !repoSet.has(f)).sort()
    const orphan = orphanRuns[book] ?? 0
    const tail = `extra=${extra.length}${extra.length ? `(${extra.slice(0, 5).join(',')}${extra.length > 5 ? '…' : ''})` : ''} orphanRuns=${orphan}`

    if (missing.length) {
      out.push({
        check: `console_drift:${book}`,
        ok: false,
        detail: `ERR 卷内缺 ${missing.length}/${repoSet.size} 件声明管线（${missing.slice(0, 5).join(',')}${missing.length > 5 ? '…' : ''}）——seed 没落地或有人手删；${tail}`,
      })
      continue
    }
    if (extra.length) {
      out.push({
        check: `console_drift:${book}`,
        ok: true,
        verdict: 'WARN',
        detail: `WARN 卷内多出 ${extra.length} 个仓内不存在的管线（实验残留？清理走 #2629 的 _archive 流程）；${tail}`,
      })
      continue
    }
    out.push({
      check: `console_drift:${book}`,
      ok: true,
      detail: `OK 与仓内清单一致（${repoSet.size} 件）；${tail}`,
    })
  }
  return out
}

/** 统计孤儿 run（runs/ 里有、pipelines/ 里没有对应文件），只做计数。 */
/** @param {string} ws */
export function countOrphanRuns(ws) {
  const pipes = new Set(listJson(join(ws, 'pipelines')).map((f) => f.replace(/\.json$/, '')))
  let orphan = 0
  let total = 0
  try {
    for (const f of readdirSync(join(ws, 'runs'))) {
      if (!f.endsWith('.json')) continue
      total += 1
      if (!pipes.has(f.replace(/\.json$/, ''))) orphan += 1
    }
  } catch {
    return { orphan: 0, total: 0 }
  }
  return { orphan, total }
}

/**
 * 文件内容比对（仓 vs 卷）：只比**声明过的**文件，逐字节 sha256。
 * ⚠️ 不用 `shasum` 二进制：2026-11-21 实测容器里它对卷内文件返回空串（seed-console 老坑）。
 * @param {string} repoDir @param {string} wsDir @param {string[]} files
 * @returns {string[]} 不一致的文件
 */
export function contentDrift(repoDir, wsDir, files) {
  const { createHash } = require('node:crypto')
  /** @param {string} p */
  const sha = (p) => {
    try {
      return createHash('sha256').update(readFileSync(p)).digest('hex')
    } catch {
      return ''
    }
  }
  return files.filter((f) => {
    const a = sha(join(repoDir, f))
    const b = sha(join(wsDir, 'pipelines', f))
    return a === '' || b === '' || a !== b
  })
}

/** @param {Partial<typeof DEFAULTS>} [cfg] */
export function collect(cfg = {}) {
  const repoDir = process.env.CONSOLE_REPO_DIR ?? cfg.repoDir ?? DEFAULTS.repoDir
  /** @type {Record<string, string>} */
  const workspaces = cfg.workspaces ?? {
    3120: process.env.CONSOLE_WS_3120 ?? DEFAULTS.workspaces['3120'],
    64188: process.env.CONSOLE_WS_64188 ?? DEFAULTS.workspaces['64188'],
  }
  const repoFiles = listJson(repoDir)
  /** @type {Record<string, string[]>} */
  const wsFiles = {}
  /** @type {Record<string, number>} */
  const orphans = {}
  for (const [book, dir] of Object.entries(workspaces)) {
    wsFiles[book] = listJson(join(dir, 'pipelines'))
    orphans[book] = countOrphanRuns(dir).orphan
  }
  const verdicts = diffWorkspaces(repoFiles, wsFiles, orphans)
  // 内容漂移：把「同名但不一致」并入 ① 的 detail（比逐件出 probe 省行数）
  for (const v of verdicts) {
    const book = v.check.split(':')[1]
    if (!v.detail.startsWith('ERR')) continue
    const drift = contentDrift(repoDir, workspaces[book], wsFiles[book].filter((f) => booksFor(f)?.includes(book)))
    if (drift.length) v.detail += `；内容漂移 ${drift.length} 件（${drift.slice(0, 3).join(',')}）`
  }
  return { repoFiles, wsFiles, verdicts, workspaces }
}

async function main() {
  const { repoFiles, verdicts } = collect()
  if (repoFiles.length === 0) {
    // 清单不可读 = 判据失效，必须响亮（静默跳过会变成又一次「观测面黑了没人知道」）
    console.error('console-drift: 仓内清单为空（repoDir 不对？）——判据失效')
    await emitFailure('console_drift_runner', '仓内清单为空（repoDir 不对？）')
    process.exit(1)
  }
  let errs = 0
  for (const v of verdicts) {
    const verdict = v.verdict ?? (v.ok ? 'OK' : 'ERR')
    if (verdict === 'ERR') errs += 1
    console.log(`${verdict} ${v.check}: ${v.detail}`)
    await emitProbe({ check: v.check, verdict, detail: v.detail.slice(0, 450), probe: 'console-drift', mode: 'advisory' })
  }
  console.log(`console-drift: ${verdicts.length} 卷，${errs} ERR（advisory：判红不翻 rc）`)
  const url = process.env.DATABASE_URL
  if (url) {
    const { Pool } = createRequire(import.meta.url)('pg')
    const pool = new Pool({ connectionString: url })
    try {
      await pool.query(
        `insert into platform.job_heartbeat (id, beat_at) values ('data.console_drift', now())
         on conflict (id) do update set beat_at = excluded.beat_at`,
      )
    } catch (e) {
      console.error(`heartbeat: ${e instanceof Error ? e.message : e}`)
    } finally {
      await pool.end().catch(() => {})
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    console.error(`console-drift: ${e?.stack ?? e}`)
    await emitFailure('console_drift_runner', String(e?.message ?? e).slice(0, 400)).catch(() => {})
    process.exit(1)
  })
}
