#!/usr/bin/env node
// scripts/lemeng/warehouse-assertions.mjs — 数据面断言面的**容器化形态**（#2628）。
//
// ── 为什么需要它 ───────────────────────────────────────────────────────────────
// `scripts/lemeng/wire-warehouse.sh` 的断言族 ①–⑱ 曾是数据面的眼睛（封版双算、对账台账覆盖、
// 配置漂移、pg_duckdb 崩溃…）。它跑在**数据面宿主**上、靠 `docker exec` 进平台容器，所以
// 2026-11-19 调度面迁平台调度器后，它随旧 openship 探活 job 一起停发 —— **观测面停了 45h+，
// 且没有任何东西报错**（#2628）。本脚本把同一批判据搬进**应用单元容器内**执行，由
// `platform.job_schedule` 的 `data.warehouse_assertions` 驱动（*/5）。
//
// ── 判据一条没改 ───────────────────────────────────────────────────────────────
// 阈值、时段感知分界、check 名、advisory 归谁——**逐字照抄 shell 版**。check 名不变是有意的：
// OO 规则、桥（读 `verdict <> 'OK'`）、⑯ 的 `PROBE_NO_COOLDOWN` 豁免都按名字匹配，
// 改名等于把告警面重新接一遍线。
//
// ── 与 shell 版的两处机制差异（都是被迫的，理由在现场） ──────────────────────────
// ① ⑮ pg_duckdb 崩溃：宿主版 `docker logs`。容器内没有 docker ⇒ 改读 **OO 日志流**
//    `openship_platform_core_data_pg_duckdb`（2026-11-21 实测：signal 11 / recovery 命中 28 条，
//    判据原句是 postmaster 的，流里逐字带着）。
// ② ①②③ DNS/TCP/真查询：宿主版从**平台容器**里测 Gate-B 与 search_path。我们**就在**应用单元
//    （对于数据单元部署而言就是同一网络命名空间的那条路），所以直接打 `pg_duckdb:5432` +
//    不带 schema 的真查询——判据的**意图**（掉线即红、search_path 掉了即红）完全保留。
//
// ── 投递（红线③：告警单出口） ──────────────────────────────────────────────────
// 判红行经 `scripts/probe-emit.mjs` 进 OO `data_plane_probes`（advisory），桥转发企微。
// **本脚本永不因 advisory 判红翻 job rc**；只有「脚本自身崩了」才非零退出。
// 硬断言（①②③④⑤⑥⑦⑧⑨）在 shell 版里会翻 job rc —— 本形态**统一按 advisory 处理**，
// 理由：openship 的通知腿只应承载基础设施/job 崩溃级（分工红线③），而本 job 的崩溃本身
// 由调度器的 job 失败面覆盖。⇒ 告警语义变**宽**了一档，不会更吵。

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { emitProbe, emitFailure, ooEnv } from '../probe-emit.mjs'

const require = createRequire(import.meta.url)

/**
 * 本脚本只用到 `query` / `end` 两个方法 ⇒ 用局部结构类型，不拉 `pg` 的类型声明
 * （`scripts/` 在 pnpm 隔离 node_modules 下解析不到根级 `pg`，见 demand-mining.mjs 同款注）。
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, end: () => Promise<void> }} Queryable
 */
/** 断言执行结果。`detail` 会进 OO 行的 detail 字段（截断 400 字）。 */
/** @typedef {{ check: string, ok: boolean, detail: string }} Verdict */

const SCHEMA = process.env.WIRE_SCHEMA ?? 'staging'
const PROBE_TABLE = process.env.WIRE_PROBE_TABLE ?? 'fct_retail_sale'
const FRESH_DAYS = numEnv('WIRE_FRESH_DAYS', 2)
const METRICS_TABLE = process.env.WIRE_METRICS_TABLE ?? 'data.metrics'
const DIM_TABLE = process.env.WIRE_DIM_TABLE ?? 'data.dim_item'
const DIM_FRESH_DAYS = numEnv('WIRE_DIM_FRESH_DAYS', 3)
const SEALED_TABLE = process.env.WIRE_SEALED_TABLE ?? 'data.lemeng_daily_sealed'
const DETAIL_VIEW = process.env.WIRE_DETAIL_VIEW ?? 'staging.vw_lemeng_retail_order_line'
const SEALED_MAX_AGE_MIN = numEnv('WIRE_SEALED_MAX_AGE_MIN', 180)
const DETAIL_MAX_MS = numEnv('WIRE_DETAIL_MAX_MS', 15000)
const HOT_GLOB = process.env.WIRE_HOT_GLOB
  ?? 's3://shanhai-data/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet'
