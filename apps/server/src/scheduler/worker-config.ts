import { JOB_SCOPES, type JobDef, type JobScope } from './registry'

// worker-config.ts — worker 调度接线的**纯配置/节拍判定**（不碰 HTTP、不碰库）。
//
// 为什么抽出来：`scripts/notify-worker.mjs` 里的 `SCHEDULER_ENABLED` 闸门与端口回退
// 是「env → 行为」的接线，留在脚本里只能靠真起进程测（变异实验证明写过也测不到）。
// 抽成纯函数后可以逐条变异验证：把 enabled 闸门改成恒 true，下面的用例必须变红。

/** worker 调度接线配置（`--once` 的抑制在脚本侧叠加，不在这里）。 */
export interface SchedulerConfig {
  /** 调度 loop 开关；`SCHEDULER_ENABLED='0'` 才关，其余（含未设/空串）默认开。 */
  enabled: boolean
  /** 一拍间隔（毫秒）。正整数；未设/空串取缺省 30000。 */
  tickMs: number
  /** 同时在跑的子进程上限。正整数；未设/空串取缺省 2。 */
  maxConcurrency: number
  /**
   * `/healthz` 端口：`SCHEDULER_HEALTH_PORT` → `WORKER_HEALTH_PORT` → `PORT` → 13000。
   * **空串按未设处理**（`??` 会把 `.env` 里的 `KEY=` 当已设，而 `Number('') === 0`
   * ⇒ 绑随机端口、与镜像 HEALTHCHECK 脱钩）。
   */
  healthPort: number
  /**
   * 本进程负责的作业域（#2511 拆分）：`SCHEDULER_JOB_GROUPS=platform|data|platform,data`。
   * 缺省 `platform,data` = 拆分前的单进程行为（两边都 claim）。
   * **未知名一律抛错**：拼错的域名会让整个单元静默不 claim 任何作业。
   */
  groups: JobScope[]
  /**
   * 本进程的**实例标识**（写进 `job_run.runner_id`、`job_heartbeat.id`）。
   * 缺省由 groups 派生：单域 ⇒ `scheduler-<域>`（应用/数据单元各自固定），双域 ⇒ `scheduler`。
   * ⚠️ 必须**跨重启稳定**：启动对账只收「与我自己同 id 的 running 行」，
   *    随机 id 会让上一轮的僵尸行永远收不掉（要等 2×timeout 的 reapStale）。
   */
  instanceId: string
}

/**
 * 解析正整数 env。**空串/未设 = 缺省**（模板里的 `KEY=` 是「未配置」的写法），
 * 显式非法值（`'0'` / `'abc'` / 负数 / 小数）一律抛：静默停调度比启动失败更糟。
 */
