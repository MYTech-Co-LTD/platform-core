#!/usr/bin/env node
// backfill-slice.mjs — 夜间回填的**切片驱动**（#2742 第③刀；平台调度器 `data.backfill_slice`）
//
// ── 为什么不是把宿主脚本搬过来 ────────────────────────────────────────────────
// 原 `nightly-backfill.sh` 是「一次跑到 CST 08:00」的长驱动（最长 ~8 小时）：
//   · 数据单元并发只有 2 槽，它一整夜占一个 ⇒ 压缩物化容量；
//   · 容器每天重启若干次（2026-11-27 一天 6 次）⇒ **必须活 8 小时的进程放在每天重启的环境里是结构错配**。
// 按 `deploy/jobs.md` §1.1 第①问：**先切片**，再谈迁移。
//
// ── 切片形状 ──────────────────────────────────────────────────────────────────
// 每 30 分钟一轮（CST 00:05–07:35），每轮：
//   · 遍历队列，**每条只推进一天**（`--max-days 1`）；
//   · 已完成的日子由执行体自己的 `--skip-existing` 跳过（**进度从湖里推导，不另存状态**：
//     这是切片能成立的关键——回填体本来就按日幂等，所以「跑到哪了」= 湖里有哪些天）；
//   · 本轮耗尽时间预算（默认 25 分钟）就停，下一轮接着来。
// ⇒ 可中断、部署不杀、占槽 ≤30 分钟、失败清单仍由执行体落 JSONL。
//
// 队列文件在仓内（`deploy/backfill-queue.txt`）：以前在 `/opt`（ops 手维、不入仓），
// 迁到平台后必须可版本化，否则容器里根本读不到。
//
// 用法：node scripts/lemeng/backfill-slice.mjs [--dry-run] [--max-items N]
// 退出码：0 = 本轮无失败；1 = 有失败（详见输出）；2 = 队列缺失/格式坏。

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const QUEUE_REL = 'deploy/backfill-queue.txt'
const PY = process.env.BACKFILL_PY ?? 'python3'
const PY_REL = 'scripts/lemeng/backfill-history.py'
const ROUND_BUDGET_MS = Number(process.env.BACKFILL_ROUND_BUDGET_MS ?? 25 * 60_000)
const PER_ITEM_TIMEOUT_MS = Number(process.env.BACKFILL_ITEM_TIMEOUT_MS ?? 20 * 60_000)

/**
 * @typedef {{dataset: string, book: string, from: string, to: string, flags: string[]}} Item
 */

/**
 * 解析队列：`#` 注释与空行跳过；`<dataset> <book> <from> <to> [flags]`。
 * flags 是**白名单**（现只认 `allow-empty`）：队列是手维文本，未知 flag 只告警不传。
 * @param {unknown} text 文件内容（undefined/空串都当空队列）
 * @returns {{items: Item[], bad: string[], unknownFlags: string[]}}
 */
export function parseQueue(text) {
  /** @type {Item[]} */
  const items = []
  /** @type {string[]} */
  const bad = []
  /** @type {string[]} */
  const unknownFlags = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [dataset, book, from, to, flagText] = line.split(/\s+/)
    if (!dataset || !book || !/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
      bad.push(line)
      continue
    }
    const flags = (flagText ?? '').split(',').map((f) => f.trim()).filter(Boolean)
    /** @type {string[]} */
    const kept = flags.filter((f) => f === 'allow-empty')
    for (const f of flags) if (!kept.includes(f)) unknownFlags.push(`${dataset} ${f}`)
    items.push({ dataset, book, from, to, flags: kept })
  }
  return { items, bad, unknownFlags }
}

/**
 * 执行体参数：与宿主脚本**同源**（`--apply --skip-existing --continue-on-fail`），
 * 只额外加 `--max-days 1` —— 这就是「切片」的全部差别。
 * @param {Item} item
 * @returns {string[]}
 */
export function buildArgs(item) {
  const args = [
    PY_REL,
    '--dataset', item.dataset,
    '--books', item.book,
    '--from', item.from,
    '--to', item.to,
    '--apply',
    '--skip-existing',
    '--continue-on-fail',
    '--max-days', '1',
  ]
  if (item.flags.includes('allow-empty')) args.push('--allow-empty')
  return args
}

