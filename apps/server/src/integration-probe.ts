// integration-probe.ts — 集成探针的执行编排（spec 2026-10-31-integration-health-design.md §2.2/§2.3）。
//
// 判据是纯函数（integration-health.ts），**这里只负责取证据**：按 `source` 的语法去问一个
// 具体的问题，把「活着的证据时间」写回 `platform.integration`。
//
// 三种 kind 的 source 语法（首版；新增形态必须同时改本文件与 registry 校验）：
//   · `sql:<query>`             —— 查「最后一次收到 X 的时间」（epoch 秒或 timestamptz 单值列）。
//                                  查回 NULL **不是探针失败**：这只说明「确实没动静」，
//                                  交给判据落 STALE（探针失败是另一码事，见 §2.1）。
//   · `http-healthz:<ENV_KEY>`  —— 取该 env 键的 base URL，GET `<origin>/healthz`，200 视为活着。
//                                  env 缺失 ⇒ 探针失败并**点名缺哪个键**（空壳通道就是这么暴露的）。
//   · `casdoor:get-user:<name>` —— 主动取一次用户（幂等、无副作用）⇒ 覆盖「没人调用、凭据已死」。
//
// IO 全部注入（pool / fetch / casdoorGetUser / env / now）：本文件可穷举单测，不起真连接。
import type { Pool } from 'pg'
import { judgeIntegration, type IntegrationKind, type IntegrationRow, type ProbeOutcome } from './integration-health'

export interface RegistryEntry {
  id: string
  /** 租户维度（Casdoor org）；空串 = 与租户无关 */
  org: string
  kind: IntegrationKind
  source: string
  slaSeconds: number
  note?: string
}

export interface ProbeDeps {
  pool: Pool
  env: NodeJS.ProcessEnv
  fetchImpl: typeof fetch
  /** Casdoor 单用户读（幂等）：按 org + 用户名，返回 null = 账号不存在 */
  casdoorGetUser: (org: string, name: string) => Promise<unknown | null>
  now: () => Date
}

export interface ProbeReport {
  /** 本轮实际探测的集成数（未到探测间隔的不算） */
  probed: number
  /** 探测后判为 STALE 的 id（Phase 2b 的告警就消费这个集合） */
  stale: string[]
  /** 探测本身失败的 id ⇒ PROBE_FAILED */
  probeFailed: string[]
  /** 判为 OK 的 id */
  ok: string[]
}

/**
 * 解析并校验 registry。**启动即 fail-fast**：写错一个 `kind`/`source` 应该立刻报错，
 * 而不是悄悄变成「永远探不到」——那正是本设计要消灭的静默。
 */
export function parseRegistry(raw: unknown): RegistryEntry[] {
  if (typeof raw !== 'object' || raw === null) throw new Error('integration-registry: 顶层必须是对象')
  const list = (raw as { integrations?: unknown }).integrations
  if (!Array.isArray(list)) throw new Error('integration-registry: integrations 必须是数组')
  const seen = new Set<string>()
  return list.map((item, i) => {
    const at = `integrations[${i}]`
    if (typeof item !== 'object' || item === null) throw new Error(`${at}: 必须是对象`)
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    if (id === '') throw new Error(`${at}: id 必填`)
    if (seen.has(id)) throw new Error(`${at}: id 重复（${id}）`)
    seen.add(id)
    const kind = o.kind
    if (kind !== 'callback' && kind !== 'token' && kind !== 'channel') {
      throw new Error(`${at}: kind 必须是 callback/token/channel，实际 ${String(kind)}`)
    }
    const source = typeof o.source === 'string' ? o.source.trim() : ''
    if (!/^(sql|http-healthz|casdoor):.+/.test(source)) {
      throw new Error(`${at}: source 必须以 sql:/http-healthz:/casdoor: 开头，实际 ${String(o.source)}`)
    }
    const sla = Number(o.slaSeconds)
    if (!Number.isInteger(sla) || sla <= 0) throw new Error(`${at}: slaSeconds 必须是正整数`)
    const org = typeof o.org === 'string' ? o.org : ''
    return {
      id, org, kind, source, slaSeconds: sla,
      note: typeof o.note === 'string' ? o.note : undefined,
    }
  })
}

