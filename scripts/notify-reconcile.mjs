#!/usr/bin/env node
// notify-reconcile.mjs — §2.4「指派与催办」声明式对账（T9/T11；全交 openship job）。
//
// 职责（全部幂等）：
//   ① 指派：逐人 enqueue forms.form.assigned（event_id = form:<assetId>:<version>:assigned:<user>）
//   ② 催办：到期未提交者逐人 enqueue forms.form.due_reminder（event_id 含日期 ⇒ 同日重跑不重复）
//
// 2026-10-27 通知基础设施改造：
//   - 不再派生规则（规则由 scripts/notify-seed-builtin.mjs 幂等 seed；本 job 只负责入队）
//   - 不再调用 Novu（投递由 notify-worker 异步完成；本 job 的退出码只看入队是否成功）
//
// ── 为什么是 scripts/ 脚本 ───────────────────────────────────────────────────────
// 它要同时读 forms 与 notify 两个 schema；`scripts/` 不在 B1 扫描根内（先例：
// reconcile-tenant-sources.mjs / check-tenant-isolation.mjs）。
//
// ── 用法 ────────────────────────────────────────────────────────────────────────
//   DATABASE_URL=<平台库> pnpm exec tsx scripts/notify-reconcile.mjs [--json]
//   退出码：0=全部入队成功（含重复）；1=有入队异常；2=缺 DATABASE_URL / 查询失败。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseAssignment, resolveAssigneeKeys } from '../modules/forms/domain/assignees.ts'
import { listAssignmentTargets } from '../modules/forms/storage.ts'
import { enqueueEvent } from '../modules/notify/storage.ts'

const DAY = 86400000
const KIND = 'form_def' // = modules/forms/storage.ts 的 KIND

/** @param {Date | string | number} d */
export const ymd = (d) => new Date(d).toISOString().slice(0, 10)

/**
 * 跑一轮对账。依赖可注入（便于无 DB 单测编排）；缺省用真实现。
 * @param {any} pool
 * @param {{ now?: Date, dryRun?: boolean,
 *           deps?: { listTargets?: typeof listAssignmentTargets,
 *                    resolveAssignees?: typeof resolveAssigneeKeys,
 *                    enqueue?: typeof enqueueEvent } }} [opts]
 * @returns {Promise<{ targets: number, emitted: number, duplicates: number }>}
 */
export async function reconcileOnce(pool, opts = {}) {
  const { now = new Date(), dryRun = false } = opts
  const {
    listTargets = listAssignmentTargets,
    resolveAssignees = resolveAssigneeKeys,
    enqueue = enqueueEvent,
  } = opts.deps ?? {}

  const base = process.env.PLATFORM_CONSOLE_BASE_URL ?? ''
  const targets = await listTargets(pool)
  let emitted = 0
  let duplicates = 0

  for (const t of targets) {
    const decl = parseAssignment(t.body)
    if (!decl) continue // 无 assignees ⇒ 该表单没有指派语义（负对照：零入队）
    /** @type {string[]} */
    const users = await resolveAssignees(pool, t.org, decl.dictRef)
    if (users.length === 0) continue // 名单空 ⇒ 无事可做

    // ① 指派：逐人入队（确定性 event_id ⇒ 重复调度天然去重）
    for (const user of users) {
      if (dryRun) continue
      const r = await enqueue(pool, {
        org: t.org,
        eventId: `form:${t.assetId}:${t.version}:assigned:${user}`,
        eventKey: 'forms.form.assigned',
        scope: t.assetId,
        payload: { assetId: t.assetId, assignee: user, link: `${base}/console/forms` },
        producer: 'forms',
      })
      if (r.accepted) emitted++
      else duplicates++
    }

    // ② 催办：到期（published_at + afterDays）且**未提交**者
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
        if (dryRun) continue
        const r = await enqueue(pool, {
          org: t.org,
          eventId: `form:${t.assetId}:${t.version}:remind:${user}:${day}`,
          eventKey: 'forms.form.due_reminder',
          scope: t.assetId,
          payload: { assetId: t.assetId, assignee: user, link: `${base}/console/forms` },
          producer: 'forms',
        })
        if (r.accepted) emitted++
        else duplicates++
      }
    }
  }

  return { targets: targets.length, emitted, duplicates }
}

// ── CLI 入口（被测试 import 时不执行）──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-reconcile: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    const r = await reconcileOnce(pool)
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(r)
        : `notify-reconcile: targets=${r.targets} emitted=${r.emitted} duplicates=${r.duplicates}`,
    )
    process.exit(0)
  } catch (e) {
    console.error('notify-reconcile 对不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