const HOT_MAX_FILES = numEnv('WIRE_HOT_MAX_FILES', 100)
const PGCRASH_WINDOW_MIN = numEnv('WIRE_PGCRASH_WINDOW_MIN', 15)
const PGCRASH_STREAM = process.env.WIRE_PGCRASH_STREAM ?? 'openship_platform_core_data_pg_duckdb'
const MARTS_FRESH_SPEC = process.env.WIRE_MARTS_FRESH_SPEC
  ?? 'fct_hq_outbound:3 fct_branch_expense:3 fct_client_expense:3 fct_inventory_snapshot:4 fct_purchase:3'

/** 反向测试钩子：每个 check 名都有一个 `WIRE_<NAME>_SELFTEST` 开关（与 shell 版同名同义）。 */
function selftest(/** @type {string} */ check) {
  const key = `WIRE_${check.toUpperCase()}_SELFTEST`
  return String(process.env[key] ?? '').trim() !== ''
}

/** @param {unknown} e */
function msg(e) {
  return e instanceof Error ? e.message : String(e)
}

/** @param {string} key @param {number} dflt */
function numEnv(key, dflt) {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** 应用单元的只读仓库连接（`analystPool` 已带 default_transaction_read_only + error 监听）。 */
async function warehouse() {
  const { analystPool } = await import(
    pathToFileURL(new URL('../../modules/data/domain/warehouse.ts', import.meta.url).pathname).href
  )
  return analystPool()
}

/** 平台主库（data.metrics / data.dim_* 这些**发布面**在平台 PG，不在仓库）。 */
function platformPool() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('缺 DATABASE_URL')
  const { Pool } = createRequire(import.meta.url)('pg')
  return new Pool({ connectionString: url })
}

// 上海时钟的「今天 − N 天」一律在 SQL 里算（`now() at time zone 'Asia/Shanghai'`），
// 不在 JS 里算——容器 TZ 实测是 UTC，在 JS 侧推日期会差一天且不报错（SOP §F.3 同型坑）。
// ISO 日期串按字典序即日期序 ⇒ 直接字符串比较，不必转 Date。

// ── 断言 ──────────────────────────────────────────────────────────────────────
// 命名与 shell 版一一对应（`assert_dns` → check 名 `dns`），便于两边对照排障。

/**
 * ①② Gate-B：容器直连 pg_duckdb:5432。
 * 保留 shell 版「DNS 与 TCP 分开」的形状——一起红是网络没了，只 TCP 红是端口/进程没了。
 */
async function checkGateB() {
  /** @type {Verdict[]} */
  const out = []
  const { lookup } = require('node:dns').promises
  try {
    const { address } = await lookup('pg_duckdb')
    out.push({ check: 'dns', ok: true, detail: `OK ${address}` })
  } catch (e) {
    out.push({ check: 'dns', ok: false, detail: `ERR ${/** @type {any} */ (e)?.code ?? msg(e)}` })
  }
  try {
    await new Promise((resolve, reject) => {
      const s = require('node:net').connect(5432, 'pg_duckdb')
      s.setTimeout(5000)
      s.on('connect', () => { s.end(); resolve(undefined) })
      s.on('error', reject)
      s.on('timeout', () => reject(new Error('timeout')))
    })
    out.push({ check: 'tcp', ok: true, detail: 'OK' })
  } catch (e) {
    out.push({ check: 'tcp', ok: false, detail: `ERR ${msg(e)}` })
  }
  return out
}

/**
 * ③ 真查询：**不带 schema** 打一张表 —— 掉 search_path 时这条先红（#297 的回归形态）。
 * shell 版特地在平台容器里跑，因为那是「消费方」的使用姿势；这里同样不带 schema。
 */
