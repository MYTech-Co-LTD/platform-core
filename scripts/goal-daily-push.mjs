#!/usr/bin/env node
// scripts/goal-daily-push.mjs — 目标达成日报（件② 推送面，C3 / #2708）。
//
// 每天（CST 08:30）把「当月目标达成」投给看数人：读目标达成关系 → 一条 `forms.goal.daily`
// 事件入队（事件目录/模板/派生规则三处同描：modules/forms/manifest.yaml ⇔
// modules/notify/templates/builtin.ts ⇔ modules/notify/seed-builtin.ts）。
//
// ## 为什么是「入队」而不是直接发企微
//
// 通知的唯一通道是 notify 管道（架构 §2.6）：事件 → 规则 → 通道。本脚本只做「算数 + 入队」，
// 通道/收件人/模板都由规则面决定（收件人 = 持 `data:query` 的看数人，见 manifest 的
// recipients.viewers）。**不新增密钥、不新增投递面**。
//
// ## fail-open 的正确读法
//
// 推送是「旁路」：本 job 失败不改变任何业务数据（目标值/达成率都已物化在湖与 PG）。
//   · 缺 env / 读不到关系（数据面未就绪）⇒ exit 2（**不重试**：重试不会变好，等下一轮/人修）；
//   · DB/入队异常 ⇒ exit 1（可重试，调度器在 max_attempts 内重排）；
//   · 当月无目标行 / 重复投递 ⇒ exit 0（空集是合法初态，不算失败）。
// 这与 notify-emit-job.mjs 的退出码三分法逐字同源。
//
// ## 数据口径
//
// 每 goal×metric 一条：达成率 = Σactual / Σtarget（当月）；top 落后门店 = 达成率最低且
// target > 0 的前 5 家。**不重算口径**——值来自 `mart_goal_achievement__<goal>`（由
// goals.yml 生成，件② 段②）。时间进度取同一关系的 progress_rate（北京时钟日界）。
//
// 环境：DATABASE_URL（平台库，notify 入队）+ DATA_WAREHOUSE_URL（数据面，读达成关系）
//       + PUBLIC_ORIGIN（事件链接；缺省空串 —— 链接是 payload.url，允许空但会在模板里点不动）。
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { shanghaiToday } from './lib/time-semantics.mjs'
import { readGoals, goalMetricName, martRelation } from './gen-goal-achievement.mjs'

/** 事件 key（必须与 modules/forms/manifest.yaml 的声明逐字一致）。 */
export const EVENT_KEY = 'forms.goal.daily'
/** 事件生产方（声明模块 id）。 */
export const PRODUCER = 'forms'
/** 落后榜条数。 */
export const LAGGERS_LIMIT = 5

/**
 * 北京时钟的「今日」（YYYY-MM-DD）与「当月」（YYYY-MM）。
 * 时区语义走单一事实源 `scripts/lib/time-semantics.mjs`（扩散守卫禁止裸时区字面量）。
 * @param {Date} [now]
 * @returns {{ today: string, month: string }}
 */
export function cstToday(now = new Date()) {
  const today = shanghaiToday(now)
  return { today, month: today.slice(0, 7) }
}

/**
 * 事件 id：每 goal×metric×日 一条（同日重跑幂等，notify.event 的 (org,event_id) 主键去重）。
 * @param {string} goal @param {string} metric @param {string} day
 */
export function eventIdFor(goal, metric, day) {
  return `forms:goal:daily:${goal}:${metric}:${day}`
}

/**
 * 达成行 → 汇总（纯函数，单测的判据面）。
 * @param {Array<{ branch_num: string, target: string | number | null, actual: string | number | null }>} rows
 * @returns {{ target: number, actual: number, rate: number | null, laggers: Array<{ branchNum: string, rate: number, actual: number, target: number }> }}
 */
export function summarize(rows) {
  let target = 0
  let actual = 0
  /** @type {Array<{ branchNum: string, rate: number, actual: number, target: number }>} */
  const perStore = []
  for (const r of rows) {
    const t = r.target === null || r.target === undefined ? 0 : Number(r.target)
    const a = r.actual === null || r.actual === undefined ? 0 : Number(r.actual)
    if (!Number.isFinite(t) || !Number.isFinite(a)) continue
    target += t
    actual += a
    if (t > 0) perStore.push({ branchNum: String(r.branch_num), rate: Math.round((a / t) * 10000) / 10000, actual: a, target: t })
  }
  perStore.sort((x, y) => x.rate - y.rate || x.branchNum.localeCompare(y.branchNum))
  return {
    target,
    actual,
    rate: target > 0 ? Math.round((actual / target) * 10000) / 10000 : null, // target=0 ⇒ NULL（同达成率口径）
    laggers: perStore.slice(0, LAGGERS_LIMIT),
  }
}

