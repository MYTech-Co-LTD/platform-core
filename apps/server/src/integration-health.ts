// integration-health.ts — 集成活性判据（**纯函数**；spec 2026-10-31-integration-health-design.md）。
//
// 存在理由：出站集成最致命的失效是「该来的没来」——没有调用方 ⇒ 永不失败 ⇒ 永不告警。
// 2026 年 woke 的 suite_ticket 就这样静默死了两个月。这里把「凭什么判它活着」抽成**可以穷举
// 单测**的判定，探针 job / 读面 / 控制台共用这一份口径（绝不在 UI 或 SQL 里重写判据）。
//
// 三态**必须分离**（spec §2.1）：
//   · `OK`            —— 有活着证据，且未过 SLA；
//   · `STALE`         —— 查得到证据，但太久没更新（或从来没有） ⇒ 集成真的停了；
//   · `PROBE_FAILED`  —— **探针自己没跑通** ⇒ 我们不知道它活没活。
// 把后两者混成一个码，排障会从「去查集成」错到「去查部署」，反之亦然。
// 另加 `DISABLED`：登记了但停用（不监控）——它是**行状态**，不是健康结论，故单列而不混进三态。
import type { Pool } from 'pg'

export type IntegrationKind = 'callback' | 'token' | 'channel'

export type IntegrationVerdict = 'OK' | 'STALE' | 'PROBE_FAILED' | 'DISABLED'

/** `platform.integration` 的一行（时间统一 ISO UTC 字符串——落库是 timestamptz）。 */
export interface IntegrationRow {
  id: string
  /** 租户维度；空串 = 与租户无关的集成 */
  org: string
  kind: IntegrationKind
  /** 判据来源（探针 job 解释，如 `token:wecom-suite`）；本层不解释它 */
  source: string
  slaSeconds: number
  enabled: boolean
  /** 最近一次「活着」的证据时间；`null` = 从接入起就没活过（**按超期算**） */
  lastOkAt: string | null
  lastProbeAt: string | null
  lastError: string | null
  note: string | null
  /**
   * 上一轮判定结论（Phase 2b 告警用）：**进入 STALE**（上次 ≠ STALE）才装填告警，
   * 持续 STALE 不重复轰炸。`null` = 还没探测过。
   */
  lastVerdict: string | null
  /** 告警装填位：`false` = STALE 已装填、等 notify worker 消费；详见迁移 015。 */
  staleNotified: boolean
}

/** 一次探针的结果（Phase 2 由探针 job 产生；Phase 1 读面里恒为 null）。 */
export interface ProbeOutcome {
  ok: boolean
  at: string
  error?: string
}

export interface IntegrationHealth {
  verdict: IntegrationVerdict
  /** 距最近一次活着证据的秒数；`null` = 从来没有过证据 */
  ageSeconds: number | null
  /** 人话原因（读面与控制台直接展示，不再二次翻译） */
  reason: string
}

/**
 * 判定（纯函数）。
 *
 * 优先级（不可调换）：
 *   ① 停用 ⇒ `DISABLED`（不监控，也不要在控制台里冒充健康）；
 *   ② 探针本身失败 ⇒ `PROBE_FAILED`（**未知**，不是「坏了」也不是「好的」）；
 *   ③ 从没有过证据，或证据超过 SLA ⇒ `STALE`；
 *   ④ 其余 ⇒ `OK`。
 *
 * 边界：`age === sla` 判 **OK**（「还没过期」），`age > sla` 才 STALE——SLA 是允许的最大静默时长。
 */
export function judgeIntegration(
  row: Pick<IntegrationRow, 'slaSeconds' | 'enabled' | 'lastOkAt'>,
  probe: ProbeOutcome | null,
  now: Date,
): IntegrationHealth {
  if (!row.enabled) return { verdict: 'DISABLED', ageSeconds: null, reason: '已停用，不监控' }

  if (probe !== null && !probe.ok) {
    return {
      verdict: 'PROBE_FAILED',
      ageSeconds: null,
      reason: `探针执行失败：${probe.error ?? '未知原因'}`,
    }
  }

  // 探针成功时它的时间戳本身也是「活着」的证据（比 lastOkAt 更新时以它为准）
  const evidence = latest(
    row.lastOkAt === null ? null : Date.parse(row.lastOkAt),
    probe !== null && probe.ok ? Date.parse(probe.at) : null,
  )
  if (evidence === null || Number.isNaN(evidence)) {
    return {
      verdict: 'STALE',
      ageSeconds: null,
      reason: '从来没有收到过活性证据（从接入那一刻起就算超期）',
    }
  }

  const ageSeconds = Math.max(0, Math.floor((now.getTime() - evidence) / 1000))
  if (ageSeconds > row.slaSeconds) {
    return {
      verdict: 'STALE',
      ageSeconds,
      reason: `已 ${humanAge(ageSeconds)} 没有活性证据（SLA ${humanAge(row.slaSeconds)}）`,
    }
  }
  return { verdict: 'OK', ageSeconds, reason: `最近活性证据在 ${humanAge(ageSeconds)} 前` }
}