function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} 必须是正整数（当前 ${JSON.stringify(raw)}）`)
  }
  return n
}

/**
 * 投递 loop 开关（角色拆分，#2504）：`NOTIFY_DELIVERY_ENABLED='0'` 才关，其余默认开。
 *
 * 为什么与 `SCHEDULER_ENABLED` 分开：两者必须能**各自独立**设置——调度搬进数据单元后，
 * 应用单元的进程要 `SCHEDULER_ENABLED=0`（投递照跑），数据单元的进程要
 * `NOTIFY_DELIVERY_ENABLED=0`（调度照跑）。合成一个开关就表达不出这两台机器。
 *
 * ⚠️ 变异靶点：改成恒 true ⇒ `worker-wiring.test.ts` 的「'0' ⇒ 关」用例必须失败。
 */
export function parseDeliveryEnabled(env: Record<string, string | undefined>): boolean {
  return env.NOTIFY_DELIVERY_ENABLED !== '0'
}

/**
 * 角色装配闸门（#2504）：两个 loop 都关（或 `--once` 与「关投递」同时出现）时，
 * 进程**响亮失败**，而不是起来空转。
 *
 * 为什么是纯函数：`scripts/notify-worker.mjs` 的这两条 `process.exit(2)` 埋在脚本里，
 * 只有真起进程才测得到；抽出来之后 `worker-wiring.test.ts` 能直接钉住文案与判据。
 * **变异靶点**：去掉任一分支 ⇒ 对应用例必须失败。
 */
export interface WorkerRoleInput {
  /** 是否 `--once`（跑一轮投递即退出）。 */
  once: boolean
  /** `NOTIFY_DELIVERY_ENABLED !== '0'`。 */
  deliveryEnabled: boolean
  /** 调度 loop 是否真的会跑（已叠加 `--once` 的抑制，即 `!once && SCHEDULER_ENABLED`）。 */
  schedulerEnabled: boolean
}

export type WorkerRoleDecision = { ok: true } | { ok: false; error: string }

export function resolveWorkerRole(input: WorkerRoleInput): WorkerRoleDecision {
  // `--once` 的语义就是「跑一轮**投递**就退出」；投递关掉时它无事可做 ⇒ 不能静默成功
  // （运维脚本按退出码判绿）。
  if (input.once && !input.deliveryEnabled) {
    return { ok: false, error: '--once 与 NOTIFY_DELIVERY_ENABLED=0 互斥（--once 只跑投递）' }
  }
  if (!input.deliveryEnabled && !input.schedulerEnabled) {
    return {
      ok: false,
      error: '投递与调度 loop 都被关闭 —— 本进程无事可做（检查 SCHEDULER_ENABLED / NOTIFY_DELIVERY_ENABLED）',
    }
  }
  return { ok: true }
}

export function parseSchedulerConfig(env: Record<string, string | undefined>): SchedulerConfig {
  // ⚠️ 变异靶点：这里改成恒 true，`SCHEDULER_ENABLED=0` 的用例必须失败。
  const enabled = env.SCHEDULER_ENABLED !== '0'
  const groups = parseJobGroups(env.SCHEDULER_JOB_GROUPS)
  return {
    enabled,
    tickMs: positiveInt(env.SCHEDULER_TICK_MS, 30000, 'SCHEDULER_TICK_MS'),
    maxConcurrency: positiveInt(env.SCHEDULER_MAX_CONCURRENCY, 2, 'SCHEDULER_MAX_CONCURRENCY'),
    healthPort: positiveInt(
      env.SCHEDULER_HEALTH_PORT || env.WORKER_HEALTH_PORT || env.PORT,
      13000,
      '健康端点端口',
    ),
    groups,
    instanceId: env.SCHEDULER_INSTANCE_ID || defaultInstanceId(groups),
  }
}

/**
 * `SCHEDULER_JOB_GROUPS` → 域列表。缺省/空串 = 两个域都要（拆分前行为）。
 * 未知名抛错而不是忽略：`dataa` 这种手滑会让单元**一条作业都不 claim**，且表面上一切正常。
 */
export function parseJobGroups(raw: string | undefined): JobScope[] {
  if (raw === undefined || raw.trim() === '') return [...JOB_SCOPES]
  const picked = raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (picked.length === 0) throw new Error('SCHEDULER_JOB_GROUPS 为空——要么不设，要么给 platform/data')
  const seen = new Set<string>()
  for (const g of picked) {
    if (!(JOB_SCOPES as readonly string[]).includes(g)) {
      throw new Error(`SCHEDULER_JOB_GROUPS 含未知域 ${JSON.stringify(g)}（合法值 ${JOB_SCOPES.join('/')}）`)
    }
    seen.add(g)
  }
  // 顺序按 JOB_SCOPES 归一（'data,platform' 与 'platform,data' 等价 ⇒ instanceId 也稳定）。
  return JOB_SCOPES.filter((g) => seen.has(g))
}

/** 单域 ⇒ `scheduler-<域>`；双域（未拆缝）⇒ 沿用旧 id `scheduler`，与历史台账连续。 */
function defaultInstanceId(groups: readonly JobScope[]): string {
  return groups.length === 1 ? `scheduler-${groups[0]}` : 'scheduler'
}

/**
 * 只保留本进程负责的域；`requiresEnv` 缺键的作业被剔除并单独返回（供健康面报红）。
 * 缺键作业**不进 claim 集合**：让它跑起来只会得到一条必然失败的台账行，
 * 而且会消耗这一格的 occurrence（`cron` 错过不补）。
 */
export function selectRunnableJobs(
  registry: readonly JobDef[],
  groups: readonly JobScope[],
  env: Record<string, string | undefined>,
): { runnable: JobDef[]; blocked: Array<{ key: string; missing: string[] }> } {
  const inGroup = registry.filter((d) => groups.includes(d.scope))
  const runnable: JobDef[] = []
  const blocked: Array<{ key: string; missing: string[] }> = []
  for (const d of inGroup) {
    const missing = (d.requiresEnv ?? []).filter((k) => {
      const v = env[k]
      return v === undefined || v === ''
    })
    if (missing.length > 0) blocked.push({ key: d.key, missing })
    else runnable.push(d)
  }
  return { runnable, blocked }
}

/**
 * 是否到了下一拍。`lastMs = 0`（从未跑过）⇒ 首次调用即跑。
 * 边界：差值 **小于** `tickMs` 不跑，**等于**跑。
 */
export function shouldRunTick(nowMs: number, lastMs: number, tickMs: number): boolean {
  return nowMs - lastMs >= tickMs
}
