#!/usr/bin/env node
// scripts/metric-candidates-job.mjs — 候选池的**定时驱动**（Wave 1.4，#1969）。
//
// 为什么需要它：`/metrics/candidates/generate` 同时承担「产出新候选」与「退役陈旧候选 /
// 复活重新被支持的候选」（candidate-generator 的 expired/revived）——没有定时跑，池子只在
// 人手动点生成时才收敛，旧画像推出来的候选会无限累积。本 job 按「有画像的租户」逐个跑一遍。
//
// 退出码：0 全部成功；1 有租户生成失败（env/画像/词表问题，按 org 报出来）；2 查不成账
// （缺 DATABASE_URL / DATA_WAREHOUSE_URL，或读画像表本身失败）。**「0 条候选」不是失败**——
// 没有可推的列是正常结果；但 `orgs=0` 要能被看见（profiler 没投递的信号）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { generateCandidates, orgsWithProfiles } from '../modules/data/domain/candidate-generator.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbUrl = process.env.DATABASE_URL
  const whUrl = process.env.DATA_WAREHOUSE_URL
  if (!dbUrl) {
    console.error('metric-candidates: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  if (!whUrl) {
    // 画像在仓库库（data.metric_profiles）；没有它就不是「0 条候选」，是跑不了。
    console.error('metric-candidates: 缺 DATA_WAREHOUSE_URL（画像在仓库库，平台库读不到）')
    process.exit(2)
  }

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dbUrl })
  const warehouse = new Pool({ connectionString: whUrl })
  try {
    const orgs = await orgsWithProfiles(warehouse)
    if (orgs.length === 0) {
      // 正常但不该沉默：画像表空 = profiler 没投递（或换了库），监控要能一眼看见。
      console.log('metric-candidates: orgs=0（仓库里没有画像行——profiler 未投递？）')
      process.exit(0)
    }

    let failed = 0
    const totals = { added: 0, refreshed: 0, expired: 0, revived: 0, pendingAfter: 0 }
    for (const org of orgs) {
      const result = await generateCandidates({ pool, warehouse }, org, {})
      if (!result.ok) {
        failed += 1
        console.error(`metric-candidates: org=${org} 失败 code=${result.code}${result.detail === undefined ? '' : ` detail=${result.detail}`}`)
        continue
      }
      const r = result.report
      totals.added += r.added
      totals.refreshed += r.refreshed
      totals.expired += r.expired
      totals.revived += r.revived
      totals.pendingAfter += r.pendingAfter
      console.log(
        `metric-candidates: org=${org} profiles=${r.profiles} relations=${r.relations} `
        + `added=${r.added} refreshed=${r.refreshed} expired=${r.expired} revived=${r.revived} `
        + `pendingAfter=${r.pendingAfter} skipped=${r.skipped} capped=${r.capped} maxPerRelation=${r.maxPerRelation}`,
      )
    }
    console.log(
      `metric-candidates: orgs=${orgs.length} failed=${failed} added=${totals.added} `
      + `refreshed=${totals.refreshed} expired=${totals.expired} revived=${totals.revived} `
      + `pendingAfter=${totals.pendingAfter}`,
    )
    process.exit(failed === 0 ? 0 : 1)
  } catch (e) {
    console.error('metric-candidates 查不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await Promise.allSettled([pool.end(), warehouse.end()])
  }
}
