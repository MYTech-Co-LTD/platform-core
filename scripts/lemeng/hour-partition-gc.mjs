#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（纯函数 utcWindow/parseBooks 有同名 .test.ts 兜底）。
//
// hour-partition-gc.mjs —— 「删已被天文件取代的小时对象」的调度器入口（Wave 8 ③）。
//
// 为什么有这层：openship 上的现役 job 是宿主 bash——`for B in 3120 64188; do docker exec <console>
// python3 - < repo/scripts/lemeng/delete-supplanted-hour-partitions.py; done`。它依赖
// **console 容器在场**：console 部署/重启期间这一轮就失败。删对象本身只需要 ZOS 凭据 + HEAD，
// 调度器容器两样都有（`ZOS_*` 在 env、python3 在镜像里）⇒ 直接在这里跑。
//
// 判据仍然全在下游脚本里（不改一行）：默认 dry-run、`--before` 必填、**封版标记 + 天文件双证**
// 才删。本层只负责「按账套循环 + 算窗口 + 汇总退出码」，不复制任何安全判据。
//
// 窗口与现役逐字一致（宿主 `date -d` 是 UTC）：`--from = 今天(UTC) − 10 天`、`--before = 今天(UTC)`。
// `--from` 只是**扫描范围**；删不删由 `--before` 与三条判据决定。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 默认账套：与现役 job 的 `for B in 3120 64188` 逐字一致。 */
export const DEFAULT_BOOKS = ['3120', '64188']

/**
 * UTC 窗口：`{from, before}` 都是 `YYYY-MM-DD`。
 * - `before` = 今天（UTC），语义是「删 bizday < before 的日子」⇒ 停在昨天。
 * - `from` = before − 10 天（扫描范围，**不是**删除判据）。
 */
export function utcWindow(now = new Date()) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10)
  const today = day(now.getTime())
  const from = day(now.getTime() - 10 * 86_400_000)
  return { from, before: today }
}

/** 解析 `--books 3120,64188`；空/非法值抛错（不静默跑 0 个账套）。 */
export function parseBooks(raw) {
  const books = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (books.length === 0) throw new Error('hour-partition-gc: --books 不能为空')
  for (const b of books) {
    if (!/^[0-9A-Za-z_-]+$/.test(b)) throw new Error(`hour-partition-gc: 非法账套号 ${JSON.stringify(b)}`)
  }
  return books
}

const argvBooks = () => {
  const i = process.argv.indexOf('--books')
  if (i === -1) return DEFAULT_BOOKS
  if (i + 1 >= process.argv.length) throw new Error('hour-partition-gc: --books 缺值')
  return parseBooks(process.argv[i + 1])
}

function main() {
  const books = argvBooks()
  const { from, before } = utcWindow()
  const failed = []
  let planned = 0
  for (const book of books) {
    // 子进程 stdio 直通：下游脚本的 SKIP_*/DELETE_PLAN/DELETE_DRY_RUN 行原样进 job_run 输出。
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
  console.log(`HOUR_PARTITION_GC_DONE books=${books.join(',')} window=${from}..${before} plans=${planned} failed=${failed.length}`)
  // 任一账套失败即整体失败（同现役 bash 的 `|| rc=1`）：不做「部分成功」的假绿。
  if (failed.length > 0) {
    console.error(`HOUR_PARTITION_GC_FAILED ${failed.join(' ')}`)
    return 1
  }
  return 0
}

// 只在被直接执行时跑 main（测试 import 不触发）。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main())
}
