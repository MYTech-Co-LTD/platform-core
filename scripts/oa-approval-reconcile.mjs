#!/usr/bin/env node
// oa-approval-reconcile.mjs — 审批终态对账（OA P1 Task 11 / issue #2363；spec §10.6 + §14.2）。
//
// 为什么需要它：引擎的 final 回调是**网络语义**（fail-open + 指数退避），平台侧不能假设
// 「回调一定到」。这个 job 按 externalRef/case 状态补齐终态——只更新 `status='pending_approval'`
// 的行 ⇒ **与回调同一 SQL、天然幂等**（谁先写谁生效，另一方 0 行）。
//
// 用法：
//   DATABASE_URL=... node scripts/oa-approval-reconcile.mjs --dry-run
//   DATABASE_URL=... node scripts/oa-approval-reconcile.mjs [--older-than-minutes=10] [--limit=500]
//
// 引擎配置解析（与模块 `domain/engine-client.ts` 同口径）：
//   ① `platform.oa_engine`（enabled）→ { base_url, pat_secret_ref }，PAT 值从 env[pat_secret_ref] 取；
//   ② 回落 `FORMS_OA_ENGINE_MAP`（JSON：{ "<org>": { "baseUrl", "patSecretRef" } }）。
//   脚本能读 platform schema（模块不能——B1）；两处同源靠「表优先」，配置只登记一次。
//
// 退出码：0 = 跑完（含「有 org 没配引擎」的跳过）；1 = 致命错误（连不上库等）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// 仓库根不依赖 pg（只有各 app/包依赖）⇒ 从 apps/server 的依赖树里取（照 check-org-tree.mjs）；
// 且**延迟到 main 里取**：本文件被单测 import 时不该拉起数据库驱动。
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))

const TERMINAL_CASE_STATUS = new Set(['approved', 'rejected', 'withdrawn', 'closed'])

/**
 * @typedef {Object} EngineConfig
 * @property {string} baseUrl
 * @property {string=} pat
 * @property {string} source
 */

/**
 * 引擎 case 详情 → 平台终态动作。纯函数（可单测）。
 * - 任一节点 reject/veto ⇒ rejected（first_reject_ends；引擎不再推进）
 * - 撤回事件/状态 ⇒ withdrawn
 * - 已终结且无驳回 ⇒ approved
 * - 非终态 ⇒ null（继续等）
 * @param {unknown} caseDetail
 * @returns {'approved'|'rejected'|'withdrawn'|null}
 */
export function deriveFinalAction(caseDetail) {
  if (!caseDetail || typeof caseDetail !== 'object') return null
  const c = /** @type {{status?: unknown, case?: {status?: unknown}, nodeDecisions?: unknown, events?: unknown}} */ (caseDetail)
  const decisions = Array.isArray(c.nodeDecisions) ? /** @type {any[]} */ (c.nodeDecisions) : []
  const events = Array.isArray(c.events) ? /** @type {any[]} */ (c.events) : []
  const rejected = decisions.some((d) => d?.action === 'reject' || d?.action === 'veto')
  const eventWithdrawn = events.some((e) => e?.type === 'withdrawn' || e?.action === 'withdrawn')
  const status = String(c.status ?? c.case?.status ?? '')
  if (eventWithdrawn || status === 'withdrawn') return 'withdrawn'
  if (rejected) return 'rejected'
  if (TERMINAL_CASE_STATUS.has(status)) return 'approved'
  return null
}

/**
 * @param {unknown} raw
 * @returns {Record<string, any>|null}
 */
