#!/usr/bin/env node
// scripts/lemeng/recon-monthly.mjs — 月度口径对账（#2728）：上一自然月逐日 × 两账套。
//
// 为什么在这里（平台 scheduler）而不是 openship：业务定时一律进平台（deploy/jobs.md §1）。
// 本脚本**不实现对账口径**：它只调两个 console 的现成管线 `lemeng.recon.preagg.backfill`
// （§1.4 第三层独立通道：湖内口径净额 vs 网关预聚合端点），口径实现只在 dbt 里那一份。
//
// 环境（worker 容器已有）：DUCKLE_TOKEN（三个容器同一份）、console 服务名可达。
// 账套 → console 的映射写死在本文件（两个账套固定一机）。
//
// 退出码：0 全部通过或有可解释的跳过；1 存在「判据破」（有差异）；2 配置/依赖不可用。
// stdout：末行 `RECON_MONTHLY_{OK,FAILED}` 摘要，供台账检索。

const TOKEN = process.env.DUCKLE_TOKEN ?? ''
const CONSOLES = [
  { book: '3120', base: process.env.CONSOLE_3120_URL ?? 'http://lemeng-console-3120:18080' },
  { book: '64188', base: process.env.CONSOLE_64188_URL ?? 'http://lemeng-console-64188:18081' },
]
const PIPELINE = 'pipelines/lemeng.recon.preagg.backfill.json'
const POLL_MS = 3000
const PER_RUN_TIMEOUT_MS = Number(process.env.RECON_MONTHLY_RUN_TIMEOUT_MS ?? 240_000)

function shanghaiNow() {
  // 只用来取「当前是哪一年哪一月」，不参与口径计算
  return new Date(Date.now() + 8 * 3600 * 1000)
}

/** 上一个月：{ label: 'YYYY-MM', days: ['YYYY-MM-DD', ...] } */
function previousMonth(now = shanghaiNow()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based
  const py = m === 0 ? y - 1 : y
  const pm = m === 0 ? 12 : m
  const daysInMonth = new Date(Date.UTC(py, pm, 0)).getUTCDate()
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const d = String(i + 1).padStart(2, '0')
    return `${py}-${String(pm).padStart(2, '0')}-${d}`
  })
  return { label: `${py}-${String(pm).padStart(2, '0')}`, days }
}

/** @param {string} url @param {unknown} body @returns {Promise<any>} */
async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** @param {string} url @returns {Promise<any>} */
async function getJson(url) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** 触发一天的管线并等它跑完；返回 { verdict, detail } */
/** @param {string} consoleBase @param {string} day @returns {Promise<{verdict: string, detail: string}>} */
async function runOneDay(consoleBase, day) {
  const started = Date.now()
  /** @type {string|undefined} */
  let runId
  try {
    const j = await postJson(`${consoleBase}/api/run/async`, { file: PIPELINE, params: { BIZDAY: day } })
    runId = j.runId
    if (!runId) return { verdict: 'fail', detail: `trigger 未返回 runId：${JSON.stringify(j).slice(0, 200)}` }
  } catch (e) {
    return { verdict: 'unavailable', detail: `trigger 失败：${String(e).slice(0, 200)}` }
  }

  /** @type {any} */
  let st = {}
  while (Date.now() - started < PER_RUN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    try {
      st = await getJson(`${consoleBase}/api/run/status?runId=${encodeURIComponent(runId)}`)
    } catch (e) {
      return { verdict: 'unavailable', detail: `轮询失败：${String(e).slice(0, 200)}` }
    }
    if (st.state === 'finished') break
  }
  if (st.state !== 'finished') return { verdict: 'unavailable', detail: `超时（${PER_RUN_TIMEOUT_MS}ms）run=${runId}` }

  const res = st.result ?? {}
  if (res.status === 'ok') return { verdict: 'pass', detail: `run=${runId}` }

  const err = String(res.error ?? '')
  // 依赖不可用 = 合法空窗（该日零销 / 天文件尚未封版）：记 skip，不判红（与 /opt 脚本退出码 3 同义）
  if (/lake_unavailable|query returned 0 records|依赖不可用/i.test(err)) {
    return { verdict: 'skip', detail: err.slice(0, 160) }
  }
  return { verdict: 'fail', detail: err.slice(0, 300) }
}

async function main() {
  if (!TOKEN) {
    console.error('RECON_MONTHLY_FAILED: DUCKLE_TOKEN 未注入')
    process.exit(2)
  }
  const { label, days } = previousMonth()
  const startedAt = Date.now()
  /** @type {{pass: any[], skip: any[], fail: any[], unavailable: any[]}} */
  const results = { pass: [], skip: [], fail: [], unavailable: [] }
  /** @type {Record<string, any[]>} */
  const buckets = results

  for (const { book, base } of CONSOLES) {
    for (const day of days) {
      const { verdict, detail } = await runOneDay(base, day)
      buckets[verdict].push({ book, day, detail })
      const tag = { pass: 'OK  ', skip: 'SKIP', fail: 'FAIL', unavailable: 'N/A ' }[verdict]
      console.log(`${tag} ${book} ${day}${verdict === 'pass' ? '' : ' ' + detail}`)
    }
  }

  const secs = Math.round((Date.now() - startedAt) / 1000)
  console.log(
    JSON.stringify({
      month: label,
      days: days.length,
      books: CONSOLES.length,
      checked: results.pass.length + results.skip.length + results.fail.length + results.unavailable.length,
      pass: results.pass.length,
      skip: results.skip.length,
      fail: results.fail.length,
      unavailable: results.unavailable.length,
      secs,
    }),
  )

  if (results.fail.length > 0) {
    const list = results.fail.map((x) => `${x.book}:${x.day}`).join(' ')
    console.log(`RECON_MONTHLY_FAILED month=${label} diff=${list}`)
    process.exit(1)
  }
  if (results.unavailable.length > 0) {
    const list = results.unavailable.map((x) => `${x.book}:${x.day}`).join(' ')
    console.log(`RECON_MONTHLY_UNAVAILABLE month=${label} list=${list}`)
    process.exit(2)
  }
  const skipList = results.skip.map((x) => `${x.book}:${x.day}`).join(' ') || 'none'
  console.log(`RECON_MONTHLY_OK month=${label} pass=${results.pass.length} skip=${skipList}`)
}

main().catch((e) => {
  console.error(`RECON_MONTHLY_FAILED: 未预期异常 ${String(e).slice(0, 300)}`)
  process.exit(2)
})
