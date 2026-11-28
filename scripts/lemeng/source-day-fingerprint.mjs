#!/usr/bin/env node
// source-day-fingerprint.mjs — 给「可变窗口」补上**测量**（时序方法论 §4 缺口①，issue #2972）
//
// ── 它解决什么 ────────────────────────────────────────────────────────────────
// 时序方法论第 ① 步要三个参数：发布滞后 / **可变窗口** / 节奏。发布滞后有 SLA 在测，
// 可变窗口一直只是 `phase-audit.mjs` 里**人写的声明**（而且 2026-11-28 核对发现 6 条里错了 4 条）。
//
// 更值钱的问题：**为什么 T-1/T-2 要整天重采？** 若只有 1% 的行会变，现在就是拿 100% 的成本
// 处理 1% 的变化。要回答它，先得能量化「一个已采过的营业日，之后还会变多少」。
//
// ── 为什么是「记录」而不是「回查」（设计决断）──────────────────────────────────
// 湖是**按日覆盖写**的，旧版本不保留 ⇒ 「首采 vs 次日重采」**事后无法比较**。
//   ① 重新调源 API 取一次再比：每个源一套探针参数，且不可回溯；
//   ② **从今天起把每天的指纹记下来**：零额外 API、可回溯、攒 N 天自然有对比。
// 本脚本走 ②：**只读湖、只写一张窄表**，不改任何采集/物化行为。
//
// ── 怎么读这张表 ──────────────────────────────────────────────────────────────
//   select s.source, s.bizday,
//          max(s.rows) filter (where s.observed_on = current_date - 1) as rows_yesterday,
//          max(s.rows) filter (where s.observed_on = current_date)     as rows_today
//     from data.source_day_fingerprint s
//    where s.bizday < current_date
//    group by 1,2 having count(*) > 1;
//   ⇒ rows 相同 = 这一天首采后**没再变**（该源可变窗口可缩短）；不同 = 变了 |Δ| 行。
//   ⚠️ 至少 2 个观测日才有意义；单日只是基线。
//
// 用法：DATA_WAREHOUSE_URL=… node scripts/lemeng/source-day-fingerprint.mjs [--dry-run] [--days N]

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shanghaiDaysAgo } from '../lib/time-semantics.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUCKET = process.env.LEMENG_ZOS_BUCKET ?? 'shanhai-data'

/**
 * 要测的源。
 * `file` 是该源某账套某日的**精确对象**（已按 2026-11-28 实测的湖布局写死：
 * `inventory_snapshot/system_book=<b>/bizday=<YYYY-MM-DD>/chunk=all.parquet`）。
 * v1 只收一个源：它每小时重采 T-2、每天重采 T-3，是最激进的可变面；跑通攒够数据再加下一个。
 * @type {Array<{source: string, books: number[], file: (book: number, day: string) => string}>}
 */
export const SOURCES = [
  {
    source: 'inventory_snapshot',
    books: [3120, 64188],
    file: (book, day) => `s3://${BUCKET}/lemeng/inventory_snapshot/system_book=${book}/bizday=${day}/chunk=all.parquet`,
  },
]

/** 观测窗口：T-1..T-N（T-0 还在被写，指纹没意义）。 @param {number} n @param {Date} [now] @returns {string[]} */
export function observeDays(n = 3, now = new Date()) {
  return Array.from({ length: n }, (_, i) => shanghaiDaysAgo(i + 1, now))
}

/** 幂等建表：**观测日进主键**（同一天可被观测多次，历史保留）。 @param {any} pool */
export async function ensureTable(pool) {
  await pool.query(`
    create schema if not exists data;
    create table if not exists data.source_day_fingerprint (
      source       text        not null,
      system_book  integer     not null,
      bizday       date        not null,
      observed_on  date        not null,
      rows         bigint      not null check (rows >= 0),
      built_at     timestamptz not null default now(),
      primary key (source, system_book, bizday, observed_on)
    );
    comment on table data.source_day_fingerprint is
      '可变窗口测量（时序方法论 §4）：同一 (源,账套,营业日) 在不同观测日的行数指纹；'
      'rows 变化 = 这天在首采后仍被重写。至少 2 个观测日才能下结论。';
  `)
}

/** @param {any} pool @param {string} file @returns {Promise<number>} 行数；读不到抛错 */
export async function rowsOf(pool, file) {
  const r = await pool.query(`select * from duckdb.query($$select count(*) n from read_parquet('${file}')$$)`)
  return Number(r.rows[0]?.n ?? -1)
}

async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry-run')
  const i = args.indexOf('--days')
  const days = i > -1 ? Number(args[i + 1]) : 3
  const url = process.env.DATA_WAREHOUSE_URL
  if (!url) { console.error('SOURCE_FP_FAILED: 缺 DATA_WAREHOUSE_URL'); process.exit(2) }

  const { Pool } = (() => {
    for (const base of [import.meta.url, pathToFileURL(join(ROOT, 'apps/server/package.json')).href]) {
      try { return createRequire(base)('pg') } catch { /* next */ }
    }
    throw new Error('找不到 pg 模块')
  })()
  const pool = new Pool({ connectionString: url, statement_timeout: 180_000 })
  const observedOn = shanghaiDaysAgo(0)
  let written = 0
  try {
    if (!dry) await ensureTable(pool)
    for (const s of SOURCES) {
      for (const book of s.books) {
        for (const day of observeDays(days)) {
          const file = s.file(book, day)
          let rows
          try {
            rows = await rowsOf(pool, file)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.log(`SOURCE_FP_SKIP source=${s.source} book=${book} bizday=${day} reason=${msg.split('\n')[0].slice(0, 80)}`)
            continue
          }
          if (rows < 0) continue
          if (!dry) {
            await pool.query(
              `insert into data.source_day_fingerprint (source, system_book, bizday, observed_on, rows)
               values ($1,$2,$3::date,$4::date,$5)
               on conflict (source, system_book, bizday, observed_on)
               do update set rows = excluded.rows, built_at = now()`,
              [s.source, book, day, observedOn, rows],
            )
          }
          written += 1
          console.log(`SOURCE_FP source=${s.source} book=${book} bizday=${day} observed_on=${observedOn} rows=${rows}`)
        }
      }
    }
  } finally {
    await pool.end().catch(() => {})
  }
  console.log(`SOURCE_FP_OK observed_on=${observedOn} written=${written}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
