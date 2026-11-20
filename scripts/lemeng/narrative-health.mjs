#!/usr/bin/env node
// @ts-nocheck —— 调度器入口薄壳（判据本体是 python：`scripts/narrative-health-probe.py`）。
//
// narrative-health.mjs —— 叙事质量判据的调度器入口（#2612，Wave 8 ④）。
//
// 为什么需要薄壳：调度器 runner 固定用 `pnpm exec tsx <script>` 起作业，而判据本体是 python
// （只读平台 PG 的 `data.narrative_runs`）。与 `zero-row-check.mjs` 同一手法。
//
// 判据本体已容器化（#2612）：给了 `DATABASE_URL` 就走 psql 直连（不再 `docker exec` 进 postgres
// 容器），探针按 `OO_READ_*` 直接 POST —— 因此能在应用单元的 `notify-worker` 里跑，不需要 docker sock。
//
// 退出码语义与判据本体一致：
//   0 = 正常（含「近 N 天无生成样本」）/ 1 = 投递失败或查询失败（观测面降级，job 应当红）/ 2 = 参数或依赖问题。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** 判据本体（仓内路径，镜像 WORKDIR=/app）。 */
export const PROBE_SCRIPT = 'scripts/narrative-health-probe.py'

/** 组装 python argv（纯函数，单测用）：**总是 `--emit`**——不投递的探针等于没跑。 */
export function buildArgv(extra = []) {
  return [PROBE_SCRIPT, '--emit', ...extra]
}

function main() {
  const r = spawnSync('python3', buildArgv(process.argv.slice(2)), {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  })
  process.stdout.write(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  if (r.error) {
    // spawn 级失败（python3 不在）：台账要一眼看出是环境问题，而不是「判据判红」。
    console.error(`NARRATIVE_DEP_FAILED spawn: ${r.error.message}`)
    return 2
  }
  const rc = r.status ?? 2
  console.log(`NARRATIVE_HEALTH_DONE rc=${rc}`)
  return rc
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main())
}
