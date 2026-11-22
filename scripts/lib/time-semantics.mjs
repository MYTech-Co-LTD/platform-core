// time-semantics.mjs — 数据面时间语义的**单一事实源**（JS/CLI 侧原语，2026-11-22）。
//
// dbt 侧的对应原语在 `dbt/macros/time_semantics.sql`（shanghai_today / shanghai_days_ago /
// shanghai_hour_now / compile_time_date）。两侧**不能共享代码**（SQL vs JS 运行时），
// 但必须共享**同一套语义定义**——改动任何一侧时同步另一侧，并跑
// `scripts/lib/time-semantics.test.ts`（含扫描守卫：新增裸时区字面量会判红）。
//
// ## 为什么要有它
//
// 2026-11-22 一天修掉的四个缺陷全部是时间语义分歧（见宏文件头）。当时核心路径里还散着
// 内联的「上海今天 / 平移 n 天」重复实现——每复制一次就多一个漂移点。
//
// ## 时区两个坑
//
// 1. **DB / 进程时钟是 UTC**：直接 `new Date().toISOString().slice(0,10)` 拿到的是 UTC 日期，
//    在上海 00:00–08:00 会算成「昨天」（#2422 实测过同类，闭窗谓词把刚封版的时段整段剔掉）。
// 2. **平移必须锚在上海正午**：`new Date(day + 'T00:00:00Z')` 再加减天数，在东八区会跨日错位；
//    锚正午（+08:00 的 12:00）后加减天数对所有时区都稳定。

/** 数据面唯一的业务时区。任何「今天/小时」的判定都以它为准。 */
export const SHANGHAI_TZ = 'Asia/Shanghai'

/**
 * `tz` 下的当前日期 `YYYY-MM-DD`（`en-CA` 的短日期恰好是这个形状）。
 * @param {Date} [now]
 * @param {string} [tz]
 * @returns {string}
 */
export function todayIn(tz = SHANGHAI_TZ, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * 上海「今天」的 `YYYY-MM-DD`。
 * @param {Date} [now]
 * @returns {string}
 */
export function shanghaiToday(now = new Date()) {
  return todayIn(SHANGHAI_TZ, now)
}

/**
 * `YYYY-MM-DD` 平移 n 天（n 可为负）。**锚在上海正午**再按 UTC 加减，规避跨日/时区边界。
 * @param {string} day
 * @param {number} n
 * @returns {string}
 */
export function shiftDay(day, n) {
  const d = new Date(`${day}T12:00:00+08:00`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * 上海「今天 − n 天」的 `YYYY-MM-DD`（n ≥ 0）。
 * @param {number} n
 * @param {Date} [now]
 * @returns {string}
 */
export function shanghaiDaysAgo(n, now = new Date()) {
  return shiftDay(shanghaiToday(now), -n)
}

/**
 * 渲染成 SQL 日期字面量 `date 'YYYY-MM-DD'`。
 * ⚠️ 拼进 SQL 的日期**必须是字面量**：`now()` / 子查询形态会让 pg_duckdb 放弃 parquet
 * 文件裁剪（#2675 实测：活分区照被打开 ⇒ 采集期 ETag 竞态 668s 白跑）。
 * @param {string} day
 * @returns {string}
 */
export function dateLiteral(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`dateLiteral: 非法日期 ${JSON.stringify(day)}`)
  return `date '${day}'`
}