/**
 * 从执行体输出里取本轮的账：`BF_DONE ok=… empty=… failed=…` 与 `BF_SKIP_EXISTING` 次数。
 * ⚠️ `ok=0` 有**两种含义**（全部已存在 vs 窗口关空转）⇒ 必须同时看 skip 计数与 `BF_WINDOW_CLOSED`，
 * 这是 2026-11-08 假绿的教训。
 * @param {string} out
 * @returns {{ok: number, empty: number, failed: number, skipped: number, windowClosed: boolean}}
 */
export function summarize(out) {
  const s = String(out ?? '')
  const m = /BF_DONE ok=(\d+) empty=(\d+) failed=(\d+)/.exec(s)
  return {
    ok: m ? Number(m[1]) : 0,
    empty: m ? Number(m[2]) : 0,
    failed: m ? Number(m[3]) : 0,
    skipped: (s.match(/BF_SKIP_EXISTING/g) ?? []).length,
    windowClosed: s.includes('BF_WINDOW_CLOSED'),
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry-run')
  const maxItemsArg = argv.indexOf('--max-items')
  const maxItems = maxItemsArg >= 0 ? Number(argv[maxItemsArg + 1]) : Infinity

  const queuePath = join(ROOT, QUEUE_REL)
  if (!existsSync(queuePath)) {
    console.error(`BACKFILL_SLICE_FAILED: 队列不存在 ${QUEUE_REL}`)
    return 2
  }
  const { items, bad, unknownFlags } = parseQueue(readFileSync(queuePath, 'utf8'))
  for (const b of bad) console.error(`BACKFILL_SLICE_QUEUE_BAD: ${b}`)
  for (const u of unknownFlags) console.error(`BACKFILL_SLICE_QUEUE_UNKNOWN_FLAG: ${u}`)
  console.log(`BACKFILL_SLICE_PLAN items=${items.length} bad=${bad.length}`)
  if (items.length === 0 || dry) {
    console.log(`BACKFILL_SLICE_DRY items=${items.length}（未执行）`)
    return 0
  }

  const startedAt = Date.now()
  let rounds = 0
  let advanced = 0
  let failed = 0
  let skippedInvocations = 0

  for (const item of items) {
    if (rounds >= maxItems) break
    if (Date.now() - startedAt > ROUND_BUDGET_MS) {
      console.log(`BACKFILL_SLICE_BUDGET exhausted after ${rounds} items`)
      break
    }
    rounds += 1
    const before = Date.now()
    const r = spawnSync(PY, buildArgs(item), {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: PER_ITEM_TIMEOUT_MS,
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const sum = summarize(out)
    const secs = ((Date.now() - before) / 1000).toFixed(0)
    const rc = r.status ?? -1
    if (sum.failed > 0 || rc !== 0) failed += 1
    if (sum.ok + sum.empty > 0) advanced += sum.ok + sum.empty
    if (sum.skipped > 0) skippedInvocations += 1
    console.log(
      `BACKFILL_SLICE_ITEM ds=${item.dataset} book=${item.book} rc=${rc} ok=${sum.ok} empty=${sum.empty} failed=${sum.failed} skip=${sum.skipped} secs=${secs}`,
    )
    // 失败时必须带出**人话**：rc≠0 且没解析出 BF_DONE 时（如依赖缺失、参数错）只报 rc 等于没报。
    if (rc !== 0 || sum.failed > 0) {
      const tail = out.trim().split('\n').slice(-4).join(' | ')
      console.log(`BACKFILL_SLICE_ITEM_ERR ds=${item.dataset} book=${item.book} tail=${tail.slice(0, 400)}`)
    }
  }

  const total = ((Date.now() - startedAt) / 1000).toFixed(0)
  console.log(
    `BACKFILL_SLICE_${failed === 0 ? 'OK' : 'PARTIAL'} items=${rounds} advanced_days=${advanced} failed=${failed} skip_only=${skippedInvocations} secs=${total}`,
  )
  return failed > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => process.exit(code))
}
