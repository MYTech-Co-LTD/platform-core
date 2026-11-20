// probe-emit.mjs —— 判红结论投递到 OO `data_plane_probes`（桥 → 企微）的共用薄层（#2594）。
//
// 为什么需要它：`data-monitor` 的「告警单出口」要求数据面判据把**判红行**吐进 OO，
// 而不是依赖 openship job 通知（job 通知不进站内 deliveries feed，2026-11-07 实测 ⇒ 静默）。
// 已有 `scripts/lemeng/emit-probe.py`（宿主侧、读 /etc/openobserve-ingest.env），本模块是
// **应用单元/容器侧**的对应物：`OO_READ_TOKEN` 实测对 `data_plane_probes/_json` 也是 200
// （2026-11-20 实测），所以不需要给应用单元再加一份摄取凭据。
//
// 红线（与 emit-probe.py 一致）：
//   · **只投递事实**，不改判定、不改退出码——投递失败只打 stderr；
//   · 凭据只从 env 取，不落日志、不进 argv。

const STREAM = 'data_plane_probes'

/** OO 摄取三元组：优先只读三元组（应用单元），回落宿主命名（数据单元）。 */
export function ooEnv(env = process.env) {
  /** @param {string} a @param {string} b */
  const pick = (a, b) => {
    const v = String(env[a] ?? '').trim()
    return v !== '' ? v : String(env[b] ?? '').trim()
  }
  return {
    base: pick('OO_READ_URL', 'OO_BASE').replace(/\/+$/, ''),
    org: pick('OO_READ_ORG', 'OO_ORG'),
    token: pick('OO_READ_TOKEN', 'OO_AUTH'),
  }
}

/** 鉴权头：裸 base64 补 `Basic `；已带 Basic/Bearer 前缀原样用（与 verify-ingest 的 authHeader 一致）。 */
/** @param {string} token */
export function authHeader(token) {
  const t = String(token ?? '').trim()
  return /^(basic|bearer)\s/i.test(t) ? t : `Basic ${t}`
}

/**
 * 投一行探针事实。**永不抛**：调用方把它当「尽力而为」。
 *
 * @param {{check: string, verdict: 'OK'|'WARN'|'ERR'|'UNKNOWN', detail?: string, probe?: string, mode?: string}} row
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function emitProbe(row, opts = {}) {
  const env = opts.env ?? process.env
  const oo = ooEnv(env)
  if (oo.base === '' || oo.org === '' || oo.token === '') {
    return { ok: false, skipped: true, error: '缺 OO_BASE/OO_ORG/OO_AUTH（或 OO_READ_*）' }
  }
  const body = {
    probe: row.probe ?? 'verify',
    check: row.check,
    verdict: row.verdict,
    mode: row.mode ?? 'advisory',
    detail: String(row.detail ?? '').slice(0, 500),
  }
  try {
    const fetchImpl = opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${oo.base}/api/${oo.org}/${STREAM}/_json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader(oo.token) },
      body: JSON.stringify(body),
    })
    const text = await res.text().catch(() => '')
    // 本 OO 构建的成功回执形如 {"code":200,"status":[{"successful":1,...}]}
    const ok = res.status === 200 && text.includes('"successful":1')
    return ok ? { ok: true } : { ok: false, error: `HTTP ${res.status} ${text.slice(0, 120)}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 便捷：把一次「跑不成」投成判红行。**不改调用方的返回码**，只打一行 stderr 留痕。
 *
 * @param {string} check
 * @param {string} detail
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch}} [opts]
 */
export async function emitFailure(check, detail, opts = {}) {
  const r = await emitProbe({ check, verdict: 'ERR', detail }, opts)
  if (!r.ok) {
    console.error(`probe-emit: 判红行未投递（${check}）：${r.error ?? 'unknown'}`)
  }
  return r
}
