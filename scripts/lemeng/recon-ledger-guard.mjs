#!/usr/bin/env node
// recon-ledger-guard.mjs — 对账台账 `staging.recon_run` 的**当夜自愈闸**（issue #2894）。
//
// ── 它补的是哪一格 ────────────────────────────────────────────────────────────
// 断言 ⑪ `recon_ledger_cover` 只回答「T-4 有没有台账行」，它是**只读**的兜底：
// 红了之后没人会因此去重建台账 ⇒ 这一条会红满一整天，直到下一个 11:45 的对账档。
// 2026-11-26 实证：主档超时 ⇒ `recon_run` 停在 11-21，`recon_fact`/`recon_break` 已被对账档
// 刷到 11-23（#2890/#2891）。那种「上游都在、只有台账没建」只要重跑一次就很便宜（0.15s~35s）。
//
// ── 判据（与断言 ⑪ **逐字同源**，不许各写一套）──────────────────────────────────
// 对「近 7 天出现过的 (账套, control)」逐个要求：T-4 那天在 `recon_run` 里有行。
// 判据只此一条；本脚本不判金额、不判口径、不改 `status`——差多少是 `recon_break` 的事。
//
// ── 动作（只在**真的缺行**时才动手）──────────────────────────────────────────
// 重建 `recon_fact recon_break recon_run`（≈35s；不重建 `fct_retail_swap_offset`：
// 它是 recon_fact 的 left join 上游，与「某天没进台账」无关，且单轮 ~500s）。
//   · 缺行原因是「台账没重建」（最常见）          ⇒ 重建后行就有了
//   · 缺行原因是「源快照/平台侧当天没行」         ⇒ 重建也变不出来 ⇒ **exit 1 响铃**，
//     留给 `lemeng-recon-restate`（CST 23:25，已能识别「窗口内整天没台账」并逐日 heal）当夜补采，
//     次夜这一轮再重建即收口。
//
// ── 为什么在平台 scheduler（不是 openship）──────────────────────────────────────
// #2728：业务动作一律进平台。本 job 只在 worker 容器内跑 dbt（`materialize.sh` 容器模式）
// 与只读 SQL，不碰宿主 docker。
//
// 退出码：0 = 无缺口 / 已重建补齐；1 = 重建后仍缺（需人看依赖）；2 = 前置不满足（缺 env）。
// stdout 末行：`RECON_LEDGER_GUARD_{OK,HEALED,FAILED}` + 计数，供台账检索。
//
// 用法：DATA_WAREHOUSE_URL=… node scripts/lemeng/recon-ledger-guard.mjs [--dry-run]

import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { dateLiteral, shanghaiDaysAgo } from '../lib/time-semantics.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DRY = process.argv.includes('--dry-run')
const WAREHOUSE = process.env.DATA_WAREHOUSE_URL ?? ''

/**
 * 从 scripts/lemeng/ 直接 createRequire(...)('pg') 会 MODULE_NOT_FOUND（pnpm 布局）；
 * 按 scripts/ → apps/server → modules/data 顺序回退（同 lake-compact-index.mjs / sla-check.mjs）。
 * @param {string} root
 * @returns {any}
 */
function loadPg(root) {
  const bases = [
    import.meta.url,
    pathToFileURL(join(root, 'apps/server/package.json')).href,
    pathToFileURL(join(root, 'modules/data/package.json')).href,
  ]
  for (const base of bases) {
    try { return createRequire(base)('pg') } catch { /* next */ }
  }
  throw new Error('找不到 pg 模块（试过 scripts/、apps/server、modules/data）')
}

/**
 * 与断言 ⑪ `checkReconLedgerCover` 的同一条判据：目标日 T-4，期望集合 = 近 7 天出现过的
 * (账套, control)。**改这里必须同步改 warehouse-assertions.mjs**，两边不许分叉
 * （`recon-ledger-guard.test.ts` 把两边的「4 / 7」两个常量都钉住了）。
 *
 * 日期用 `dateLiteral(shanghaiDaysAgo(n))` 在 JS 侧算好再拼**字面量**：时区语义走单一事实源
 * （扩散守卫会拦裸写时区字面量），且字面量对 pg 的计划更友好。
 * 断言侧仍是 SQL 内 `now()`（历史形态、在白名单里）——两者在同一时刻取值相同。
 *
 * @param {any} pool
 * @param {Date} [now]
 * @returns {Promise<Array<{system_book: string, control: string}>>}
 */