/**
 * 落后榜 → 一行人读文本（模板变量是字符串；不塞嵌套结构，manifest payload 不支持嵌套）。
 * @param {Array<{ branchNum: string, rate: number }>} laggers
 */
export function laggersText(laggers) {
  if (laggers.length === 0) return '无（所有门店都有目标）'
  return laggers.map((l) => `门店${l.branchNum} ${(l.rate * 100).toFixed(1)}%`).join('；')
}

/**
 * 事件 payload（字段必须 ⊆ manifest 的 payload 声明）。
 * @param {{ goal: string, metric: string, period: string, rate: number | null, progress: number | null, laggers: string, link: string }} p
 */
export function buildPayload(p) {
  return {
    goal: p.goal,
    metric: p.metric,
    period: p.period,
    achievementRate: p.rate === null ? 'N/A' : `${(p.rate * 100).toFixed(1)}%`,
    progressRate: p.progress === null ? 'N/A' : `${(p.progress * 100).toFixed(1)}%`,
    topLaggards: p.laggers,
    link: p.link,
  }
}

/** 解析 pg（pnpm 布局：scripts/ 不是 workspace 包；先按本脚本，再按 notify 包）。 */
function requirePg() {
  for (const from of [import.meta.url, new URL('../modules/notify/package.json', import.meta.url).href]) {
    try {
      return createRequire(from)('pg')
    } catch {
      /* 试下一个落点 */
    }
  }
  throw new Error("解析不到依赖 'pg'（仓库没装依赖？先 pnpm install）")
}

/** 主流程（CLI 入口）。 */
async function main() {
  const url = process.env.DATABASE_URL
  const wh = process.env.DATA_WAREHOUSE_URL
  if (!url || !wh) {
    console.error('goal-daily-push: 缺 DATABASE_URL / DATA_WAREHOUSE_URL（本 job 要同时读平台库与数据面）')
    process.exitCode = 2
    return
  }
  const { Pool } = requirePg()
  const pool = new Pool({ connectionString: url })
  const whPool = new Pool({ connectionString: wh })
  const { enqueueEvent } = await import('../modules/notify/storage.ts')
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const { today, month } = cstToday()
  const link = `${process.env.PUBLIC_ORIGIN ?? ''}/app/data`
  let enqueued = 0
  let skipped = 0
  try {
    const goals = readGoals(rootDir)
    for (const goal of goals) {
      const mart = martRelation(goal)
      for (const metric of Object.keys(goal.actuals)) {
        const { rows } = await whPool.query(
          `select branch_num::text as branch_num,
                  sum(target_${metric}) as target,
                  sum(actual_${metric}) as actual
             from ${mart}
            where period = $1
            group by 1`,
          [month],
        )
        if (rows.length === 0) {
          skipped += 1
          console.error(`goal-daily-push: ${goal.goal} / ${metric} 当月（${month}）无目标行，跳过`)
          continue
        }
        // 进度 = 进度列在每店相同（同一日历月）⇒ 取任一行的 progress_rate
        const { rows: paceRows } = await whPool.query(
          `select max(progress_rate) as progress from ${mart} where period = $1`,
          [month],
        )
        const progress = paceRows[0]?.progress === null || paceRows[0]?.progress === undefined
          ? null
          : Number(paceRows[0].progress)
        const sum = summarize(rows)
        const payload = buildPayload({
          goal: goal.goal,
          metric,
          period: month,
          rate: sum.rate,
          progress,
          laggers: laggersText(sum.laggers),
          link,
        })
        const r = await enqueueEvent(pool, {
          org: goal.org,
          eventId: eventIdFor(goal.goal, metric, today),
          eventKey: EVENT_KEY,
          scope: `goal:${goal.goal}`,
          payload,
          producer: PRODUCER,
        })
        if (r.accepted) enqueued += 1
        else skipped += 1
        console.error(`goal-daily-push: ${goal.goal} / ${metric} → ${r.accepted ? 'enqueued' : r.reason}`)
      }
    }
    console.error(`goal-daily-push: enqueued=${enqueued} skipped=${skipped}（${today}）`)
  } finally {
    await pool.end()
    await whPool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((/** @type {any} */ e) => {
    console.error(`goal-daily-push 失败: ${e?.message ?? e}`)
    process.exitCode = 1
  })
}

// 供单测/调试显式引用（避免「导出未使用」误判）：goals 的指标名规则与事件目录同源
export { goalMetricName }
