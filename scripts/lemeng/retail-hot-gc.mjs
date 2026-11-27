#!/usr/bin/env node
// scripts/lemeng/retail-hot-gc.mjs — 热层 GC（#2761）：删 `staging.retail_hot` 中
// 「上海今天」以前的批次。
//
// 为什么需要：热表是 append-only 快照表（每 10 分钟一批，读侧只取最新 run_token），
//   旧批次是死数据。策略（spec §4.4）：**只保留今天的批次** —— 昨天的明细在封版后
//   已由 `_DAY_DATA` 天文件接管，热表里的旧行永远不会被读。
//
// 为什么与小时对象 GC（`hour-partition-gc.mjs`）分开、不塞进同一脚本：
//   · 判据不同：那边是「封版标记 + 天文件双证」的对象删除（走 ZOS API）；
//     这边是纯 pg DELETE（一行日期条件）。
//   · 失败域不同：对象存储故障不该连坐 pg 清理，反之亦然 ⇒ 独立脚本独立调度，
//     各自的 `jobs.job.failed` 通知互不掺杂。
//   · 两者只共享**同一个清理窗口**（CST 凌晨，错开几分钟），运维一眼可辨。
//
// 环境：`DATA_WAREHOUSE_URL`（worker 容器已有；psql 已在镜像内，Dockerfile.server 装了
//   postgresql-client）。不引新密钥。
//
// 退出码：0 清理成功；1 SQL 失败；2 配置/依赖缺失。
// stdout 末行：`RETAIL_HOT_GC_OK date=<上海今天> deleted=<n>` / `RETAIL_HOT_GC_FAILED: …`
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { shanghaiToday } from '../lib/time-semantics.mjs'

// 时区语义走单一事实源（scripts/lib/time-semantics.mjs）——扩散守卫会拦裸写时区字面量。

/**
 * 从 psql（`-tAq`）输出里取删除行数：期望是**一行裸数字**；兼容旧的 `DELETE n` 标签形态。
 * 解析不出来时返回 '?'（**不返回 0**：0 是「确实没删」，与「不知道」必须能区分）。
 * @param {unknown} stdout
 * @returns {string}
 */
export function parseDeleted(stdout) {
  const s = String(stdout ?? '')
  const tag = s.match(/DELETE (\d+)/)
  if (tag) return tag[1]
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  return /^\d+$/.test(last) ? last : '?'
}

/**
 * 真身：删除并打印审计行。
 * 只删「上海今天」以前的批次——今天的行永不删（热表就是当前小时的唯一来源）。
 * ⚠️ 必须用 `DELETE ... RETURNING` + `select count(*)`：`-q` 会**抑制 `DELETE n` 命令标签**，
 *    旧写法因此恒打印 `deleted=0`（2026-11-27 实测：真删了 347,678 行仍报 0）——那是最坏的一种
 *    「看起来很安全」，运维会以为 GC 没生效而去手工删。
 * 顶层包成函数是为了单测能 import（模块体不执行 ⇒ 未注入 env 也不会 exit）。
 */
function main() {
  const url = process.env.DATA_WAREHOUSE_URL
  if (!url) {
    console.error('RETAIL_HOT_GC_FAILED: DATA_WAREHOUSE_URL 未注入（worker 容器应自带）')
    process.exit(2)
  }
  const today = shanghaiToday()
  const sql = `with d as (delete from staging.retail_hot where bizday < date '${today}' returning 1) select count(*) from d;`

  const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
    timeout: 60_000,
  })

  if (r.error) {
    console.error(`RETAIL_HOT_GC_FAILED: psql 不可用（${r.error.message?.slice(0, 160)}）`)
    process.exit(2)
  }
  if (r.status !== 0) {
    console.error(`RETAIL_HOT_GC_FAILED: ${String(r.stderr || r.stdout || '').slice(0, 300)}`)
    process.exit(1)
  }

  console.log(`RETAIL_HOT_GC_OK date=${today} deleted=${parseDeleted(r.stdout)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