/**
 * 探测间隔（由 SLA 推出来，不另设字段）：
 * 取 `SLA/4` 并夹在 [60s, 3600s]。理由：SLA 是最长允许静默，四分之一周期能在超期后一个区间内
 * 发现；token/channel 类 SLA 是「天」级，夹到 1 小时避免天天白跑 Casdoor。
 */
export function probeEverySeconds(slaSeconds: number): number {
  return Math.min(Math.max(Math.floor(slaSeconds / 4), 60), 3600)
}

/** 跑一次证据采集（不发告警；告警在 Phase 2b）。 */
export async function runProbes(deps: ProbeDeps, registry: RegistryEntry[]): Promise<ProbeReport> {
  const now = deps.now()
  await upsertRegistry(deps.pool, registry)

  const { rows } = await deps.pool.query(
    `select id, org, kind, source, sla_seconds, enabled, last_ok_at, last_probe_at, last_error, note
       from platform.integration`,
  )
  const report: ProbeReport = { probed: 0, stale: [], probeFailed: [], ok: [] }

  for (const r of rows) {
    const row = toRow(r)
    if (!row.enabled) continue
    // 未到探测间隔 ⇒ 跳过（但判定照样算一次，让读面/告警拿到最新结论）
    const due = row.lastProbeAt === null
      || now.getTime() - Date.parse(row.lastProbeAt) >= probeEverySeconds(row.slaSeconds) * 1000
    if (!due) continue

    const probe = await takeEvidence(deps, row.source, row.org, now)
    report.probed += 1
    await deps.pool.query(
      `update platform.integration
          set last_probe_at = $3,
              last_ok_at = coalesce($4, last_ok_at),
              last_error = $5,
              updated_at = now()
        where id = $1 and org = $2`,
      [row.id, row.org, now.toISOString(),
        probe.ok && probe.evidenceAt !== undefined ? probe.evidenceAt : null,
        probe.ok ? null : (probe.error ?? 'probe failed')],
    )

    // 判定用「刚写回的新证据」——不能拿旧行判（那会慢一整个周期）
    const judged: IntegrationRow = {
      ...row,
      lastProbeAt: now.toISOString(),
      lastOkAt: probe.ok && probe.evidenceAt !== undefined ? probe.evidenceAt : row.lastOkAt,
    }
    const outcome: ProbeOutcome | null = probe.ok ? null : { ok: false, at: now.toISOString(), error: probe.error }
    const h = judgeIntegration(judged, outcome, now)
    if (h.verdict === 'STALE') report.stale.push(row.id)
    else if (h.verdict === 'PROBE_FAILED') report.probeFailed.push(row.id)
    else if (h.verdict === 'OK') report.ok.push(row.id)
  }
  return report
}

interface Evidence {
  ok: boolean
  /** 「活着的证据」的时间（ISO）。sql 源查回 NULL ⇒ 不设（≠ 探针失败） */
  evidenceAt?: string
  error?: string
}

