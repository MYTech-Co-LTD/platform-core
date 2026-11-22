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
import { shanghaiToday, shiftDay as shift } from '../lib/time-semantics.mjs'

const require = createRequire(import.meta.url)

/**
 * 本脚本只用到 `query` / `end` 两个方法 ⇒ 用局部结构类型，不拉 `pg` 的类型声明
 * （`scripts/` 在 pnpm 隔离 node_modules 下解析不到根级 `pg`，见 demand-mining.mjs 同款注）。
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, end: () => Promise<void> }} Queryable
 */
/** 断言执行结果。`detail` 会进 OO 行的 detail 字段（截断 400 字）。 */
/**
 * 断言结果。`verdict` 可选：默认由 `ok` 推出（OK/ERR）；只有「分不清真假」的情形才显式给
 * **WARN**（如查不动 ≠ 数据错）——WARN 仍然进 OO，桥也可转发，但它不冒充「这条判据失败了」。
 * @typedef {{ check: string, ok: boolean, detail: string, verdict?: 'OK'|'WARN'|'ERR' }} Verdict
 */

const SCHEMA = process.env.WIRE_SCHEMA ?? 'staging'
const PROBE_TABLE = process.env.WIRE_PROBE_TABLE ?? 'fct_retail_sale'
const FRESH_DAYS = numEnv('WIRE_FRESH_DAYS', 2)
const METRICS_TABLE = process.env.WIRE_METRICS_TABLE ?? 'data.metrics'
const DIM_TABLE = process.env.WIRE_DIM_TABLE ?? 'data.dim_item'
const DIM_FRESH_DAYS = numEnv('WIRE_DIM_FRESH_DAYS', 3)
const SEALED_TABLE = process.env.WIRE_SEALED_TABLE ?? 'data.lemeng_daily_sealed'
const DETAIL_VIEW = process.env.WIRE_DETAIL_VIEW ?? 'staging.vw_lemeng_retail_order_line'
const SEALED_MAX_AGE_MIN = numEnv('WIRE_SEALED_MAX_AGE_MIN', 180)
// drill 路径（月感知视图 + month 谓词）热态阈值：实测 ~2.5s，留 3× 余量（#2636）
const DETAIL_MAX_MS = numEnv('WIRE_DETAIL_MAX_MS', 8000)
// 通用视图（无裁剪能力）只挡灾难性退化：实测 12–14s，超 30s 才算事
const GENERIC_MAX_MS = numEnv('WIRE_GENERIC_MAX_MS', 30000)
const DETAIL_MONTH_VIEW = process.env.WIRE_DETAIL_MONTH_VIEW ?? 'staging.vw_lemeng_retail_order_line_month'
const HOT_GLOB = process.env.WIRE_HOT_GLOB
  ?? 's3://shanhai-data/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet'
// 2026-11-22 校准（#2668/#2636 实测）：71 个微文件 = 热腿 ~24s/tick + 每查询（350ms/文件）；
// GC 稳态 ~20-40 个。100 的旧阈值要等 ~35s 税才红，太晚。
const HOT_MAX_FILES = numEnv('WIRE_HOT_MAX_FILES', 60)
// ㉑ 日区 glob（湖卫生）：只从**文件名**提取日期（regexp on glob 结果），不打开任何文件。
const DAY_GLOB = process.env.WIRE_DAY_GLOB
  ?? 's3://shanhai-data/lemeng/retail_order_line/_DAY_DATA/system_book=*/bizday=*/all.parquet'
// 月文件在**隔壁目录**（`retail_order_line_month`）——与离线合并管线的输出同源（#2665 实测）。
const MONTH_GLOB = process.env.WIRE_MONTH_GLOB
  ?? 's3://shanhai-data/lemeng/retail_order_line_month/_MONTH/system_book=*/month=*/all.parquet'
// 差额换货月度抵扣额阈值（#2630；2026-11-22 校准）：旧默认 5,000 是按**半月**实测 4,155.92 定的，
// 整月必然超 ⇒ 每天恒 WARN（噪声化）。按整月实测校准：9 月 31,528.50 / 10 月 12,552.62 /
// 11 月至 21 日 7,353.99 ⇒ 取 15,000（≈ 近三月最高的半月量），超出才是「异常增长」。
const SWAP_OFFSET_MONTH_MAX = numEnv('WIRE_SWAP_OFFSET_MONTH_MAX', 15000)
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

