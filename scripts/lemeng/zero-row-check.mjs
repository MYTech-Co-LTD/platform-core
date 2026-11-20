#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（逻辑全在 check-zero-row-days.py，这里只做「起进程 + 透传退出码」）。
//
// zero-row-check.mjs —— 日更件「静默 0 行」巡检的调度器入口（#2590，Wave 8 ④ 判据化第一刀）。
//
// 为什么需要薄壳：调度器的 runner 固定用 `pnpm exec tsx <script>` 起作业，而判据本体是 python
// （要借 pg_duckdb 的 `duckdb.query` 读湖）。与 hour-partition-gc.mjs 同一手法。
//
// 判据本体已经数据面化（#2590）：不再 `docker exec` 进 pg_duckdb，改走 DSN（DATA_WAREHOUSE_URL）；
// 判红行投 `data_plane_probes`（桥→企微）。本壳不改判定、不改退出码语义：
//   0 = 无异常 / 1 = 至少一个数据集命中「最近连续 0 行」/ 2 = 依赖不可用。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 与 openship 现役 job 逐字一致（`--books 3120,64188` 是脚本默认值，这里显式写死便于审阅）。 */
export const DEFAULT_ARGS = ['--books', '3120,64188']

/** 组装 python argv（纯函数，单测用）。 */
export function buildArgv(extra = []) {
  return ['scripts/lemeng/check-zero-row-days.py', ...DEFAULT_ARGS, ...extra]
}

function main() {
  const r = spawnSync('python3', buildArgv(process.argv.slice(2)), {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  process.stdout.write(out)
  if (r.error) {
    // spawn 级失败（python3 不在）：要让台账一眼看出是环境问题，而不是「巡检判红」。
    console.error(`ZERO_ROW_DEP_FAILED spawn: ${r.error.message}`)
    return 2
  }
  const rc = r.status ?? 2
  console.log(`ZERO_ROW_CHECK_DONE rc=${rc}`)
  return rc
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main())
}