export function parseEngineMap(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 单租户弹配置：表行 → env map（键 = org）。
 * @param {string} org
 * @param {Map<string, any>} rowsByOrg
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {EngineConfig|null}
 */
export function engineForOrg(org, rowsByOrg, env = process.env) {
  const row = rowsByOrg.get(org)
  if (row) {
    const pat = row.pat_secret_ref ? env[row.pat_secret_ref] : undefined
    return { baseUrl: row.base_url, pat: pat ?? undefined, source: 'platform.oa_engine' }
  }
  const hit = parseEngineMap(env.FORMS_OA_ENGINE_MAP)?.[org]
  if (hit) {
    return {
      baseUrl: hit.baseUrl,
      pat: hit.patSecretRef ? env[hit.patSecretRef] : undefined,
      source: 'FORMS_OA_ENGINE_MAP',
    }
  }
  return null
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function argOf(argv, name, fallback) {
  const pref = `--${name}=`
  const hit = argv.find((a) => a.startsWith(pref))
  if (hit === undefined) return fallback
  const n = Number(hit.slice(pref.length))
  return Number.isFinite(n) ? n : fallback
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const olderThanMinutes = argOf(argv, 'older-than-minutes', 10)
  const limit = argOf(argv, 'limit', 500)

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[oa-reconcile] DATABASE_URL 未设置')
    process.exit(1)
  }
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: databaseUrl })
  const t0 = Date.now()
  try {
    const { rows: pending } = await pool.query(
      `select org, id, case_ref, submitted_at
         from forms.submission
        where status = 'pending_approval'
          and submitted_at < now() - ($1::int * interval '1 minute')
        order by submitted_at asc
        limit $2`,
      [olderThanMinutes, limit],
    )

    const rowsByOrg = new Map()
    try {
      const { rows: engineRows } = await pool.query(
        'select org, base_url, pat_secret_ref from platform.oa_engine where enabled',
      )
      for (const r of engineRows) rowsByOrg.set(r.org, r)
    } catch (e) {
      // 本地/部分环境还没有 021 迁移：映射表不存在不是致命错误（回落 env map），但要可见
      if (/** @type {any} */ (e).code !== '42P01') throw e
      console.warn('[oa-reconcile] platform.oa_engine 不存在（未跑平台迁移？）——回落 FORMS_OA_ENGINE_MAP')
    }

    /** @type {{scanned:number, skippedNoCase:number, skippedNoEngine:number, stillPending:number, engineErrors:number, writeCandidates:number, written:number, byAction: Record<string, number>}} */
    const stats = {
      scanned: pending.length, skippedNoCase: 0, skippedNoEngine: 0,
      stillPending: 0, engineErrors: 0, writeCandidates: 0, written: 0, byAction: {},
    }
    const missingEngineOrgs = new Set()

    for (const row of pending) {
      if (!row.case_ref) { stats.skippedNoCase += 1; continue }
      const cfg = engineForOrg(row.org, rowsByOrg)
      if (!cfg || !cfg.baseUrl || !cfg.pat) {
        stats.skippedNoEngine += 1
        missingEngineOrgs.add(row.org)
        continue
      }
      let detail
      try {
        const res = await fetch(
          `${cfg.baseUrl.replace(/\/$/, '')}/cases/${encodeURIComponent(row.case_ref)}`,
          { headers: { Authorization: `Bearer ${cfg.pat}` } },
        )
        if (!res.ok) { stats.engineErrors += 1; continue }
        detail = await res.json()
      } catch (e) {
        stats.engineErrors += 1
        console.error(`[oa-reconcile] engine GET 失败 org=${row.org} case=${row.case_ref}: ${/** @type {any} */ (e).message}`)
        continue
      }
      const action = deriveFinalAction(detail)
      if (action === null) { stats.stillPending += 1; continue }
      stats.writeCandidates += 1
      if (dryRun) continue
      // 与回调同一 SQL：只改 still-pending ⇒ 回调先到则这里 0 行（幂等）
      const { rowCount } = await pool.query(
        // decision_comment 是**业务意见**，不塞运维备注（对账事实记在 forms.audit）
        `update forms.submission
            set status = $3, decided_at = now(), decision_action = $3,
                withdrawn_at = case when $3 = 'withdrawn' then now() else withdrawn_at end
          where org = $1 and case_ref = $2 and status = 'pending_approval'`,
        [row.org, row.case_ref, action],
      )
      if ((rowCount ?? 0) > 0) {
        stats.written += 1
        stats.byAction[action] = (stats.byAction[action] ?? 0) + 1
        await pool.query(
          `insert into forms.audit (org, actor, action, target, detail)
           values ($1, 'oa-approval-reconcile', 'approval.reconcile', $2, $3::jsonb)`,
          [row.org, String(row.id), JSON.stringify({ caseId: row.case_ref, action })],
        )
      }
    }

    console.log(JSON.stringify({
      dryRun, olderThanMinutes, limit, ...stats,
      missingEngineOrgs: [...missingEngineOrgs],
      durationMs: Date.now() - t0,
    }, null, 2))
  } finally {
    await pool.end()
  }
}

// 只在直接执行时跑 main（被单测 import 时不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('[oa-reconcile] fatal:', e)
    process.exit(1)
  })
}
