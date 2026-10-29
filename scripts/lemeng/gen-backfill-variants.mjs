#!/usr/bin/env node
// gen-backfill-variants.mjs —— 回填变体生成器（issue #1160 / 全量历史回填 W0）。
//
// 回填 = **同一条管线换时间窗**（handbook §1.3 阶段 H）：窗口 token 从 `${date-1d}`（或
// `${date-2d}`）换成 `${BIZDAY}`，由 `POST /api/run` 的 `params={"BIZDAY":"YYYY-MM-DD"}` 驱动。
// 变体**不手编**：主管线（l0）是唯一事实源，本脚本机械派生，`--check` 钉住「生成物 == committed」。
// 手编必然漂移——窗口 token 同时出现在 p1..pN 的 body、shape 的 bizday 列、sink 的 key 与 gv 的
// 格式校验里，漏一处就是「回填跑到今天」或「写错分区」。
//
// 归属边界：`lemeng.inventory.snapshot.{catchup,backfill}.3120` 归
// `gen-inventory-snapshot-variants.mjs`（它还要改空集文案）；本脚本只管下面列出的变体，
// 其中 `inventory.snapshot.backfill.64188` 没有 catchup 兄弟，故由本脚本派生。
//
// 用法（仓根跑）：
//   node scripts/lemeng/gen-backfill-variants.mjs           # 生成/覆盖全部变体
//   node scripts/lemeng/gen-backfill-variants.mjs --check   # 只比对，漂移 exit 1
//
// 产出后必须：duckle MCP validate_pipeline 过 → 才许提交（仓内文件 = 引擎验过的）。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'deploy/duckle/console/pipelines'
const CHECK = process.argv.includes('--check')

/**
 * 待派生清单。`window` 是主管线的窗口 token；派生后一律变 `${BIZDAY}`。
 * @type {{ base: string, book: string, window: string }[]}
 */
const TARGETS = [
  // ── 3120 ────────────────────────────────────────────────────────────────
  { base: 'lemeng.loss.adjustment', book: '3120', window: '${date-1d}' },
  { base: 'lemeng.request.order', book: '3120', window: '${date-1d}' },
  { base: 'lemeng.purchase.analysis', book: '3120', window: '${date-1d}' },
  { base: 'lemeng.transfer.out', book: '3120', window: '${date-1d}' },
  { base: 'lemeng.client.expense', book: '3120', window: '${date-1d}' },
  // ── 64188（配送/批发按裁决不在本账套采集范围，故无 transfer.out / wholesale）──
  { base: 'lemeng.branch.expense', book: '64188', window: '${date-1d}' },
  { base: 'lemeng.client.expense', book: '64188', window: '${date-1d}' },
  { base: 'lemeng.loss.adjustment', book: '64188', window: '${date-1d}' },
  { base: 'lemeng.member.summary', book: '64188', window: '${date-1d}' },
  { base: 'lemeng.purchase.analysis', book: '64188', window: '${date-1d}' },
  { base: 'lemeng.request.order', book: '64188', window: '${date-1d}' },
  { base: 'lemeng.inventory.snapshot', book: '64188', window: '${date-2d}' },
  { base: 'lemeng.branch_indicator', book: '64188', window: '${date-1d}' },
]

const BACKFILL = '${BIZDAY}'

/**
 * 深度替换：字符串值里把 from 换成 to（键名不动）。
 * @param {unknown} v @param {string} from @param {string} to @returns {unknown}
 */
function replaceToken(v, from, to) {
  if (typeof v === 'string') return v.split(from).join(to)
  if (Array.isArray(v)) return v.map((x) => replaceToken(x, from, to))
  if (v !== null && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = replaceToken(x, from, to)
    return out
  }
  return v
}

/** @param {unknown} v @param {string} token @returns {number} */
function countToken(v, token) {
  if (typeof v === 'string') return v.split(token).length - 1
  if (Array.isArray(v)) return v.reduce((n, x) => n + countToken(x, token), 0)
  if (v !== null && typeof v === 'object') {
    return Object.values(v).reduce((n, x) => n + countToken(x, token), 0)
  }
  return 0
}

let drift = false
let written = 0

for (const t of TARGETS) {
  const mainFile = join(DIR, `${t.base}.l0.${t.book}.json`)
  const outFile = join(DIR, `${t.base}.backfill.${t.book}.json`)
  const mainName = `${t.base}.l0.${t.book}`
  const outName = `${t.base}.backfill.${t.book}`

  /** @type {any} */
  let main
  try {
    main = JSON.parse(readFileSync(mainFile, 'utf8'))
  } catch (e) {
    console.error(`主管线读不了：${mainFile}（${String(e)}）`)
    process.exit(2)
  }
  if (main.name !== mainName) {
    console.error(`主管线顶层 name 应为 ${mainName}，实际 ${String(main.name)}`)
    process.exit(2)
  }
  const hits = countToken(main, t.window)
  if (hits === 0) {
    console.error(
      `${mainFile} 里找不到窗口 token ${t.window}——主管线窗口改过却没同步本脚本的 window 字段？`,
    )
    process.exit(2)
  }

  /** @type {any} */
  const derived = replaceToken(structuredClone(main), t.window, BACKFILL)
  derived.name = outName

  // 断言：原窗口 token 一个不剩（漏替换 = 回填仍跑"昨天"，最危险的静默错误）
  const leftover = countToken(derived, t.window)
  if (leftover !== 0) {
    console.error(`${outFile}: 仍有 ${leftover} 处 ${t.window} 未被替换`)
    process.exit(2)
  }
  // 断言：回填 token 确实落进了 sink key（写错分区就无法按天回读）
  if (!JSON.stringify(derived).includes(`bizday=${BACKFILL}`)) {
    console.error(`${outFile}: sink key 里没有 bizday=${BACKFILL}——分区键不是变量？`)
    process.exit(2)
  }

  const body = JSON.stringify(derived, null, 2) + '\n'
  if (CHECK) {
    /** @type {string | null} */
    let onDisk = null
    try {
      onDisk = readFileSync(outFile, 'utf8')
    } catch {
      console.error(`GEN_DRIFT: ${outFile} 不存在（跑了生成器没提交？）`)
      drift = true
      continue
    }
    if (onDisk !== body) {
      console.error(`GEN_DRIFT: ${outFile} 与主管线派生结果不一致（改了主管线没重跑生成器？）`)
      drift = true
    } else {
      console.log(`ok: ${outFile}`)
    }
  } else {
    writeFileSync(outFile, body)
    written += 1
    console.log(`written: ${outFile} (name=${outName} window=${t.window} → ${BACKFILL}, ${hits} 处)`)
  }
}

if (CHECK) {
  if (drift) {
    console.error('怎么修：node scripts/lemeng/gen-backfill-variants.mjs 后一并提交')
    process.exit(1)
  }
  console.log(`gen-backfill-variants: OK（${TARGETS.length} 个变体与主管线一致）`)
} else {
  console.log(`gen-backfill-variants: 写入 ${written}/${TARGETS.length} 个变体`)
}
