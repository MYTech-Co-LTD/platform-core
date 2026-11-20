#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（纯函数 utcWindow/windowFor/parseBooks 有同名 .test.ts 兜底）。
//
// hour-partition-gc.mjs —— 「删已被天文件取代的小时对象」的调度器入口（Wave 8 ③）。
//
// 为什么有这层：openship 上的现役 job 是宿主 bash——`for B in 3120 64188; do docker exec <console>
// python3 - < repo/scripts/lemeng/delete-supplanted-hour-partitions.py; done`。它依赖
// **console 容器在场**：console 部署/重启期间这一轮就失败。删对象本身只需要 ZOS 凭据 + HEAD，
// 调度器容器两样都有（`ZOS_*` 在 env、python3 在镜像里）⇒ 直接在这里跑。
//
// **一个入口服务两条排班**（窗口不同、判据同一套）：
//   · `data.hour_partition_gc`（每 30 分钟）：before = **今天(UTC)**、扫描 10 天 —— 对应原
//     「删已封版日子的小时对象」（`5,35 * * * *`）。
//   · `data.hot_hours_gc`（每日 CST 03:20）：before = **上海今天 − 2 天**、扫描 30 天 —— 对应原
//     「lemeng-gc-hot-hours」（`GC_DAYS_BACK=2`，重述窗口护栏）。两者都是「天文件 + 封版标记
//     都在才删」，只是保守程度不同，故意都留着。
//
// 判据仍然全在下游脚本里（不改一行）：默认 dry-run、`--before` 必填、**封版标记 + 天文件双证**
// 才删。本层只负责「按账套循环 + 算窗口 + 汇总退出码」，不复制任何安全判据。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 默认账套：与现役 `for B in 3120 64188` 逐字一致。 */
export const DEFAULT_BOOKS = ['3120', '64188']

/** `tz` 下「今天」的 `YYYY-MM-DD`（`en-CA` 的短日期恰好是这个形状）。 */
function todayIn(tz, now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** `YYYY-MM-DD` 前后平移 n 天（n 可为负）。按 UTC 正午算，规避夏令时/时区边界。 */
function shiftDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * 窗口：`{from, before}` 都是 `YYYY-MM-DD`。
 * - `before` = `tz` 下的今天 − `daysBack` 天；语义是「删 bizday < before 的日子」。
 * - `from` = before − `scanDays`（**只是扫描范围**，不是删除判据）。
 *
 * 默认（`daysBack=0, tz=UTC, scanDays=10`）与宿主 `date -d '-10 days'` + `date +%F` 逐字一致。
 */
export function windowFor({ daysBack = 0, tz = 'UTC', scanDays = 10, now = new Date() } = {}) {
  const before = shiftDays(todayIn(tz, now), -daysBack)
  const from = shiftDays(before, -scanDays)
  return { from, before }
}

/** 旧名保留：等价于 `windowFor()` 的 UTC 形态（单测与既有调用点用）。 */
export function utcWindow(now = new Date()) {
  return windowFor({ now })
}

/** 解析账套：`,` 或空白分隔（兼容现役 shell 的 `GC_BOOKS="3120 64188"`）；空/非法抛错。 */
export function parseBooks(raw) {
  const books = String(raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (books.length === 0) throw new Error('hour-partition-gc: 账套列表不能为空')
  for (const b of books) {
    if (!/^[0-9A-Za-z_-]+$/.test(b)) throw new Error(`hour-partition-gc: 非法账套号 ${JSON.stringify(b)}`)
  }
  return books
}

/** 非负整数 env（缺省用 default）；NaN/负数/非整数 ⇒ 抛错（不静默按 0 跑）。 */
function intEnv(name, dflt) {
  const raw = String(process.env[name] ?? '').trim()
  if (raw === '') return dflt
  if (!/^\d+$/.test(raw)) throw new Error(`hour-partition-gc: ${name} 必须是非负整数，得到 ${JSON.stringify(raw)}`)
  return Number(raw)
}

function main() {
  const books = parseBooks(process.env.GC_BOOKS ?? DEFAULT_BOOKS.join(','))
  const daysBack = intEnv('GC_DAYS_BACK', 0)
  const scanDays = intEnv('GC_SCAN_DAYS', 10)
  const tz = String(process.env.GC_TZ ?? 'UTC').trim() || 'UTC'
  const { from, before } = windowFor({ daysBack, tz, scanDays })
  const failed = []
  let planned = 0
  for (const book of books) {
    // 子进程 stdio 直通：下游脚本的 SKIP_*/DELETE_PLAN/DELETE_DONE 行原样进 job_run 输出。
    const r = spawnSync(
      'python3',
      ['scripts/lemeng/delete-supplanted-hour-partitions.py', '--book', book, '--from', from, '--before', before, '--apply'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    process.stdout.write(out)
    const n = (out.match(/^DELETE_PLAN /gm) ?? []).length
    planned += n
    // spawn 级失败（python3 不在、ENOENT…）时 `status` 为 null、`error` 才有话——必须带上原因，
    // 否则台账里只剩「rc=null」，运维看不出是缺解释器还是脚本自己退 2。
    if (r.status !== 0) {
      const why = r.error ? `: ${r.error.message}` : ''
      failed.push(`${book}（rc=${r.status ?? r.signal}${why}）`)
    }
    console.log(`HOUR_PARTITION_GC book=${book} plans=${n} rc=${r.status ?? r.signal}`)
  }
  console.log(`HOUR_PARTITION_GC_DONE books=${books.join(',')} window=${from}..${before} tz=${tz} daysBack=${daysBack} plans=${planned} failed=${failed.length}`)
  // 任一账套失败即整体失败（同现役 bash 的 `|| rc=1`）：不做「部分成功」的假绿。
  if (failed.length > 0) {
    console.error(`HOUR_PARTITION_GC_FAILED ${failed.join(' ')}`)
    return 1
  }
  return 0
}

// 只在被直接执行时跑 main（测试 import 不触发）。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(main())
  } catch (e) {
    // 参数/env 配错（如 GC_DAYS_BACK=abc）在这里收口：**一行原因**进 job_run 输出，
    // 不甩 20 行堆栈（台账里那 4KB 尾部要留给真正有用的信息）。
    console.error(`HOUR_PARTITION_GC_FAILED ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