export async function missingLedgerRows(pool, now = new Date()) {
  const target = dateLiteral(shanghaiDaysAgo(4, now)) // T-4
  const since = dateLiteral(shanghaiDaysAgo(11, now)) // (T-4) − 7
  const r = await pool.query(
    `with b as (select distinct system_book, control from recon_run
                 where bizday > ${since})
     select b.system_book, b.control
       from b left join recon_run r
         on r.system_book = b.system_book and r.control = b.control and r.bizday = ${target}
      where r.status is null
      order by 1, 2`,
  )
  return r.rows
}

/**
 * 重建台账三件（不碰 swap_offset）。容器模式：`dbt` 在 worker 镜像里，无需宿主 docker。
 * 目标目录用**独立路径**：共用 /tmp/dbt-target 会和 tick 档抢 run_results.json（失败节点解析）。
 * @returns {{ok: boolean, tail: string}}
 */
export function rebuildLedger() {
  const env = {
    ...process.env,
    MATERIALIZE_SCOPE: 'tables',
    DATA_PLANE_DOMAINS: 'lemeng',
    MATERIALIZE_MODE: 'container',
    MATERIALIZE_TABLES_SELECT: 'recon_fact recon_break recon_run',
    MATERIALIZE_TARGET_DIR: '/tmp/dbt-target-ledger-guard',
    MATERIALIZE_PROFILES_DIR: '/tmp/dbt-profiles-ledger-guard',
    MATERIALIZE_LOG_DIR: '/tmp/dbt-logs-ledger-guard',
  }
  const r = spawnSync('sh', [join(ROOT, 'scripts/lemeng/materialize.sh')], {
    env,
    encoding: 'utf8',
    timeout: 1_500_000,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { ok: r.status === 0, tail: out.trim().split('\n').slice(-12).join('\n') }
}

async function main() {
  if (!WAREHOUSE) {
    console.error('recon-ledger-guard: 缺 DATA_WAREHOUSE_URL')
    process.exit(2)
  }
  const { Pool } = loadPg(ROOT)
  const pool = new Pool({ connectionString: WAREHOUSE, statement_timeout: 120_000 })

  try {
    const before = await missingLedgerRows(pool)
    if (before.length === 0) {
      console.log('RECON_LEDGER_GUARD_OK missing=0')
      return 0
    }
    const list = before.map((x) => `${x.system_book}/${x.control}`).join(', ')
    console.log(`RECON_LEDGER_GUARD_PLAN missing=${before.length} rows=${list}`)
    if (DRY) {
      console.log(`RECON_LEDGER_GUARD_DRY missing=${before.length}（未重建）`)
      return 0
    }

    const build = rebuildLedger()
    if (!build.ok) {
      console.error('recon-ledger-guard: 重建失败（materialize 退出非 0）')
      console.error(build.tail)
      console.log(`RECON_LEDGER_GUARD_FAILED missing=${before.length} reason=rebuild_failed rows=${list}`)
      return 1
    }

    const after = await missingLedgerRows(pool)
    if (after.length === 0) {
      console.log(`RECON_LEDGER_GUARD_HEALED missing=${before.length} rows=${list}`)
      return 0
    }
    // 重建过仍缺 ⇒ 不是「台账没建」，而是「这一天在 recon_break 里就没有行」：
    // 源快照缺（console preagg 没跑成）或平台侧当天没数据。heal 归 recon-restate。
    const still = after.map((x) => `${x.system_book}/${x.control}`).join(', ')
    console.error(
      `recon-ledger-guard: 重建后仍缺 ${after.length} 行（${still}）——` +
        'T-4 在 recon_break 里没有行：疑似源快照缺失（看 console lemeng.recon.preagg 当日 run）' +
        '或平台侧当日无数据；heal 归 lemeng-recon-restate（CST 23:25）',
    )
    console.log(`RECON_LEDGER_GUARD_FAILED missing=${after.length} reason=upstream_gap rows=${still}`)
    return 1
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code))
}
