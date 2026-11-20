#!/usr/bin/env node
// @ts-nocheck —— 调度器入口薄壳：统计本体仍是 `deploy/duckle/console/scorecard-baseline.py`（只读 CSV）。
//
// monthly-review.mjs —— 月度采集健康基线（#2610，Wave 8 ④）。
//
// 原 openship job（`pipeline-monthly-review`）在宿主上跑：读 `/opt/pipeline-scorecard/*.csv`。
// 每日 job 判据化后**不再写宿主 CSV**（改投 OO probes）⇒ 月度输入会静默缩水。
// 现在每日 job 把快照写进命名卷 `scorecard-history`（`SCORECARD_CSV_DIR`），本脚本读同一卷。
//
// 判据（与旧 job 一致）：覆盖天数 < `MIN_DAYS`（缺省 7）⇒ 判红（投 `scorecard_baseline:coverage`）。
// 不同点：旧 job 靠**退出码 + 富文本 + notify 通道**，现在走**探针行 → 桥 → 企微**（告警单出口）。
//
// 退出码：0 = 覆盖够；1 = 覆盖不足（已投判红行）；2 = 跑不成（目录不可达 / python 起不来 / 输出不可解析）。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emitFailure, emitProbe } from '../probe-emit.mjs'
import { DEFAULT_CSV_DIR } from './pipeline-scorecard.mjs'

/** 统计本体（仓内路径，镜像 WORKDIR=/app）。 */
export const BASELINE_SCRIPT = 'deploy/duckle/console/scorecard-baseline.py'
/** 回看天数（与旧 job 的 `--days 31` 一致）。 */
export const LOOKBACK_DAYS = 31
/** 覆盖下限（旧 job 的 `MIN_DAYS:-7`）。 */
export const DEFAULT_MIN_DAYS = 7

/**
 * 从 baseline 首行解析覆盖天数：`scorecard-baseline: 31 天（2026-11-01..2026-11-30）· 1800 管线-天`。
 * 解析不到 ⇒ null（调用方按「跑不成」处理，不猜 0）。
 * @param {string} text
 * @returns {number|null}
 */
export function parseCoverageDays(text) {
  const m = /scorecard-baseline:\s*(\d+)\s*天/.exec(String(text ?? ''))
  return m ? Number(m[1]) : null
}

/** 目录里有没有至少一个快照（没有 ⇒ 月度基线无从谈起，直接判失败而不是输出空报告）。 */
export function hasSnapshots(dir) {
  try {
    return readdirSync(dir).some((n) => /^\d{4,}-\d{4}-\d{2}-\d{2}\.csv$/.test(n))
  } catch {
    return false
  }
}

/** baseline argv（纯函数，单测用）。 */
export function baselineArgv(dir, days = LOOKBACK_DAYS) {
  return [BASELINE_SCRIPT, dir, '--days', String(days)]
}

/**
 * 跑统计本体。
 * @param {{dir?: string, env?: Record<string,string|undefined>, spawn?: typeof spawnSync}} [opts]
 * @returns {{days: number|null, rc: number, output: string}}
 */
export function runBaseline(opts = {}) {
  const env = opts.env ?? process.env
  const spawn = opts.spawn ?? spawnSync
  const dir = opts.dir ?? ((env.SCORECARD_CSV_DIR ?? '').trim() || DEFAULT_CSV_DIR)
  if (!existsSync(dir) || !hasSnapshots(dir)) {
    return { days: null, rc: 2, output: `MONTHLY_NO_SNAPSHOTS ${dir}（每日 job 是否写过快照？）` }
  }
  const r = spawn('python3', baselineArgv(dir), { cwd: process.cwd(), encoding: 'utf8', env })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.error) return { days: null, rc: 2, output: `MONTHLY_DEP_FAILED spawn: ${r.error.message}` }
  const days = parseCoverageDays(r.stdout ?? '')
  if (days === null) return { days: null, rc: 2, output: `MONTHLY_PARSE_FAILED rc=${r.status}\n${output.slice(-400)}` }
  return { days, rc: r.status ?? 2, output }
}

async function main() {
  const minDaysRaw = Number(process.env.MIN_DAYS ?? DEFAULT_MIN_DAYS)
  const minDays = Number.isFinite(minDaysRaw) && minDaysRaw > 0 ? minDaysRaw : DEFAULT_MIN_DAYS
  const { days, rc, output } = runBaseline()
  process.stdout.write(output)
  if (days === null) {
    console.error('MONTHLY_FAILED')
    if (process.env.NODE_ENV !== 'test') await emitFailure('scorecard_baseline:run', output.slice(-300))
    return 2
  }
  if (days < minDays) {
    console.error(`MONTHLY_COVERAGE_SHORT ${days} < ${minDays}`)
    if (process.env.NODE_ENV !== 'test') {
      await emitProbe({
        probe: 'scorecard_baseline',
        check: 'scorecard_baseline:coverage',
        verdict: 'ERR',
        detail: `覆盖 ${days} 天 < 下限 ${minDays} 天（月度基线不可用）`,
      })
    }
    return 1
  }
  console.log(`MONTHLY_OK coverage=${days}d (min=${minDays})`)
  return rc === 0 || rc === 1 ? 0 : rc
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
