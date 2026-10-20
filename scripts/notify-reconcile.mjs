#!/usr/bin/env node
// notify-reconcile.mjs — §2.4「指派与催办」声明式对账（T9/T11；决策 D-A：全交 openship job）。
//
// 三职责（全部幂等：规则确定性 id + 回执 unique(org,event_id,rule_id)）：
//   ① 派生：已发布表单的声明 → upsert 两条 notify 规则（form.assigned / form.due_reminder）
//   ② 指派：逐人 emit form.assigned（event_id = form:<assetId>:<version>:assigned:<user>）
//   ③ 催办：到期未提交者逐人 emit form.due_reminder（event_id 含日期 ⇒ 同日重跑不重复）
//
// ── 为什么是 scripts/ 脚本，而不是模块端点 / 发布路径接线 ────────────────────────────
// 它要**同时读 forms 与 notify 两个 schema**——模块结构性读不到别的模块（B1 三同纪律：
// `modules/**` 只许碰自己的 schema，见 scripts/lint-architecture.mjs 的扫描根 apps/packages/modules）。
// `scripts/` 不在扫描根内，故可跨 import；先例：reconcile-tenant-sources.mjs / check-tenant-isolation.mjs。
// 决策 D-A（2026-10-19 人拍板）：**发布路径不接线**——`form.assigned` 的投递由本脚本的下一次调度
// 承担（小时批 ≤1h）。理由：零新机制，与 emit-seam spec 原话一致（「in-platform 这一半既不需要
// HTTP、不需要令牌、更不需要跨模块通路」）。
//
// ── 用法 ────────────────────────────────────────────────────────────────────────
//   DATABASE_URL=<平台库> pnpm exec tsx scripts/notify-reconcile.mjs [--json]
//   退出码：0=干净 / 1=有失败（emit 回执 failed>0）/ 2=对不成账（缺 DATABASE_URL / 查询失败）。
//   ⚠️ DATABASE_URL / NOVU_* 一律从运行环境取（openship 项目 env）；**不要去 SSH 读机器状态**。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseAssignment, resolveAssigneeKeys } from '../modules/forms/domain/assignees.ts'
import { listAssignmentTargets } from '../modules/forms/storage.ts'
import { deriveFormAssignedRule, deriveReminderRule } from '../modules/notify/domain/derive.ts'
import { novuFromEnv } from '../modules/notify/domain/novu.ts'
import { emit } from '../modules/notify/pipeline.ts'
import { upsertRule } from '../modules/notify/storage.ts'

const DAY = 86400000
const KIND = 'form_def' // = modules/forms/storage.ts 的 KIND（三同纪律：schema/kind 名只有一处权威）
/** @param {Date | string | number} d */
export const ymd = (d) => new Date(d).toISOString().slice(0, 10)

/**
 * §2.6 方案 A：env → 按 org 解析的 **resolver 函数**（本文件唯一一处把 env 变成 resolver 的地方）。
 *
 * ⚠️ 必须返回**函数**而不是值：`emit`（modules/notify/pipeline.ts:54）在管道内按 `input.org`
 * **调用**它（`NOVU_API_KEY__<ORG>` → 全局回落 → null）。传值 = 每次 emit 必 `TypeError`，
 * 且被下面的 catch 兜成「对不成账」⇒ 退出码 2 ⇒ job 每次必败（**#936 的形态**：#929 把
 * `emit` 改成收 resolver 时漏改本文件）。范式同 modules/notify/index.ts:23。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('../modules/notify/domain/novu.ts').NovuResolver}
 */
const novuResolverFromEnv = (env = process.env) => (org) => novuFromEnv(env, org)