function latest(...ts: Array<number | null>): number | null {
  let out: number | null = null
  for (const t of ts) {
    if (t === null || Number.isNaN(t)) continue
    if (out === null || t > out) out = t
  }
  return out
}

/** 秒 → 「3 天 2 小时」这类人话（控制台直接显示，避免前端各写一套）。 */
export function humanAge(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} 小时`
  return `${Math.floor(h / 24)} 天`
}

/** 读面一行（控制台消费）：登记信息 + 判定结论。 */
export interface IntegrationView extends IntegrationRow {
  health: IntegrationHealth
}

/** 列表（读面用）。按「最该看的排最前」：STALE > PROBE_FAILED > OK > DISABLED，同级按年龄降序。 */
export async function listIntegrationViews(
  pool: Pool, now: Date = new Date(),
): Promise<IntegrationView[]> {
  const { rows } = await pool.query(
    `select id, org, kind, source, sla_seconds, enabled, last_ok_at, last_probe_at, last_error, note,
            last_verdict, stale_notified
       from platform.integration
      order by enabled desc, last_ok_at nulls first, id`,
  )
  const views = rows.map((r) => {
    const row: IntegrationRow = {
      id: r.id as string,
      org: r.org as string,
      kind: r.kind as IntegrationKind,
      source: r.source as string,
      slaSeconds: Number(r.sla_seconds),
      lastVerdict: (r.last_verdict as string | null) ?? null,
      staleNotified: (r.stale_notified as boolean | undefined) ?? true,
      enabled: r.enabled as boolean,
      lastOkAt: r.last_ok_at === null ? null : new Date(r.last_ok_at as Date).toISOString(),
      lastProbeAt: r.last_probe_at === null ? null : new Date(r.last_probe_at as Date).toISOString(),
      lastError: r.last_error as string | null,
      note: r.note as string | null,
    }
    return { ...row, health: judgeIntegration(row, null, now) }
  })
  const rank: Record<IntegrationVerdict, number> = { STALE: 0, PROBE_FAILED: 1, OK: 2, DISABLED: 3 }
  return views.sort((a, b) =>
    rank[a.health.verdict] - rank[b.health.verdict]
    || (b.health.ageSeconds ?? Number.MAX_SAFE_INTEGER) - (a.health.ageSeconds ?? Number.MAX_SAFE_INTEGER))
}

/**
 * 探针心跳判定（spec §2.4 元级看门狗；纯函数）。
 *
 * 为什么单独判定而不是复用 `judgeIntegration`：这里问的是**另一件事**——
 * 「探针这个循环还在转吗」，不是「某个集成还活着吗」。混用会把「探针挂了」误报成
 * 「所有集成同时挂了」，排障方向直接跑偏。
 *
 * 阈值 = `max(2 × 周期, 5 分钟)`：2× 周期是 spec 的写法，5 分钟下限避免周期配得过小
 * （如 60s ⇒ 2 分钟）时被正常的调度抖动误伤。
 */
export type ProbeHeartbeatVerdict = 'OK' | 'STALE' | 'DISABLED' | 'NEVER'

export function judgeProbeHeartbeat(
  row: { beatAt: string; enabled: boolean; intervalMs: number } | null,
  now: Date,
): { verdict: ProbeHeartbeatVerdict; ageSeconds: number | null; reason: string } {
  if (row === null) {
    return { verdict: 'NEVER', ageSeconds: null, reason: '探针从未运行过（没有心跳行）' }
  }
  if (!row.enabled) {
    return { verdict: 'DISABLED', ageSeconds: null, reason: '本实例未启用探针（INTEGRATION_PROBE_INTERVAL_MS=0）' }
  }
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(row.beatAt)) / 1000))
  const limit = Math.max(2 * row.intervalMs, 300_000) / 1000
  if (ageSeconds > limit) {
    return {
      verdict: 'STALE',
      ageSeconds,
      reason: `探针 ${humanAge(ageSeconds)} 没跳了（周期 ${humanAge(row.intervalMs / 1000)}，阈值 ${humanAge(limit)}）`,
    }
  }
  return { verdict: 'OK', ageSeconds, reason: `探针正常，最近一跳在 ${humanAge(ageSeconds)} 前` }
}