async function takeEvidence(deps: ProbeDeps, source: string, rowOrg: string, now: Date): Promise<Evidence> {
  const [scheme, ...rest] = source.split(':')
  const arg = rest.join(':')
  try {
    if (scheme === 'sql') {
      const r = await deps.pool.query(arg)
      const v = r.rows[0] === undefined ? null : Object.values(r.rows[0] as Record<string, unknown>)[0]
      if (v === null || v === undefined) return { ok: true }          // 查得到、但确实没动静
      const at = toIso(v)
      return at === null ? { ok: false, error: `sql 返回值无法解析为时间：${String(v)}` } : { ok: true, evidenceAt: at }
    }
    if (scheme === 'http-healthz') {
      const base = deps.env[arg]
      if (!base) return { ok: false, error: `env ${arg} 未配置` }
      const url = new URL('/healthz', base).toString()
      const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(5000) })
      return res.status === 200
        ? { ok: true, evidenceAt: now.toISOString() }
        : { ok: false, error: `healthz HTTP ${res.status}` }
    }
    if (scheme === 'casdoor') {
      const name = arg.replace(/^get-user:/, '')
      // 租户从条目取；条目没写就用本实例的 PLATFORM_ORG（single 模式下它就是唯一租户）。
      // 两者都空 ⇒ 探针失败并说清楚缺什么（而不是悄悄对空 org 发请求）。
      const org = rowOrg !== '' ? rowOrg : String(deps.env.PLATFORM_ORG ?? '')
      if (org === '') {
        return { ok: false, error: 'casdoor 源缺 org：registry 条目请给 org，或配置 PLATFORM_ORG' }
      }
      const u = await deps.casdoorGetUser(org, name)
      return u === null
        ? { ok: false, error: `Casdoor 查无用户 ${name}（凭据/账号可能已失效）` }
        : { ok: true, evidenceAt: now.toISOString() }
    }
    return { ok: false, error: `未知 source 形态：${source}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 注册表 → 表（**只写形状**：enabled / last_ok_at 等运行态一律不动，重启不洗掉历史）。 */
async function upsertRegistry(pool: Pool, registry: RegistryEntry[]): Promise<void> {
  for (const e of registry) {
    await pool.query(
      `insert into platform.integration(id, org, kind, source, sla_seconds, note)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id, org) do update
         set kind = excluded.kind, source = excluded.source,
             sla_seconds = excluded.sla_seconds, note = excluded.note, updated_at = now()`,
      [e.id, e.org, e.kind, e.source, e.slaSeconds, e.note ?? null],
    )
  }
}

function toRow(r: Record<string, unknown>): IntegrationRow {
  const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString())
  return {
    id: r.id as string,
    org: r.org as string,
    kind: r.kind as IntegrationKind,
    source: r.source as string,
    slaSeconds: Number(r.sla_seconds),
    enabled: r.enabled as boolean,
    lastOkAt: iso(r.last_ok_at),
    lastProbeAt: iso(r.last_probe_at),
    lastError: (r.last_error as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  }
}

/** sql 源可能回 epoch 秒（number/字符串数字）或 timestamptz（Date/ISO 串）。 */
function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v * 1000).toISOString() : null
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v)) return new Date(Number(v) * 1000).toISOString()
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  return null
}

/**
 * 常驻探测循环（spec §2.3：并入 server 进程，**不与 notify-worker 同容器**）。
 *
 * 为什么放 server 而不是 worker：worker 自己就是被监控对象之一（心跳集成）——
 * 把探针放进 worker 就等于「守夜人睡在被守的人床上」，它一死，连「它死了」这条也发不出来。
 *
 * `intervalMs <= 0` ⇒ 不启动（测试与本地默认关；生产走 env `INTEGRATION_PROBE_INTERVAL_MS`）。
 * 每轮前抢一把 advisory 锁：多副本时只有一个实例真去探（探针有外部副作用：打 Casdoor/bridge）。
 */
export function startIntegrationProbeLoop(opts: {
  pool: Pool
  intervalMs: number
  registryPath: string
  casdoorGetUser: (org: string, name: string) => Promise<unknown | null>
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  onError?: (e: unknown) => void
}): { stop(): void } {
  if (opts.intervalMs <= 0) return { stop() {} }
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const lock = await opts.pool.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('platform.integration_probe')) as ok",
      )
      if (lock.rows[0]?.ok !== true) return
      try {
        const { readFile } = await import('node:fs/promises')
        const raw = JSON.parse(await readFile(opts.registryPath, 'utf8'))
        await runProbes({
          pool: opts.pool,
          env,
          fetchImpl,
          casdoorGetUser: opts.casdoorGetUser,
          now: () => new Date(),
        }, parseRegistry(raw))
      } finally {
        await opts.pool.query("select pg_advisory_unlock(hashtext('platform.integration_probe'))")
      }
    } catch (e) {
      // 探针自己的失败不能拖垮 server（也不静默：交给 onError 打日志）
      opts.onError?.(e)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { void tick() }, opts.intervalMs)
  timer.unref?.()
  return { stop() { clearInterval(timer) } }
}