/**
 * 查询一键重试：pg_duckdb 在 dbt 物化期间会因内存争用 cancel 掉并发查询
 * （实测 2026-11-21：tables 档重建期间 count(*) 被 `Query cancelled` 打断）。
 * 断言是低频只读，重试一次 + 短退避就够，**不是**掩盖失败——真错误第二次仍会抛。
 * @param {Queryable} pool @param {string} sql
 */
async function queryWithRetry(pool, sql) {
  try {
    return await pool.query(sql)
  } catch (e) {
    if (!/cancel|terminat|timeout|memory/i.test(msg(e))) throw e
    // 退避可配（测试里置 0，避免 5 个关系 ×1.5s 拖穿用例时限）
    // ⚠️ 不能用 numEnv：它要求 >0 才采信，而测试要用 0 关掉退避。
    const _d = Number(process.env.WIRE_RETRY_DELAY_MS)
    await new Promise((r) => setTimeout(r, Number.isFinite(_d) ? _d : 1500))
    return await pool.query(sql)
  }
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
 * ①② 仓库可达性：**测连接串里的那个 host**，不是写死的 docker 别名。
 *
 * 🔴 这条是 2026-11-21 真机首跑修正的：shell 版写死 `pg_duckdb`（同宿主 docker 网络别名），
 * 那是**两单元同机**时代的拓扑。W4 拆分后应用单元在 10.0.0.3、数据单元在 10.0.0.5，
 * 应用单元的 `DATA_WAREHOUSE_URL` 已改成私网 IP `10.0.0.5:15432` ⇒ 查字面名 `pg_duckdb`
 * 必 ENOTFOUND，**会天天误报「Gate-B 掉了」**。判据的本意是「消费方连得上仓库」，
 * 所以 host/port 一律从连接串取（数据单元那边它恰好仍是 `pg_duckdb:5432`，两种拓扑同一条码）。
 *
 * 保留「DNS 与 TCP 分开」的形状——一起红是解析/网络没了，只 TCP 红是端口/进程没了。
 */
async function checkGateB() {
  /** @type {Verdict[]} */
  const out = []
  const raw = process.env.DATA_WAREHOUSE_URL
  if (!raw) {
    return [
      { check: 'dns', ok: false, detail: 'ERR 缺 DATA_WAREHOUSE_URL（无法判定目标）' },
      { check: 'tcp', ok: false, detail: 'ERR 缺 DATA_WAREHOUSE_URL（无法判定目标）' },
    ]
  }
  const { hostname, port } = new URL(raw)
  const target = `${hostname}:${port || '5432'}`
  const { lookup } = require('node:dns').promises
  try {
    const { address } = await lookup(hostname)
    out.push({ check: 'dns', ok: true, detail: `OK ${hostname}→${address}` })
  } catch (e) {
    out.push({ check: 'dns', ok: false, detail: `ERR ${target} ${/** @type {any} */ (e)?.code ?? msg(e)}` })
  }
  try {
    await new Promise((resolve, reject) => {
      const s = require('node:net').connect(Number(port || 5432), hostname)
      s.setTimeout(5000)
      s.on('connect', () => { s.end(); resolve(undefined) })
      s.on('error', reject)
      s.on('timeout', () => reject(new Error('timeout')))
    })
    out.push({ check: 'tcp', ok: true, detail: `OK ${target}` })
  } catch (e) {
    out.push({ check: 'tcp', ok: false, detail: `ERR ${target} ${msg(e)}` })
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
              ((now() at time zone 'Asia/Shanghai')::date - $1::int)::text as cutoff
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
                ((now() at time zone 'Asia/Shanghai')::date - $1::int)::text as cutoff
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
              ((now() at time zone 'Asia/Shanghai')::date - $1::int)::text as cutoff
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
    // ── 延迟判据测**用户真实走的那条路**（2026-11-21 重写，#2636 的实测换来的）─────────────
    // 旧写法测 `DETAIL_VIEW` 且 bizday 谓词、且是新进程冷启动 ⇒ 恒 16s 假红。
    // 真机实测（同一会话，暖）：
    //   · drill 月感知视图 + month 谓词：1 个月 2.49s / 2 个月 2.56s（裁剪生效）
    //   · 通用视图（DETAIL_VIEW）单日：11.7–14.2s —— 它**打不开裁剪**（month 是分区列、
    //     bizday 只是数据列）⇒ 恒扫全部月文件，且**随历史增长线性变慢**；它服务的是
    //     drill 的「>5 个月」回退与 marts/审计，不是用户下钻的常规路径。
    //   · 冷启动（每次新进程）= 3.3s 固定开销（S3 secret 解析 + 文件元数据）⇒ 首跑必须丢弃。
    // ⇒ 判据：**热态 drill 路径**卡 8s（现状 ~2.5s）；通用视图只做「灾难性退化」护栏 30s
    //   （现状 12–14s，恶化到 2 倍才算事）。数字都写进 detail，便于看趋势。
    // ⚠️ 日期**必须先取再拼字面量**：子查询形态会让 pg_duckdb 放弃文件裁剪（>120s，2026-11-10 实测）。
    // ⚠️ **必须取「已合并的最近月份」，不能取当月**（2026-11-21 真机）：当月还没被月合并，
    //    drill 视图会走热腿（扫全部小时文件 + anti-join）⇒ 实测 7.9s 且随当日数据量波动，
    //    卡在 8s 阈值边缘。已合并月份走纯冷路径 ⇒ 实测 2.5s，才是这条判据要守的基线。
    const drillRel = DETAIL_MONTH_VIEW
    let ym = day.slice(0, 7)
    try {
      const mi = await pool.query(
        // ⚠️ 排除当月：月合并是**增量**的（当月 built_at 已有），不排除就还是热腿
        `select max(ym)::text as ym from data.lake_month_index where built_at is not null and ym < to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM')`,
      )
      const lastCompacted = String(mi.rows[0]?.ym ?? '')
      if (/^\d{4}-\d{2}$/.test(lastCompacted)) ym = lastCompacted
    } catch { /* 索引表不可读 ⇒ 退回当月（仍能判，只是数字含热腿） */ }
    // 预热一次（丢弃）：把 S3 secret/元数据缓存打热，测出来的才是用户会遇到的状态。
    await queryWithRetry(pool, `select count(*)::bigint as n from ${drillRel} where month = '${ym}'`).catch(() => {})
    const t0 = Date.now()
    const r = await pool.query(`select count(*)::bigint as n from ${drillRel} where month = '${ym}'`)
    const drillMs = Date.now() - t0
    const n = Number(r.rows[0].n)
    if (n <= 0) {
      return { check: 'detail_path', ok: false, detail: `ERR drill 视图 ${ym} 月 count=0（读不到数据）` }
    }
    if (drillMs > DETAIL_MAX_MS) {
      return {
        check: 'detail_path',
        ok: false,
        detail: `ERR drill 路径（${drillRel} month=${ym}）热态 ${drillMs}ms > ${DETAIL_MAX_MS}ms（rows=${n}）`,
      }
    }
    // 通用视图：只挡「灾难性退化」。它没有裁剪能力，12–14s 是当前结构成本，不是故障。
    const g0 = Date.now()
    const g = await queryWithRetry(
      pool,
      `select count(*)::bigint as n from ${DETAIL_VIEW} where bizday = date '${day}'`,
    )
    const genericMs = Date.now() - g0
    const gn = Number(g.rows[0].n)
    if (gn <= 0) {
      return { check: 'detail_path', ok: false, detail: 'ERR 最近封版日单日 count=0（视图读不到数据）' }
    }
    if (genericMs > GENERIC_MAX_MS) {
      return {
        check: 'detail_path',
        ok: false,
        detail: `ERR 通用视图单日 ${genericMs}ms > 灾难线 ${GENERIC_MAX_MS}ms（rows=${gn}；历史增长会让它线性变慢，见 #2636）`,
      }
    }
    return {
      check: 'detail_path',
      ok: true,
      detail: `OK sealed_refs=${sealedRefs} daily_refs=0 drill=${drillMs}ms(month=${ym}) generic=${genericMs}ms(day=${day},rows=${gn})`,
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

/**
 * ㉑ 湖卫生（2026-11-22 立案）：湖生命周期状态机的**路径级不变量**，全部从 glob 的
 * 文件名提取日期（`regexp_extract` on `glob()` 结果），**零文件打开** ⇒ 5 分钟档也跑得起。
 *
 * 为什么需要它（当天四案的共性）：
 *   · #2668——激进 GC 停跑两日，hour 区堆到 today−2 起共 71 个微文件（热腿 24s 税），
 *     ⑱ 的文件数阈值（当时 100）红不了；「最老 bizday」才是本质维度（today−2 即积压起点）。
 *   · #2666——compact 产物缺行（内容级，由 assert_serving_view_matches_main 金额级兜）；
 *     本检查兜它前面的结构级前提：**封版标记已写、日文件却缺失**（GC 判据脚本里「最该停下
 *     来」的状态——此时小时对象是唯一副本，任何读面/删除方都在裸奔）。
 *
 * 判据（CST 时区）：
 *   ① hour 区最老 bizday：≥ 上海今天−1 → OK；= 今天−2 → WARN（积压起点，#2668 当天形态）；
 *      ≤ 今天−3 → ERR（封版/GC 链条断）。
 *   ② 日区最新 bizday vs 封版表 max(bizday)：相等 → OK；日区落后 → ERR（标记写了日文件没写）。
 */
/** @param {Queryable} pool */
async function checkLakeHygiene(pool) {
  if (selftest('lake_hygiene')) {
    return { check: 'lake_hygiene', ok: false, detail: 'ERR 自测注入：湖卫生（WIRE_LAKE_HYGIENE_SELFTEST）' }
  }
  // 时间原语统一走 lib（dbt 侧对应 dbt/macros/time_semantics.sql）——本文件不再内联时区运算。
  const today = shanghaiToday()
  try {
    // ① hour 区最老 bizday（glob + 文件名正则，不打开文件）
    // ⚠️ 必须排除 **0 行哨兵**（`bizday=1970-01-01`，hot-glob-sentinel-parquet）：实测容器里
    //    hour 区 glob 的直接 min 就是 1970-01-01——不过滤会把每轮都判成「封版/GC 链条断」。
    //    用 `nullif` 折成 NULL，min 自然忽略（不引入第二个字符串字面量，少一层引号）。
    const hot = await pool.query(
      `select * from duckdb.query('select count(*)::bigint as n, min(nullif(regexp_extract(file, ''bizday=([0-9]{4}-[0-9]{2}-[0-9]{2})'', 1), ''1970-01-01'')) as oldest from glob(''${HOT_GLOB}'')') t`,
    )
    const oldest = String(hot.rows[0]?.oldest ?? '')
    const hourFiles = Number(hot.rows[0]?.n ?? 0)
    // ② 日区最新 bizday
    const day = await pool.query(
      `select * from duckdb.query('select count(*)::bigint as n, max(regexp_extract(file, ''bizday=([0-9]{4}-[0-9]{2}-[0-9]{2})'', 1)) as newest from glob(''${DAY_GLOB}'')') t`,
    )
    const dayNewest = String(day.rows[0]?.newest ?? '')
    const dayFiles = Number(day.rows[0]?.n ?? 0)
    // ③ 月文件数 + 封版/月索引水位（#2681：console 运行观测页直接消费本行 detail，不再自己扫湖——
    //    `/console/data/observability` 只查 PG；湖是对象存储，不该进请求路径）
    const month = await pool.query(
      `select * from duckdb.query('select count(*)::bigint as n from glob(''${MONTH_GLOB}'')') t`,
    )
    const monthFiles = Number(month.rows[0]?.n ?? 0)
    const sealed = await pool.query(
      `select coalesce(max(bizday)::text, '') as maxday,
              coalesce((select max(ym)::text from data.lake_month_index where built_at is not null), '') as month_max
         from ${SEALED_TABLE}`,
    )
    const sealedMax = String(sealed.rows[0]?.maxday ?? '')
    const monthIndexMax = String(sealed.rows[0]?.month_max ?? '')
    // 结构化 kv：**console 观测页按这个格式取值**（改格式 = 同步前端解析，两端一起动）。
    const kv = `hour_files=${hourFiles} hour_oldest=${oldest || '(空)'} day_files=${dayFiles} day_newest=${dayNewest}`
      + ` month_files=${monthFiles} sealed_max=${sealedMax || '(空)'} month_index=${monthIndexMax || '(空)'}`

    const errs = []
    const warns = []
    if (oldest === '') {
      // 空的 hour 区在当天首轮采集前可合法（哨兵随采集写）；持续为空会由 ⑯ 封版水位/采集
      // freshness 另行判红，这里不重复设阈值。
      warns.push('hour 区 glob 空（当天首轮采集前可空）')
    } else if (oldest <= shift(today, -3)) {
      errs.push(`hour 区最老 bizday=${oldest} ≤ 今天−3（封版/GC 链条断，#2668 形态的晚期）`)
    } else if (oldest === shift(today, -2)) {
      warns.push(`hour 区最老 bizday=${oldest} = 今天−2（积压起点；GC 停跑当日即此形态，热腿税 ~350ms/文件）`)
    }
    if (sealedMax !== '' && dayNewest !== '' && dayNewest < sealedMax) {
      errs.push(`日区最新 bizday=${dayNewest} < 封版 max=${sealedMax}（标记已写、日文件缺失——小时对象成唯一副本）`)
    }
    if (dayNewest === '') errs.push('日区 glob 空（_DAY_DATA 无文件——湖不可读）')
    if (errs.length > 0) {
      return { check: 'lake_hygiene', ok: false, detail: `ERR ${errs.join('；')} | ${kv}` }
    }
    if (warns.length > 0) {
      return /** @type {Verdict} */ ({ check: 'lake_hygiene', ok: true, verdict: 'WARN', detail: `WARN ${warns.join('；')} | ${kv}` })
    }
    return { check: 'lake_hygiene', ok: true, detail: `OK ${kv} today=${today}` }
  } catch (e) {
    return { check: 'lake_hygiene', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑲ 主体列合法（#2638 的事故换来的）：**每个发布关系里的 `org` 必须是单值且形如合法标识符**。
 *
 * 为什么 ⑰ 抓不到这一类：⑰ 只 `count(*)`（不带 org 过滤）——行数照常 > 0，看不出 org 脏了。
 * 事故形态：`mat_psql` 取 org 的通路把**失败文本**当值带回（OCI exec failed / psql not found），
 * 非空校验放行 ⇒ `subject_org()` 把它烧进 **VIEW 定义**（视图里是常量，永不自己更新）
 * ⇒ 三个明细视图的 org 全成那串错误文本 ⇒ `where org='<真租户>'` **恒 0 行且不报错**。
 *
 * 判据两条，缺一不可：
 *   ① 形态：`^[a-z0-9][a-z0-9._-]*$`（casdoor_org 的形状；错误文本带 `:` `"` 空格 ⇒ 必被拒）
 *   ② 单值：一个 relation 内 `count(distinct org)` 必须为 1 —— 多值说明混进了别的部署主体
 *     （「一面一租户」被破坏，docs/architecture.md §2.5）
 */
const ORG_RELATIONS = (process.env.WIRE_ORG_RELATIONS ?? [
  'staging.fct_retail_sale',
  'staging.fct_branch_expense',
  'staging.stg_lemeng_branch',
  'staging.vw_lemeng_retail_order_line',
  'staging.vw_lemeng_wholesale_out',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean)

/** @param {Queryable} pool */
async function checkOrgValid(pool) {
  if (selftest('org_valid')) {
    return { check: 'org_valid', ok: false, detail: 'ERR 自测注入：org 非法（WIRE_ORG_VALID_SELFTEST）' }
  }
  /** @type {string[]} */
  const bad = []
  /** 读不动（争用 / cancel）单独记——**它不是「org 脏」**，不能混成一条判红。 */
  /** @type {string[]} */
  const unreadable = []
  try {
    for (const rel of ORG_RELATIONS) {
      let rows
      try {
        rows = (await queryWithRetry(pool, `select org, count(*)::bigint as n from ${rel} group by 1`)).rows
      } catch (e) {
        // 🔴 2026-11-21 实测修正：这一格原本记进 `bad`（判 ERR），于是 **tables 档重建期间**
        //    pg_duckdb 争用导致 `Query cancelled` ⇒ ⑲ 连续误报「org 非法」，而那条视图单独查是好的。
        //    「读不动」与「org 脏」是两种东西，处置也不同（前者等下一轮，后者要修数据）
        //    ⇒ 单独记，判 **WARN**（进 OO、桥可转发，但不冒充「数据错了」）。
        unreadable.push(`${rel}（${msg(e).slice(0, 50)}）`)
        continue
      }
      if (rows.length === 0) {
        bad.push(`${rel}: 空表（无从判定主体列）`)
        continue
      }
      if (rows.length > 1) {
        bad.push(`${rel}: org 多值 ${rows.length} 个（一面一租户被破坏）`)
        continue
      }
      const org = String(rows[0].org ?? '')
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(org)) {
        bad.push(`${rel}: org 非法 \`${org.slice(0, 60)}\``)
      }
    }
    if (bad.length) return { check: 'org_valid', ok: false, detail: `ERR ${bad.join('; ')}` }
    if (unreadable.length) {
      return /** @type {Verdict} */ ({
        check: 'org_valid',
        ok: true,
        verdict: 'WARN',
        detail: `WARN 读不动 ${unreadable.join('; ')}（争用/cancel，不是 org 脏——下一轮再判）`,
      })
    }
    return { check: 'org_valid', ok: true, detail: `OK ${ORG_RELATIONS.length} 个关系主体列合法且单值` }
  } catch (e) {
    return { check: 'org_valid', ok: false, detail: `ERR ${msg(e)}` }
  }
}

/**
 * ⑳ 差额换货抵扣额（#2630 第 3 步）：本月累计 `swap_offset` 超阈值 ⇒ WARN。
 *
 * 为什么需要：差额换货（`0 < 订单总额 < 明细合计`）的退回行**接口无法识别**，只能出「抵扣额」
 * 这个上界。这一类的规模若在长，说明「源端口径差」在无声累积——必须让人看得见，
 * 否则它只会以零星 within_tol 的形式腐蚀台账（2026-11 半月实测 4,155.92）。
 * 判 **WARN** 而非 ERR：它是描述性指标，不是采集故障。
 */
/** @param {Queryable} pool */
async function checkSwapOffset(pool) {
  if (selftest('swap_offset')) {
    return { check: 'swap_offset', ok: false, detail: 'ERR 自测注入：差额换货抵扣额超阈（WIRE_SWAP_OFFSET_SELFTEST）' }
  }
  try {
    const r = await pool.query(
      `select coalesce(round(sum(swap_offset), 2), 0) as total, count(*) as store_days
         from staging.fct_retail_swap_offset
        where bizday >= date_trunc('month', (now() at time zone 'Asia/Shanghai')::date)::date`,
    )
    const total = Number(r.rows[0]?.total ?? 0)
    const storeDays = Number(r.rows[0]?.store_days ?? 0)
    if (total > SWAP_OFFSET_MONTH_MAX) {
      return /** @type {Verdict} */ ({
        check: 'swap_offset',
        ok: true,
        verdict: 'WARN',
        detail: `WARN 本月差额换货抵扣额 ${total} > 阈值 ${SWAP_OFFSET_MONTH_MAX}（${storeDays} 个店日；`
          + `该类的退回行接口无法识别，只在台账上以残留差的形式出现）`,
      })
    }
    return { check: 'swap_offset', ok: true, detail: `OK 本月抵扣额 ${total}（${storeDays} 个店日）` }
  } catch (e) {
    return { check: 'swap_offset', ok: false, detail: `ERR ${msg(e)}` }
  }
}

// ── 编排 ──────────────────────────────────────────────────────────────────────

/** advisory 集：判红只投递、不翻 rc（红线③：语义判据不走 job 通知）。 */
const ADVISORY = new Set([
  'org_valid',
  'region_registered',
  'recon_ledger_cover',
  'recon_not_evaluated',
  'recon_source_cover',
  'config_drift',
  'pg_crash_free',
  'sealed_manifest',
  'swap_offset',
  'detail_path',
  'hot_partitions',
  'lake_hygiene',
])

/**
 * @param {'all'|'core'|'oo'} [group]
 * @returns {Promise<Verdict[]>}
 */
export async function runAll(group = 'all') {
  /** @type {Verdict[]} */
  const out = []
  // 按**凭据边界**分组（不是按偏好）：⑭⑮ 要 OO 读凭据，而它只在应用单元；仓库/平台 PG 的
  // 断言在数据单元跑（贴着实例、且不占 API 容器的算力）。
  //   · `core`     —— 只需 DATA_WAREHOUSE_URL + DATABASE_URL（数据单元）
  //   · `oo`       —— 只需 OO 读凭据（应用单元；两条都是 OO 查询，无需仓库连接）
  const wantCore = group === 'all' || group === 'core'
  const wantOo = group === 'all' || group === 'oo'

  if (!wantCore) {
    return [await checkConfigDrift(), await checkPgCrashFree()]
  }

  const pool = await warehouse()
  try {
    // ①② 可达性与 ③ 真查询：一条链，掉线时这里先红（后面的 SQL 断言会跟着红，是有意的）。
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
    // ⑲ 主体列合法：⑰ 只 count、看不出 org 脏（#2638 事故形态）
    out.push(await checkOrgValid(pool))
    // ⑳ 差额换货抵扣额（描述性；超阈只 WARN）
    out.push(await checkSwapOffset(pool))
    // ㉑ 湖卫生（路径级不变量：hour 最老 bizday / 日区水位 vs 封版表）
    out.push(await checkLakeHygiene(pool))
  } finally {
    await pool.end().catch(() => {})
  }
  if (wantOo) {
    out.push(await checkConfigDrift())
    out.push(await checkPgCrashFree())
  }
  return out
}

/**
 * 解析 `--group core|oo|all`（默认 all；未知值响亮拒绝——静默忽略会让人以为跑过全套）。
 * @param {string[]} argv
 */
function parseGroup(argv) {
  const raw = argv.find((a) => a.startsWith('--group'))
  if (!raw) return 'all'
  const val = raw.includes('=') ? raw.split('=')[1] : argv[argv.indexOf(raw) + 1]
  const v = String(val)
  if (v !== 'core' && v !== 'oo' && v !== 'all') {
    throw new Error(`--group 只支持 core / oo / all，收到 '${val}'`)
  }
  /** @type {'all'|'core'|'oo'} */
  return v
}

async function main() {
  const group = parseGroup(process.argv.slice(2))
  const verdicts = await runAll(group)
  let errs = 0
  for (const v of verdicts) {
    const mode = ADVISORY.has(v.check) ? 'advisory' : 'hard'
    const verdict = v.verdict ?? (v.ok ? 'OK' : 'ERR')
    if (verdict === 'ERR') errs += 1
    console.log(`${verdict} ${v.check}: ${v.detail}`)
    await emitProbe({
      check: v.check,
      verdict,
      detail: v.detail.slice(0, 400),
      // ⚠️ probe 名与 shell 版**逐字相同**：历史行、按 probe 过滤的排障口径都认这个名字。
      probe: 'wire-warehouse',
      mode,
    })
  }
  console.log(
    `warehouse-assertions[${group}]: ${verdicts.length} checks, ${errs} ERR `
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
  checkOrgValid,
  checkPgCrashFree,
  checkQuery,
  checkReconLedgerCover,
  checkReconNotEvaluated,
  checkReconSourceCover,
  checkRegionRegistered,
  checkSealedManifest,
  checkSettlementFace,
  checkSwapOffset,
}