/**
 * 跑一轮对账。依赖可注入（`deps`）——便于无 DB 单测编排逻辑；缺省用真实现。
 *
 * `deps` 各槽写**真实签名**（`typeof` 取真实现）而不是 `Function`：`Function` 对参数零检查，
 * 正是 #936 里 `{ pool, novu }` 传错形状却让 `tsc` 放行的原因（`emitEvent` 一旦写宽，
 * 它收到的 `novu` 就不再与 `emit` 的契约对账）。
 * @param {any} pool
 * @param {{ now?: Date,
 *           novu?: import('../modules/notify/domain/novu.ts').NovuResolver,
 *           dryRun?: boolean,
 *           deps?: {
 *             listTargets?: typeof listAssignmentTargets,
 *             resolveAssignees?: typeof resolveAssigneeKeys,
 *             emitEvent?: typeof emit,
 *             upsert?: typeof upsertRule,
 *           } }} [opts]
 * @returns {Promise<{ derived: number, emitted: number, failed: number, targets: number }>}
 */
export async function reconcileOnce(pool, opts = {}) {
  const { now = new Date(), novu = novuResolverFromEnv(), dryRun = false } = opts
  const {
    listTargets = listAssignmentTargets,
    resolveAssignees = resolveAssigneeKeys,
    emitEvent = emit,
    upsert = upsertRule,
  } = opts.deps ?? {}

  const targets = await listTargets(pool)
  let derived = 0
  let emitted = 0
  let failed = 0

  for (const t of targets) {
    const decl = parseAssignment(t.body)
    if (!decl) continue // 无 assignees ⇒ 该表单没有指派语义（负对照：零派生零 emit）
    /** @type {string[]} */
    const users = await resolveAssignees(pool, t.org, decl.dictRef)
    if (users.length === 0) continue // 名单空（字典无条目 / 全软删）⇒ 无事可做
    const nowIso = now.toISOString()

    // ① 派生两条规则（确定性 id ⇒ upsert no-op）
    if (!dryRun) {
      await upsert(pool, t.org, deriveFormAssignedRule(t.org, { mount: t.assetId }, nowIso), 'system')
      derived++
      if (decl.afterDays !== null) {
        await upsert(pool, t.org, deriveReminderRule(t.org, { mount: t.assetId }, nowIso), 'system')
        derived++
      }
    }

    // ② 指派：逐人 emit（确定性 event_id ⇒ 重复调度天然去重）
    for (const user of users) {
      const r = await emitEvent({ pool, novu }, {
        org: t.org,
        eventId: `form:${t.assetId}:${t.version}:assigned:${user}`,
        eventType: 'form.assigned',
        mount: t.assetId,
        payload: { assignee: user },
      })
      emitted += r.delivered
      failed += r.failed
    }

    // ③ 催办：到期（published_at + afterDays）且**未提交**者
    if (decl.afterDays !== null && now.getTime() >= new Date(t.publishedAt).getTime() + decl.afterDays * DAY) {
      /** @type {{ rows: Array<{ submitted_by: string }> }} */
      const { rows } = await pool.query(
        `select distinct submitted_by from forms.submission
          where org=$1 and kind=$2 and asset_id=$3 and version=$4`,
        [t.org, KIND, t.assetId, t.version],
      )
      const submitted = new Set(rows.map((r) => r.submitted_by))
      const day = ymd(now)
      for (const user of users.filter((u) => !submitted.has(u))) {
        const r = await emitEvent({ pool, novu }, {
          org: t.org,
          eventId: `form:${t.assetId}:${t.version}:remind:${user}:${day}`,
          eventType: 'form.due_reminder',
          mount: t.assetId,
          payload: { assignee: user },
        })
        emitted += r.delivered
        failed += r.failed
      }
    }
  }

  return { derived, emitted, failed, targets: targets.length }
}

// ── CLI 入口（被测试 import 时不执行）──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-reconcile: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  // 惰性 require：本文件会被 `vitest run --dir scripts`（test:guard）以**纯核**方式 import——
  // 那条路径下 `pg` 解析不到（先例 reconcile-tenant-sources.mjs 同款 createRequire 姿势）。
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    const r = await reconcileOnce(pool, { novu: novuResolverFromEnv() })
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(r)
        : `notify-reconcile: targets=${r.targets} derived=${r.derived} emitted=${r.emitted} failed=${r.failed}`,
    )
    process.exit(r.failed > 0 ? 1 : 0)
  } catch (e) {
    console.error('notify-reconcile 对不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