/** @param {Queryable} pool */
async function checkQuery(pool) {
  try {
    const sp = (await pool.query('show search_path')).rows[0].search_path
    const r = await pool.query(`select count(*)::int as n from ${PROBE_TABLE}`)
    return { check: 'query', ok: true, detail: `OK search_path=${sp} rows=${r.rows[0].n}` }
  } catch (e) {
    return { check: 'query', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/** ④ mart 新鲜度：max(bizday) 不得落后上海今天 −FRESH_DAYS。 */
/** @param {Queryable} pool */
async function checkFresh(pool) {
  try {
    const r = await pool.query(
      `select coalesce(max(bizday)::text,'') as maxday,
              ((now() at time zone 'Asia/Shanghai')::date - $1)::text as cutoff
         from ${PROBE_TABLE}`,
      [FRESH_DAYS],
    )
    const { maxday, cutoff } = r.rows[0]
    if (!maxday) return { check: 'fresh', ok: false, detail: 'ERR 表空（max(bizday) 为 null）' }
    if (maxday < cutoff) {
      return { check: 'fresh', ok: false, detail: `ERR 停更 max=${maxday} < 容差线=${cutoff}` }
    }
    return { check: 'fresh', ok: true, detail: `OK max=${maxday}（容差线 ${cutoff}）` }
  } catch (e) {
    return { check: 'fresh', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑨ 新构件新鲜度：容差分档（inventory_snapshot 的 bizday=T-2，比日更件宽一天）。
 * ⚠️ 容差**不许收紧**——那是源端发布滞后（46.6~48.2h）的结构事实，不是故障。
 */
/** @param {Queryable} pool */
async function checkMartsFresh(pool) {
  /** @type {string[]} */
  const bad = []
  const spec = MARTS_FRESH_SPEC.trim().split(/\s+/).map((s) => {
    const [t, d] = s.split(':')
    return { t: String(t), d: Number(d) }
  })
  try {
    for (const sp of spec) {
      const r = await pool.query(
        `select coalesce(max(bizday)::text,'') as maxday,
                ((now() at time zone 'Asia/Shanghai')::date - $1)::text as cutoff
           from ${SCHEMA}.${sp.t}`,
        [sp.d],
      )
      const { maxday, cutoff } = r.rows[0]
      if (!maxday || maxday < cutoff) bad.push(`${sp.t} max=${maxday || '(empty)'}<${cutoff}`)
    }
    return bad.length
      ? { check: 'marts_fresh', ok: false, detail: `ERR ${bad.join('; ')}` }
      : { check: 'marts_fresh', ok: true, detail: 'OK 全部构件在容差内' }
  } catch (e) {
    return { check: 'marts_fresh', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/** ⑤ 词表非空：`data.metrics` 被清空 ⇒ 问数无工具可给。
 *  （pool 可注入：纯判定要能在不连库的情况下测，见 .test.ts） */
/** @param {Queryable} [injected] */
async function checkMetrics(injected) {
  const own = !injected
  const pool = injected ?? platformPool()
  try {
    const r = await pool.query(`select count(*)::int as n from ${METRICS_TABLE}`)
    const n = r.rows[0].n
    return n < 1
      ? { check: 'metrics', ok: false, detail: 'ERR 词表 0 行' }
      : { check: 'metrics', ok: true, detail: `OK rows=${n}` }
  } catch (e) {
    return { check: 'metrics', ok: false, detail: `ERR ${msg(e)}` }
  } finally {
    if (own) await pool.end()
  }
}

/** ⑥ 发布维表非空 + 新鲜度（publish-dims 停跑 ⇒ 售后维表越来越旧）。 */
/** @param {Queryable} [injected] */
async function checkDims(injected) {
  const own = !injected
  const pool = injected ?? platformPool()
  try {
    const r = await pool.query(
      `select count(*)::int as n,
              coalesce(max(snapshot)::text,'') as maxday,
              ((now() at time zone 'Asia/Shanghai')::date - $1)::text as cutoff
         from ${DIM_TABLE}`,
      [DIM_FRESH_DAYS],
    )
    const { n, maxday, cutoff } = r.rows[0]
    if (n < 1) return { check: 'dims', ok: false, detail: 'ERR 发布表 0 行（publish-dims 未跑成功？）' }
    if (maxday < cutoff) {
      return { check: 'dims', ok: false, detail: `ERR 停更 max=${maxday} < 容差线=${cutoff}` }
    }
    return { check: 'dims', ok: true, detail: `OK rows=${n} snapshot=${maxday}（容差线 ${cutoff}）` }
  } catch (e) {
    return { check: 'dims', ok: false, detail: `ERR ${msg(e)}` }
  } finally {
    if (own) await pool.end()
  }
}

/**
 * ⑦ 工单取价面：**时段感知容差**（#534）——13 点前 −3、之后 −2。
 * 固定 −2 会让探活每晚 00:00–发布完成结构性红（首夜实测 ~200 条误报）。
 */
/** @param {Queryable} [injected] */
async function checkSettlementFace(injected) {
  const own = !injected
  const pool = injected ?? platformPool()
  try {
    const r = await pool.query(
      `select count(*)::int as n,
              coalesce(max(order_bizday)::text,'') as maxday,
              ((now() at time zone 'Asia/Shanghai')::date
                - (case when extract(hour from (now() at time zone 'Asia/Shanghai'))::int < 13
                        then 3 else 2 end))::text as cutoff
         from data.dim_settlement_order_line`,
    )
    const { n, maxday, cutoff } = r.rows[0]
    if (n < 1) return { check: 'settlement_face', ok: false, detail: 'ERR 取价面 0 行（publish-dims 未跑？）' }
    if (maxday < cutoff) {
      return { check: 'settlement_face', ok: false, detail: `ERR 停更 max=${maxday} < 容差线=${cutoff}` }
    }
    return { check: 'settlement_face', ok: true, detail: `OK rows=${n} order_bizday=${maxday}（容差线 ${cutoff}）` }
  } catch (e) {
    return { check: 'settlement_face', ok: false, detail: `ERR ${msg(e)}` }
  } finally {
    if (own) await pool.end()
  }
}

/** ⑧ 价目发布面：dim_item_price 停更 ⇒ 价格批增量失败无人知。 */
/** @param {Queryable} [injected] */
async function checkItemPrice(injected) {
  const own = !injected
  const pool = injected ?? platformPool()
  try {
    const r = await pool.query(
      `select count(*)::int as n,
              coalesce(max(snapshot)::text,'') as maxday,
              ((now() at time zone 'Asia/Shanghai')::date - 3)::text as cutoff
         from data.dim_item_price`,
    )
    const { n, maxday, cutoff } = r.rows[0]
    if (n < 1) return { check: 'item_price', ok: false, detail: 'ERR 价目面 0 行' }
    if (maxday < cutoff) {
      return { check: 'item_price', ok: false, detail: `ERR 停更 max=${maxday} < 容差线=${cutoff}` }
    }
    return { check: 'item_price', ok: true, detail: `OK rows=${n} snapshot=${maxday}（容差线 ${cutoff}）` }
  } catch (e) {
    return { check: 'item_price', ok: false, detail: `ERR ${msg(e)}` }
  } finally {
    if (own) await pool.end()
  }
}

/** ⑩ 战区未登记：门店档案最新快照里的 region_id 必须都在 dim_region（变化检测，不是覆盖率）。 */
/** @param {Queryable} pool */
async function checkRegionRegistered(pool) {
  if (selftest('region_registered')) {
    return { check: 'region_registered', ok: false, detail: 'ERR 自测注入：未登记战区（WIRE_REGION_REGISTERED_SELFTEST）' }
  }
  try {
    const r = await pool.query(
      `select b.system_book, b.region_id, count(distinct b.branch_num)::int as n
         from stg_lemeng_branch b
        where b.snapshot = (select max(snapshot) from stg_lemeng_branch)
          and b.region_id is not null
          and not exists (select 1 from dim_region r
                           where r.system_book = b.system_book and r.region_id = b.region_id)
        group by 1,2 order by 1,2`,
    )
    if (r.rows.length) {
      const txt = r.rows.map((x) => `${x.system_book}/${x.region_id}(${x.n}店)`).join(', ')
      return { check: 'region_registered', ok: false, detail: `ERR 未登记 ${txt}` }
    }
    return { check: 'region_registered', ok: true, detail: 'OK 全部已登记' }
  } catch (e) {
    return { check: 'region_registered', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑪ 台账覆盖：目标日 = 今天 −4（固定）。**不复用 12 点分界**——台账由 restate（CST 23:25）推进，
 * 按 12 点切会在 12:00–23:25 结构性红（2026-11-10 实测）。
 * 「基线为空不算过」：近 7 天一行都没有 ⇒ 判红（否则「台账整体消失」会假绿）。
 */
/** @param {Queryable} pool */
async function checkReconLedgerCover(pool) {
  if (selftest('recon_ledger_cover')) {
    return { check: 'recon_ledger_cover', ok: false, detail: 'ERR 自测注入：缺台账行（WIRE_RECON_LEDGER_COVER_SELFTEST）' }
  }
  try {
    const r = await pool.query(
      `with t as (select ((now() at time zone 'Asia/Shanghai')::date - 4) as d),
            b as (select distinct system_book, control from recon_run
                   where bizday > (select d from t) - 7)
       select b.system_book, b.control, r.status
         from b left join recon_run r
           on r.system_book = b.system_book and r.control = b.control and r.bizday = (select d from t)
        order by 1,2`,
    )
    if (!r.rows.length) {
      return { check: 'recon_ledger_cover', ok: false, detail: 'ERR 近 7 天台账没有任何行（物化没跑？判据缺基线，不能当通过）' }
    }
    const miss = r.rows.filter((x) => x.status === null || x.status === undefined)
    if (miss.length) {
      const txt = miss.map((x) => `${x.system_book}/${x.control}`).join(', ')
      return { check: 'recon_ledger_cover', ok: false, detail: `ERR 目标日缺台账行 ${txt}（对账没跑完？）` }
    }
    return { check: 'recon_ledger_cover', ok: true, detail: `OK 组合全在 n=${r.rows.length}` }
  } catch (e) {
    return { check: 'recon_ledger_cover', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/** ⑫ 源侧零返回（not_evaluated）—— **源故障 ≠ 数不平**，所以单列一条。 */
/** @param {Queryable} pool */
async function checkReconNotEvaluated(pool) {
  if (selftest('recon_not_evaluated')) {
    return { check: 'recon_not_evaluated', ok: false, detail: 'ERR 自测注入：源侧零返回（WIRE_RECON_NOT_EVALUATED_SELFTEST）' }
  }
  try {
    const r = await pool.query(
      `select system_book, control from recon_run
        where status = 'not_evaluated'
          and bizday = ((now() at time zone 'Asia/Shanghai')::date
                        - case when (now() at time zone 'Asia/Shanghai')::time < time '12:00:00'
                               then 4 else 3 end)
        order by 1,2`,
    )
    if (r.rows.length) {
      const txt = r.rows.map((x) => `${x.system_book}/${x.control}`).join(', ')
      return { check: 'recon_not_evaluated', ok: false, detail: `ERR 源侧一个值都没返回 ${txt}（源故障，不是账不平）` }
    }
    return { check: 'recon_not_evaluated', ok: true, detail: 'OK 无零返回' }
  } catch (e) {
    return { check: 'recon_not_evaluated', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/** ⑬ 源返回率 < 1：**先怀疑源**（2026-10-18 的真实误判：51/74 被读成「23 家结构性缺口」）。 */
/** @param {Queryable} pool */
async function checkReconSourceCover(pool) {
  if (selftest('recon_source_cover')) {
    return { check: 'recon_source_cover', ok: false, detail: 'ERR 自测注入：源少回一半（WIRE_RECON_SOURCE_COVER_SELFTEST）' }
  }
  try {
    const r = await pool.query(
      `select system_book, control, source_cover_pct from recon_run
        where source_cover_pct < 1 and status <> 'not_evaluated'
          and bizday = ((now() at time zone 'Asia/Shanghai')::date
                        - case when (now() at time zone 'Asia/Shanghai')::time < time '12:00:00'
                               then 4 else 3 end)
        order by 1,2`,
    )
    if (r.rows.length) {
      const txt = r.rows.map((x) => `${x.system_book}/${x.control}=${x.source_cover_pct}`).join(', ')
      return { check: 'recon_source_cover', ok: false, detail: `ERR 源侧有店没回数 ${txt}（先怀疑源：原样重跑一次再下结论）` }
    }
    return { check: 'recon_source_cover', ok: true, detail: 'OK 源侧全返回' }
  } catch (e) {
    return { check: 'recon_source_cover', ok: false, detail: `ERR ${msg(e)}` }
  }
}

// ── OO 检索（⑭ config_drift 与 ⑮ pg 崩溃共用） ────────────────────────────────

/**
 * 打一发 OO SearchSQL。时间窗是**微秒 epoch**（OO v1 口径）。
 * @param {string} sql
 * @param {number} sinceMin 距今多少分钟
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function ooSearch(sql, sinceMin) {
  const { base, org, token } = ooEnv()
  if (!base || !org || !token) throw new Error('OO 检索三元组缺（OO_READ_URL/ORG/TOKEN）')
  const nowUs = Date.now() * 1000
  const sinceUs = nowUs - sinceMin * 60 * 1_000_000
  const res = await fetch(`${base}/api/${org}/_search`, {
    method: 'POST',
    headers: {
      Authorization: token.startsWith('Basic ') || token.startsWith('Bearer ') ? token : `Basic ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: { sql, start_time: sinceUs, end_time: nowUs, from: 0, size: 50 },
    }),
  })
  if (!res.ok) throw new Error(`OO ${res.status} ${(await res.text()).slice(0, 120)}`)
  const body = await res.json()
  return Array.isArray(body?.hits) ? body.hits : []
}

/** ⑭ 配置漂移：gd 节点的「现算 vs 底账」diff 行（近 2h）。 */
async function checkConfigDrift() {
  if (selftest('config_drift')) {
    return { check: 'config_drift', ok: false, detail: 'ERR 自测注入：配置漂移（WIRE_CONFIG_DRIFT_SELFTEST）' }
  }
  try {
    const hits = await ooSearch(
      `select system_book, count(*)::int as n from "retail_day"
        where status = 'config_drift' group by system_book`,
      120,
    )
    if (hits.length) {
      const txt = hits.map((h) => `${h.system_book}(${h.n})`).join(', ')
      return {
        check: 'config_drift',
        ok: false,
        detail: `ERR 配置漂移 ${txt}（现算 vs 底账不一致——新店未纳入或底账腐化，#809）`,
      }
    }
    return { check: 'config_drift', ok: true, detail: 'OK 近 2h 无漂移行' }
  } catch (e) {
    return { check: 'config_drift', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑮ pg_duckdb backend 崩溃 —— **机制换了**：宿主 `docker logs` → OO 日志流。
 * 判据原句逐字不变（它们是 postmaster 写的，所以跨通道仍在）。
 * 为什么仍然要这条：backend 崩了容器**不重启**（RestartCount=0），crash_loop 看不见；
 * 恢复窗口几秒，③ 真查询大概率错过（2026-11-04~06 崩 5 次零预警，#1515）。
 */
async function checkPgCrashFree() {
  if (selftest('pg_crash_free')) {
    return { check: 'pg_crash_free', ok: false, detail: 'ERR 自测注入：模拟 backend signal 11（WIRE_PG_CRASH_FREE_SELFTEST）' }
  }
  try {
    const hits = await ooSearch(
      `select message from "${PGCRASH_STREAM}"
        where str_match(message, 'terminated by signal')
           or str_match(message, 'database system is in recovery mode')
           or str_match(message, 'terminating any other active server processes')
           or str_match(message, 'all server processes terminated; reinitializing')
           or str_match(message, 'double free or corruption')`,
      PGCRASH_WINDOW_MIN,
    )
    if (hits.length) {
      const sample = String(hits[0].message ?? '').slice(0, 160)
      return {
        check: 'pg_crash_free',
        ok: false,
        detail: `ERR 近 ${PGCRASH_WINDOW_MIN}m 有 ${hits.length} 条崩溃/recovery 日志：${sample}`,
      }
    }
    return { check: 'pg_crash_free', ok: true, detail: `OK 近 ${PGCRASH_WINDOW_MIN}m 无 signal 11 / recovery` }
  } catch (e) {
    return { check: 'pg_crash_free', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/** ⑯ 封版水位：max(bizday) 跟到上海今天−1（02:00 前按 −2）+ max(checked_at) 未超龄。 */
/** @param {Queryable} pool */
async function checkSealedManifest(pool) {
  if (selftest('sealed_manifest')) {
    return { check: 'sealed_manifest', ok: false, detail: 'ERR 自测注入：封版水位停更（WIRE_SEALED_MANIFEST_SELFTEST）' }
  }
  try {
    const r = await pool.query(
      `select (count(*) filter (where bizday > date '1970-01-01'))::int as n,
              coalesce(max(bizday)::text,'') as maxday,
              coalesce(round(extract(epoch from (now() - max(checked_at)))/60)::int,-1) as age_min,
              ((now() at time zone 'Asia/Shanghai')::date
                - case when (now() at time zone 'Asia/Shanghai')::time < time '02:00:00'
                       then 2 else 1 end)::text as cutoff
         from ${SEALED_TABLE}`,
    )
    const { n, maxday, age_min: ageMin, cutoff } = r.rows[0]
    if (n <= 0) return { check: 'sealed_manifest', ok: false, detail: 'ERR 表里没有有效封版行（n=0）' }
    if (maxday < cutoff) {
      return { check: 'sealed_manifest', ok: false, detail: `ERR 封版水位停更 max=${maxday} < 容差线=${cutoff}` }
    }
    if (ageMin < 0 || ageMin > SEALED_MAX_AGE_MIN) {
      return {
        check: 'sealed_manifest',
        ok: false,
        detail: `ERR reconcile 停摆：max(checked_at) 距今 ${ageMin < 0 ? '(空)' : `${ageMin} 分钟`} > ${SEALED_MAX_AGE_MIN} 分钟`,
      }
    }
    return { check: 'sealed_manifest', ok: true, detail: `OK max=${maxday}（容差线 ${cutoff}）sealed_age=${ageMin}m` }
  } catch (e) {
    return { check: 'sealed_manifest', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑰ 读路径未回退：视图定义含封版表、不含 `_DAILY`，再实测最近封版日单日延迟。
 * ⚠️ 日期**必须先取再拼字面量**：子查询形态会让 pg_duckdb 放弃文件裁剪（>120s 超时，
 * 2026-11-10 实测）；字面量 4.3s。日期只来自库内且经 ISO 正则校验后才拼接。
 */
/** @param {Queryable} pool */
async function checkDetailPath(pool) {
  if (selftest('detail_path')) {
    return { check: 'detail_path', ok: false, detail: 'ERR 自测注入：视图回退到 `_DAILY`（WIRE_DETAIL_PATH_SELFTEST）' }
  }
  try {
    const [schema, view] = DETAIL_VIEW.split('.')
    const d = await pool.query(
      `select position('lemeng_daily_sealed' in definition) as sealed_refs,
              position('_DAILY' in definition) as daily_refs
         from pg_views where schemaname = $1 and viewname = $2`,
      [schema, view],
    )
    if (d.rows.length === 0) {
      return { check: 'detail_path', ok: false, detail: `ERR 视图不存在：${DETAIL_VIEW}` }
    }
    const sealedRefs = Number(d.rows[0].sealed_refs)
    const dailyRefs = Number(d.rows[0].daily_refs)
    if (sealedRefs <= 0) {
      return { check: 'detail_path', ok: false, detail: 'ERR 视图定义不含封版表（sealed_refs=0）——读路径被改回别处' }
    }
    if (dailyRefs > 0) {
      return { check: 'detail_path', ok: false, detail: `ERR 视图定义仍含 _DAILY（daily_refs=${dailyRefs}）——#1872 的慢/崩路径回来了` }
    }
    const dq = await pool.query(
      `select max(bizday)::text as d from ${SEALED_TABLE} where bizday > date '1970-01-01'`,
    )
    const day = String(dq.rows[0].d ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return { check: 'detail_path', ok: false, detail: `ERR 取不到最近封版日（max(bizday)=${day}）` }
    }
    const t0 = Date.now()
    const r = await pool.query(`select count(*)::bigint as n from ${DETAIL_VIEW} where bizday = date '${day}'`)
    const ms = Date.now() - t0
    const n = Number(r.rows[0].n)
    if (n <= 0) {
      return { check: 'detail_path', ok: false, detail: 'ERR 最近封版日单日 count=0（视图读不到数据）' }
    }
    if (ms > DETAIL_MAX_MS) {
      return { check: 'detail_path', ok: false, detail: `ERR 单日 count 延迟 ${ms}ms > ${DETAIL_MAX_MS}ms（rows=${n}）` }
    }
    return {
      check: 'detail_path',
      ok: true,
      detail: `OK sealed_refs=${sealedRefs} daily_refs=0 day=${day} rows=${n} ${ms}ms`,
    }
  } catch (e) {
    return { check: 'detail_path', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑱ 热小时对象回收水位：glob 计数 > 阈值判红。
 * ⚠️ 外层 PG 不能直接 `select n`：pg_duckdb 的 `duckdb.query()` 返回 record，
 * PG 解析列名会报 `column n does not exist`（2026-11-11 实测）⇒ 用 `select *` 再取字段。
 */
/** @param {Queryable} pool */
async function checkHotPartitions(pool) {
  if (selftest('hot_partitions')) {
    return { check: 'hot_partitions', ok: false, detail: 'ERR 自测注入：热小时对象积压（WIRE_HOT_PARTITIONS_SELFTEST）' }
  }
  try {
    const sql = `select * from duckdb.query('select count(*) as n from glob(''${HOT_GLOB}'')') t`
    const r = await pool.query(sql)
    const n = Number(r.rows[0]?.n)
    if (!Number.isFinite(n)) {
      return { check: 'hot_partitions', ok: false, detail: 'ERR glob 结果不可解析' }
    }
    if (n > HOT_MAX_FILES) {
      return {
        check: 'hot_partitions',
        ok: false,
        detail: `ERR 热小时对象 ${n} > 阈值 ${HOT_MAX_FILES}（GC 没跑/失效；视图热腿会线性变慢）`,
      }
    }
    return { check: 'hot_partitions', ok: true, detail: `OK hot_files=${n}（阈值 ${HOT_MAX_FILES}）` }
  } catch (e) {
    return { check: 'hot_partitions', ok: false, detail: `ERR ${msg(e)}` }
  }
}

// ── 编排 ──────────────────────────────────────────────────────────────────────

/** advisory 集：判红只投递、不翻 rc（红线③：语义判据不走 job 通知）。 */
const ADVISORY = new Set([
  'region_registered',
  'recon_ledger_cover',
  'recon_not_evaluated',
  'recon_source_cover',
  'config_drift',
  'pg_crash_free',
  'sealed_manifest',
  'detail_path',
  'hot_partitions',
])

export async function runAll() {
  /** @type {Verdict[]} */
  const out = []
  const pool = await warehouse()

  try {
    // ①② Gate-B 与 ③ 真查询：一条链，掉线时这里先红（后面的 SQL 断言会跟着红，是有意的）。
    out.push(...(await checkGateB()))
    out.push(await checkQuery(pool))
    out.push(await checkFresh(pool))
    out.push(await checkMartsFresh(pool))
    // ⑤⑥⑦⑧ 读**平台 PG**（发布面），不在仓库。
    out.push(await checkMetrics())
    out.push(await checkDims())
    out.push(await checkSettlementFace())
    out.push(await checkItemPrice())
    // ⑩⑪⑫⑬⑯⑰⑱ 读仓库。
    out.push(await checkRegionRegistered(pool))
    out.push(await checkReconLedgerCover(pool))
    out.push(await checkReconNotEvaluated(pool))
    out.push(await checkReconSourceCover(pool))
    out.push(await checkSealedManifest(pool))
    out.push(await checkDetailPath(pool))
    out.push(await checkHotPartitions(pool))
    // ⑭⑮ 走 OO 检索。
    out.push(await checkConfigDrift())
    out.push(await checkPgCrashFree())
  } finally {
    await pool.end().catch(() => {})
  }
  return out
}

async function main() {
  const verdicts = await runAll()
  let errs = 0
  for (const v of verdicts) {
    const mode = ADVISORY.has(v.check) ? 'advisory' : 'hard'
    if (!v.ok) errs += 1
    console.log(`${v.ok ? 'OK ' : 'ERR'} ${v.check}: ${v.detail}`)
    await emitProbe({
      check: v.check,
      verdict: v.ok ? 'OK' : 'ERR',
      detail: v.detail.slice(0, 400),
      // ⚠️ probe 名与 shell 版**逐字相同**：历史行、按 probe 过滤的排障口径都认这个名字。
      probe: 'wire-warehouse',
      mode,
    })
  }
  console.log(
    `warehouse-assertions: ${verdicts.length} checks, ${errs} ERR `
    + `(advisory 判红不翻 rc；投递失败不改判定)`,
  )
  // 心跳：与 data.monitor_tick 同表，供看门狗判「探针停了」。
  const url = process.env.DATABASE_URL
  if (url) {
    const { Pool } = createRequire(import.meta.url)('pg')
    const pool = new Pool({ connectionString: url })
    try {
      await pool.query(
        `insert into platform.job_heartbeat (id, beat_at) values ('data.warehouse_assertions', now())
         on conflict (id) do update set beat_at = excluded.beat_at`,
      )
    } catch (e) {
      console.error(`heartbeat: ${msg(e)}`)
      await emitFailure('warehouse_assertions_heartbeat', msg(e)).catch(() => {})
    } finally {
      await pool.end().catch(() => {})
    }
  }
}

// 直接执行（被 import 用于单测时不跑 main）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    console.error(`warehouse-assertions: ${e.stack ?? e.message}`)
    // 脚本自身崩了 = 观测面失效，必须留痕（否则又是一次静默黑洞）。
    await emitFailure('warehouse_assertions_runner', String(e.message).slice(0, 400)).catch(() => {})
    process.exit(1)
  })
}

export {
  ADVISORY,
  checkConfigDrift,
  checkDetailPath,
  checkDims,
  checkFresh,
  checkGateB,
  checkHotPartitions,
  checkItemPrice,
  checkMartsFresh,
  checkMetrics,
  checkPgCrashFree,
  checkQuery,
  checkReconLedgerCover,
  checkReconNotEvaluated,
  checkReconSourceCover,
  checkRegionRegistered,
  checkSealedManifest,
  checkSettlementFace,
}
