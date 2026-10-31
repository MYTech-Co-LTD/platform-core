// channel-probe.ts — 直连渠道的活性证据（spec 2026-10-31-multi-channel-im-provider-design.md §3.4）。
//
// 为什么证据由**本模块**产出：取 token 需要凭据，凭据在本模块的加密表里（`notify.channel_credential`）；
// 集成探针跑在宿主 server 里，而宿主**不许读 notify schema**（B1）。于是把「探」这件事留在模块内，
// 把**结论**落 `notify.channel_probe`，宿主侧的 registry 用 `sql:` 判据读结论
// （与 `notify-worker-heartbeat` 读 `notify.worker_heartbeat` 同一先例）。
//
// 三条判断：
//   ① **探 = gettoken，不发消息**：企微取 token 是幂等、无副作用、不打扰任何人的调用，
//      它能覆盖「secret 被改 / 应用被停用 / 出口 IP 未被信任 / 企业被解散」这四类最常见的失效。
//   ② **失败不倒退 `last_ok_at`**：判据问的是「多久没有活着的证据」，把 last_ok_at 清空会让
//      「沉默 3 天」变成「沉默 0 秒后马上失败」，两种信息都要保留（失败看 `last_error`）。
//   ③ **探针自己坏了 ≠ 渠道坏了**：resolve 报 `missing`（没配直连）时不写失败——那是**没有通道**，
//      不是**通道坏了**；写失败会让「压根没启用直连」的实例天天红。只有「配了但取不到 token」才落错误。
import type { Pool } from 'pg'
import { resolveWecomCredential } from './credential-store'
import { probeDirect } from './im/wecom-direct'

/** 同一 (org, provider) 两次真探的最小间隔（秒）；worker 每 2s 转一圈，这个值决定真实探测频率。 */
export const MIN_PROBE_INTERVAL_SECONDS = 300

export interface ProbeSummary {
  /** 本轮真去探的通道数 */
  probed: number
  ok: string[]
  failed: string[]
  /** 未探（未到间隔 / 非直连 / 未配置凭据） */
  skipped: number
}

interface ProbeDep {
  pool: Pool
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => Date
  /** 测试注入：绕过最小间隔（生产不传） */
  minIntervalSeconds?: number
}

/**
 * 对所有 `transport: 'direct'` 且启用的渠道探一次活性。
 *
 * 只认 `wecom_chat`：它是当前唯一的直连 provider。别的 provider 加直连时**在这里加分支**，
 * 而不是把「企微」写进通用路径——那会让新增 provider 的人以为不用改任何地方。
 */
export async function probeDirectChannels(dep: ProbeDep): Promise<ProbeSummary> {
  const { pool } = dep
  const now = dep.now ?? (() => new Date())
  const minInterval = dep.minIntervalSeconds ?? MIN_PROBE_INTERVAL_SECONDS
  const summary: ProbeSummary = { probed: 0, ok: [], failed: [], skipped: 0 }

  const { rows } = await pool.query(
    `select c.org, c.provider
       from notify.channel c
       left join notify.channel_probe p on p.org = c.org and p.provider = c.provider
      where c.enabled
        and c.config->>'transport' = 'direct'
        and (p.checked_at is null or p.checked_at < now() - ($1::int * interval '1 second'))
      order by c.org, c.provider`,
    [minInterval],
  )

  for (const r of rows as Array<{ org: string; provider: string }>) {
    const key = `${r.org}/${r.provider}`
    if (r.provider !== 'wecom_chat') {
      // 没有探法的 provider 不写假 OK（那会造出「有人测过」的错觉）
      summary.skipped += 1
      continue
    }
    const cred = await resolveWecomCredential(pool, r.org, dep.env ?? process.env)
    if (!cred.ok && cred.reason === 'missing') {
      // 没配直连凭据 ⇒ 不是「渠道坏了」，是「还没接」；不落错误（见头注 ③）
      summary.skipped += 1
      continue
    }

    summary.probed += 1
    const at = now().toISOString()
    if (!cred.ok) {
      // 配了凭据但读不出来（KEK 缺/不对、密文坏）——这本身就是必须看见的故障
      const err = `credential_${cred.reason}${cred.detail ? `: ${cred.detail}` : ''}`
      await recordProbe(pool, r.org, r.provider, at, null, err)
      summary.failed.push(`${key} (${err})`)
      continue
    }

    const p = await probeDirect(cred.cred, { fetchImpl: dep.fetchImpl })
    if (p.ok) {
      await recordProbe(pool, r.org, r.provider, at, at, null)
      summary.ok.push(key)
    } else {
      await recordProbe(pool, r.org, r.provider, at, null, p.detail ?? 'probe failed')
      summary.failed.push(`${key} (${p.detail ?? 'probe failed'})`)
    }
  }
  return summary
}

async function recordProbe(
  pool: Pool, org: string, provider: string,
  checkedAt: string, okAt: string | null, error: string | null,
): Promise<void> {
  await pool.query(
    `insert into notify.channel_probe(org, provider, checked_at, last_ok_at, last_error)
     values ($1,$2,$3,$4,$5)
     on conflict (org, provider) do update
       set checked_at = excluded.checked_at,
           -- 失败不倒退既有证据（头注 ②）
           last_ok_at = coalesce(excluded.last_ok_at, notify.channel_probe.last_ok_at),
           last_error = excluded.last_error`,
    [org, provider, checkedAt, okAt, error],
  )
}
