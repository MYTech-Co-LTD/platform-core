#!/usr/bin/env node
// scripts/metric-retire-job.mjs — 下线提案的**定时驱动**（指标治理尾波 2026-11-14）。
//
// 读面与安全过滤全在 `modules/data/domain/metric-retire.ts`（retireCandidatesOf 候选池 + 四条
// 安全闸），本脚本只做三件事：枚举有 L2 行的 org → 逐 org 提单 → 打汇总。**job 只提案不删行**
// ——生效唯一路径仍是人在「待核对」页采纳（会话 + data:manage）；提交身份固定
// `{userId:'metric-retire-job', channel:'job'}`，人在采纳侧可整单驳回。
//
// 驳回/未决的排除在域层（script 只报数不自带判定）：已有未决单或人已驳回的指标一律不重提；
// 回头路是真实变化——指标后来又有使用再归零时 updated_at 刷新、行龄重新给满一个窗口，
// 届时重提是「新证据」不是复读。
//
// 退出码（照 metric-candidates-job 惯例）：0 全部租户处理成功；1 有 org 失败（域层抛错，
// 或该 org 有提单动作被拒 `failed>0`，按 org 报出来）；2 查不成账（缺 DATABASE_URL /
// days 用法错 / org 枚举本身失败）。**「proposed=0」不是失败**——零使用的指标都被安全闸
// 挡下或本就没有候选是正常结果；但 `orgs=0` 要能被看见（L2 指标面没同步的信号）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { retireOrgs, submitRetireProposals } from '../modules/data/domain/metric-retire.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('metric-retire: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }

  // 窗口：--days N > METRIC_RETIRE_DAYS > 90。正整数，非法一律 exit 2（用法/环境类，不猜默认硬跑）。
  const flagIdx = process.argv.indexOf('--days')
  const rawDays = flagIdx !== -1 ? process.argv[flagIdx + 1] : process.env.METRIC_RETIRE_DAYS
  if (flagIdx !== -1 && rawDays === undefined) {
    console.error('metric-retire: --days 需要一个正整数（如 --days 90）')
    process.exit(2)
  }
  let days = 90
  if (rawDays !== undefined) {
    const n = Number(rawDays)
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`metric-retire: --days/METRIC_RETIRE_DAYS 必须是正整数，得到 ${JSON.stringify(rawDays)}`)
      process.exit(2)
    }
    days = n
  }

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dbUrl })
  try {
    const orgs = await retireOrgs(pool)
    if (orgs.length === 0) {
      // 正常但不该沉默：data.metrics 没有 L2 行 = 指标面没同步（sync-data-semantics 没跑？）。
      console.log('metric-retire: orgs=0（data.metrics 里没有 L2 行——语义没同步？）')
      process.exit(0)
    }

    let orgFailed = 0
    const totals = { proposed: 0, skipped: 0 }
    for (const org of orgs) {
      try {
        const r = await submitRetireProposals(pool, org, days, { userId: 'metric-retire-job', channel: 'job' })
        totals.proposed += r.proposed
        totals.skipped += r.skipped
        console.log(`metric-retire: org=${org} days=${days} proposed=${r.proposed} skipped=${r.skipped} failed=${r.failed}`)
        // failed = 该 org 里提单动作被拒的候选数（域层计数，非异常）：>0 算这个 org 失败。
        if (r.failed > 0) orgFailed += 1
      } catch (e) {
        orgFailed += 1
        console.error(`metric-retire: org=${org} 失败 ${e instanceof Error ? e.message : e}`)
      }
    }
    console.log(
      `metric-retire: orgs=${orgs.length} failed=${orgFailed} proposed=${totals.proposed} skipped=${totals.skipped}`,
    )
    process.exit(orgFailed === 0 ? 0 : 1)
  } catch (e) {
    console.error('metric-retire 查不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
