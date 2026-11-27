#!/usr/bin/env node
// lake-compact-index.mjs — 湖封版分区压缩的**记账档**（C 设计 2026-11-26 终版）。
//
// 为什么记账不在 duckle 管线里：本环境实测，以远程 sink 结尾的管线所有节点都是惰性 view，
// `ctl.die` 恒数到 0 行（`materialize:true` 也不生效），且 die 之后不能分叉 ⇒
// 「守卫 + 统计 + 写索引」这套控制流放不进采集引擎。它放在这里：平台调度 job，读 `_MONTH`
// 的**单个文件**（比读全史便宜两个数量级），算行数与边界，写 `data.lake_compact_index`。
//
// 与搬运的分工：
//   · duckle `lake.compact` / `lake.compact.month`   = 纯字节搬运（src.s3 → snk.minio）
//   · 本脚本（`data.lake_compact_index`，CST 03:40）= 守卫 + 记账 + 索引
//
// 判据（fail-open，不前进 boundary）：
//   · 月文件存在且 rows>0            ⇒ status='ok'   写索引
//   · 月文件存在但 rows=0            ⇒ status='empty'（空月，写一条让父管线别再重试）
//   · 月文件不存在，且原始 glob=0    ⇒ status='empty'
//   · 月文件不存在，但原始有文件      ⇒ **跳过**（搬运没成功，下一轮再试；绝不写索引）
//
// 用法：DATABASE_URL=… DATA_WAREHOUSE_URL=… node scripts/lemeng/lake-compact-index.mjs [--dry-run] [--limit N]

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * 从 scripts/lemeng/ 直接 createRequire(...)('pg') 会 MODULE_NOT_FOUND（pnpm 布局）；
 * 按 scripts/ → apps/server → modules/data 顺序回退（同 sla-check.mjs 的做法）。
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

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, end: () => Promise<void> }} Db */

export const BUCKET_DEFAULT = 'shanhai-data'

/**
 * 月文件对象 key（与 duckle 搬运管线的 key 逐字一致——两边不一致会让读侧指向不存在的对象）。
 * @param {{source: string, book: number|string, ym: string, sha: string}} a
 */
export function monthObjectKey({ source, book, ym, sha }) {
  return `lemeng/${source}_month/_MONTH/v=${sha}/system_book=${book}/month=${ym}/all.parquet`
}

/** 原始月 glob（父管线同一表达式）。 */
/**
 * @param {{source: string, book: number|string, ym: string}} a
 */
export function rawMonthGlob({ source, book, ym }) {
  return `s3://${BUCKET_DEFAULT}/lemeng/${source}/system_book=${book}/bizday=${ym}-*/all.parquet`
}

/** 月文件 s3 URL。 */
/**
 * @param {{source: string, book: number|string, ym: string, sha: string}} a
 */
export function monthObjectUrl({ source, book, ym, sha }) {
  return `s3://${BUCKET_DEFAULT}/${monthObjectKey({ source, book, ym, sha })}`
}

/**
 * 从 index 表推待办月（与父管线 SQL 同语义：start_ym..上月，索引里没有当前 sha 的行）。
 * @param {{start_ym: string, until?: string}} a
 * @returns {string[]}
 */
