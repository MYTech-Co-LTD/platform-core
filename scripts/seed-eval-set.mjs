#!/usr/bin/env node
// seed-eval-set.mjs —— W6 Task 4 Step 1：生成「评估集候选清单」（**只读、零写入**）。
//
// 为什么只生成清单不写库：评估集的每一条都要人确认「这个问题问得对不对、期望口径是什么」。
// 脚本只负责把**已有的真实素材**摊在桌面上：
//   ① 已验问答（`data.verified_questions`）——现状基线
//   ② 未消解需求（`data.demand_signals`，dismissed_at is null）——真实有人问过但词表缺
//   ③ 可落地的指标对（L1 词表 + 需求 target）——给确认人参考
//
// 用法：
//   DATABASE_URL=... pnpm exec tsx scripts/seed-eval-set.mjs --org shanhaiyiguo-org [--out /tmp/eval-set.md]
//   （必须经 tsx 跑：scripts/ 解析不到根级 pg，靠 tsx 的 CJS require 钩子，与 demand-mining.mjs 同款）
//
// 输出：Markdown（stdout 或 --out）。确认后的人工裁决写回 notes 文档，由另一个步骤入库。
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

// 与 demand-mining.mjs 同款取法：scripts/ 在 pnpm 隔离 node_modules 下解析不到根级 pg，
// tsx 的 CJS require 钩子能解析（ESM 静态 import 不能）。
const { Pool } = createRequire(import.meta.url)('pg')

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{org: string, out: string|null}} */
  const out = { org: '', out: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') out.org = argv[i + 1] ?? ''
    else if (argv[i] === '--out') out.out = argv[i + 1] ?? null
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.org) {
  console.error('用法：pnpm exec tsx scripts/seed-eval-set.mjs --org <org> [--out file.md]')
  process.exit(2)
}
const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error('缺 DATABASE_URL')
  process.exit(2)
}

const pool = new Pool({ connectionString: url })
try {
  const verified = await pool.query(
    `select id, question, metric_id, status, strength, decided_by, left(question, 80) as q
       from data.verified_questions where org = $1
      order by (status = 'verified') desc, id`,
    [args.org],
  )
  const demands = await pool.query(
    `select kind, target, occurrences, last_seen, dismissed_at
       from data.demand_signals
      where org = $1 and dismissed_at is null
      order by occurrences desc, target`,
    [args.org],
  )
  const metrics = await pool.query(
    `select id, title, certified from data.metrics where org = $1 order by id`,
    [args.org],
  )

  /** @type {string[]} */
  const lines = []
  lines.push(`# 评估集候选清单（org=${args.org}）`, '')
  lines.push(`> 生成时间：${new Date().toISOString()} · **本文件是候选，不是评估集**：只有人工确认过的条目才算数（\`decided_by\` 非空）。`, '')

  lines.push(`## ① 已验问答（现状 ${verified.rows.length} 条）`, '', '| id | 状态 | 指标 | 问题 |', '|---|---|---|---|')
  for (const r of verified.rows) {
    lines.push(`| ${r.id} | ${r.status} | ${r.metric_id ?? '—'} | ${String(r.question ?? '').replace(/\|/g, '\\|').slice(0, 80)} |`)
  }
  lines.push('')

  lines.push(`## ② 未消解需求（${demands.rows.length} 条，按出现次数降序）`, '', '| kind | target | 次数 | 最近 |', '|---|---|---|---|')
  for (const r of demands.rows) {
    lines.push(`| ${r.kind} | ${r.target} | ${r.occurrences} | ${r.last_seen ?? '—'} |`)
  }
  lines.push('')

  lines.push(`## ③ 当前词表（${metrics.rows.length} 条指标，供确认口径时对照）`, '', '| id | 标题 | 档位 |', '|---|---|---|')
  for (const r of metrics.rows) {
    lines.push(`| ${r.id} | ${r.title} | ${r.certified} |`)
  }
  lines.push('')

  lines.push('## 确认办法', '')
  lines.push('1. 从 ② 里挑出「业务上真会问、且能落到 ③ 的某条指标」的需求，写成一句完整问法 + 期望指标 + 期望口径；')
  lines.push('2. 从 ① 里挑出已验但口径需要更新的；')
  lines.push('3. 确认结果写进 `docs/superpowers/notes/2026-11-06-w6-eval-set.md` 的「已确认」段，未确认的留在候选里标「待定」；')
  lines.push('4. 达到 50 条后由入库步骤写入（`decided_by` 必填），再跑 `verify-regression.mjs`。')

  const md = lines.join('\n') + '\n'
  if (args.out !== null) {
    writeFileSync(args.out, md, 'utf8')
    console.log(`written: ${args.out}（verified ${verified.rows.length} / demands ${demands.rows.length} / metrics ${metrics.rows.length}）`)
  } else {
    process.stdout.write(md)
  }
} finally {
  await pool.end()
}