export function monthsBetween({ start_ym, until }) {
  const out = []
  const [y0, m0] = start_ym.split('-').map(Number)
  const [y1, m1] = (until ?? lastMonth()).split('-').map(Number)
  let y = y0
  let m = m0
  while (y < y1 || (y === y1 && m <= m1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/**
 * 索引连续性：从 start_ym 到最后一个 ok 月，中间不许有洞。
 * 洞 = 父管线以为「该压」但索引里既没有 ok 也没有 empty 行 ⇒ 冷腿会漏一整个月（静默少数据）。
 * @param {{start_ym: string, last_ym: string, have: string[]}} a
 * @returns {string[]} 缺失月份
 */
export function missingMonths({ start_ym, last_ym, have }) {
  const set = new Set(have)
  return monthsBetween({ start_ym, until: last_ym }).filter((ym) => !set.has(ym))
}

/**
 * 记账滞后判据：索引里最大的 ok 月与「上月」之间允许的滞后（月数）。
 * 1 = 允许「上月还没压完」（常态是当晚压完；连续两晚失败才算红）。
 * @param {{last_ok_ym: string, now?: Date}} a
 * @returns {number} 滞后月数（0 = 跟上）
 */
export function lagMonths({ last_ok_ym, now = new Date() }) {
  const all = monthsBetween({ start_ym: last_ok_ym, until: lastMonth(now) })
  return Math.max(0, all.length - 1)
}

/** 上一个自然月（UTC 口径，与 job 的 CST 03:40 排班兼容：此时上月已封）。 */
export function lastMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  d.setUTCMonth(d.getUTCMonth() - 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * duckdb.query 的包装：读湖一律走它（PG 侧 read_parquet 只暴露单列 struct）。
 * @param {Db} pool
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
async function duck(pool, sql) {
  const r = await pool.query(`select * from duckdb.query($$ ${sql} $$)`)
  return r.rows
}

/**
 * @param {Db} pool
 * @param {string} url
 * @returns {Promise<{rows: number, min: string|null, max: string|null} | null>}
 */
export async function monthStats(pool, url) {
  try {
    const rows = await duck(pool, `select count(*)::bigint as n, min(bizday)::text as lo, max(bizday)::text as hi from read_parquet('${url}')`)
    const r = rows[0] ?? {}
    return { rows: Number(r.n ?? 0), min: r.lo ?? null, max: r.hi ?? null }
  } catch {
    return null // 对象不存在 / 读不动 ⇒ 交给调用方区分「原始为空」还是「搬运没成功」
  }
}

/**
 * 原始月**行数**（parity 用；比文件数贵，但一个月只有几十个文件）。
 * @param {Db} pool
 * @param {string} glob
 * @returns {Promise<number>}
 */
export async function rawRowCount(pool, glob) {
  const rows = await duck(pool, `select count(*)::bigint as n from read_parquet('${glob}')`)
  return Number(rows[0]?.n ?? 0)
}

/**
 * @param {Db} pool
 * @param {string} glob
 * @returns {Promise<number>}
 */
export async function rawFileCount(pool, glob) {
  const rows = await duck(pool, `select count(*)::bigint as n from glob('${glob}')`)
  return Number(rows[0]?.n ?? 0)
}

async function main() {
  const dry = process.argv.includes('--dry-run')
  const noParity = process.argv.includes('--no-parity')
  const limArg = process.argv.indexOf('--limit')
  const limit = limArg > -1 ? Number(process.argv[limArg + 1]) : 200
  const dbUrl = process.env.DATABASE_URL
  const whUrl = process.env.DATA_WAREHOUSE_URL
  if (!dbUrl || !whUrl) { console.error('缺 DATABASE_URL / DATA_WAREHOUSE_URL'); process.exit(2) }

  const { Pool } = loadPg(process.env.REPO_ROOT ?? process.cwd())
  const w = new Pool({ connectionString: whUrl })
  const p = new Pool({ connectionString: dbUrl })
  let written = 0
  let skipped = 0
  let failed = 0
  /** @type {Array<Record<string, unknown>>} */
  const parity = []
  try {
    const srcs = await w.query(`select source, start_ym, system_books, contract_sha from data.lake_compact_source where enabled order by source`)
    for (const s of srcs.rows) {
      for (const book of s.system_books) {
        const have = await w.query(
          `select ym from data.lake_compact_index where source=$1 and system_book=$2 and contract_sha=$3`,
          [s.source, book, s.contract_sha],
        )
        const done = new Set(have.rows.map((/** @type {any} */ r) => r.ym))
        const todo = monthsBetween({ start_ym: s.start_ym }).filter((ym) => !done.has(ym)).slice(0, limit)
        for (const ym of todo) {
          const key = monthObjectKey({ source: s.source, book, ym, sha: s.contract_sha })
          const url = monthObjectUrl({ source: s.source, book, ym, sha: s.contract_sha })
          const st = await monthStats(w, url)
          if (st === null) {
            const pattern = rawMonthGlob({ source: s.source, book, ym })
            const raw = await rawFileCount(w, pattern)
            if (raw === 0) {
              if (!dry) await upsert(w, { source: s.source, book, ym, rows: 0, min: null, max: null, sha: s.contract_sha, key, status: 'empty', pattern, files: 0 })
              written += 1
              console.log(JSON.stringify({ event: 'empty', source: s.source, book, ym, raw }))
            } else {
              skipped += 1
              console.log(JSON.stringify({ event: 'skip_object_missing', source: s.source, book, ym, raw }))
            }
            continue
          }
          const status = st.rows > 0 ? 'ok' : 'empty'
          const pattern = rawMonthGlob({ source: s.source, book, ym })
          // 输入指纹：这一月是从哪个模式、多少个原始文件算出来的（写路径一变即可比对出来）。
          let files = null
          // ③ parity：月文件 vs 原始同月（行数必须**精确**相等；金额比较留给既有 audit）
          if (!noParity && st.rows > 0) {
            const rawN = await rawRowCount(w, pattern)
            files = await rawFileCount(w, pattern)
            if (rawN !== st.rows) {
              parity.push({ source: s.source, book, ym, month: st.rows, raw: rawN })
              console.log(JSON.stringify({ event: 'parity_mismatch', source: s.source, book, ym, month: st.rows, raw: rawN }))
              continue // 不写索引（写了会让冷腿指向一个行数不对的月）
            }
          }
          if (!dry) await upsert(w, { source: s.source, book, ym, rows: st.rows, min: st.min, max: st.max, sha: s.contract_sha, key, status, pattern, files })
          written += 1
          console.log(JSON.stringify({ event: status, source: s.source, book, ym, rows: st.rows, min: st.min, max: st.max }))
        }
      }
    }
    // ── 断言（§7 的 ①②③；④ 由既有 audit 承担）────────────────────────────────
    const problems = []
    for (const s of srcs.rows) {
      for (const book of s.system_books) {
        const idx = await w.query(
          `select ym, status, built_at from data.lake_compact_index
            where source=$1 and system_book=$2 and contract_sha=$3 order by ym`,
          [s.source, book, s.contract_sha],
        )
        if (idx.rows.length === 0) continue // 尚未开压，不是错
        const have = idx.rows.map((/** @type {any} */ r) => r.ym)
        const lastOk = idx.rows.filter((/** @type {any} */ r) => r.status === 'ok').map((/** @type {any} */ r) => r.ym).pop()
        // ① 连续性（到最后一个 ok 月；更晚的缺口属于「还没跑」）
        if (lastOk) {
          const gap = missingMonths({ start_ym: s.start_ym, last_ym: lastOk, have })
          if (gap.length) problems.push({ check: 'contiguous', source: s.source, book, gap })
          // ② 滞后
          const lag = lagMonths({ last_ok_ym: lastOk })
          if (lag > 1) problems.push({ check: 'lag', source: s.source, book, lastOk, lag })
        }
      }
    }
    for (const pr of parity) problems.push({ check: 'parity', ...pr })
    for (const pr of problems) console.log(JSON.stringify({ event: 'assert_failed', ...pr }))
    if (problems.length && !dry) {
      console.error(JSON.stringify({ event: 'error', message: `${problems.length} 条压缩断言失败`, problems: problems.map((x) => x.check) }))
      process.exitCode = 1
    }
  } finally {
    await w.end().catch(() => {})
    await p.end().catch(() => {})
  }
  console.log(JSON.stringify({ event: 'done', written, skipped, failed, dry }))
}

/**
 * @param {Db} w
 * @param {{source:string,book:number|string,ym:string,rows:number,min:string|null,max:string|null,sha:string,key:string,status:string,pattern?:string|null,files?:number|null}} a
 */
async function upsert(w, a) {
  await w.query(
    `insert into data.lake_compact_index
       (source, system_book, ym, rows, bytes, min_bizday, max_bizday, contract_sha, object_key, status, built_at,
        input_pattern, input_files)
     values ($1,$2,$3,$4,null,$5,$6,$7,$8,$9, now(), $10, $11)
     on conflict (source, system_book, ym) do update set
       rows=excluded.rows, min_bizday=excluded.min_bizday, max_bizday=excluded.max_bizday,
       contract_sha=excluded.contract_sha, object_key=excluded.object_key,
       status=excluded.status, built_at=excluded.built_at,
       input_pattern=excluded.input_pattern, input_files=excluded.input_files`,
    [a.source, a.book, a.ym, a.rows, a.min, a.max, a.sha, a.key, a.status, a.pattern ?? null, a.files ?? null],
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(JSON.stringify({ event: 'error', message: String(e?.message ?? e) })); process.exit(1) })
}
