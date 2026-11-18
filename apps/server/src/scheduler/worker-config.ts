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
  return {
    // ⚠️ 变异靶点：这里改成恒 true，`SCHEDULER_ENABLED=0` 的用例必须失败。
    enabled: env.SCHEDULER_ENABLED !== '0',
    tickMs: positiveInt(env.SCHEDULER_TICK_MS, 30000, 'SCHEDULER_TICK_MS'),
    maxConcurrency: positiveInt(env.SCHEDULER_MAX_CONCURRENCY, 2, 'SCHEDULER_MAX_CONCURRENCY'),
    healthPort: positiveInt(
      env.SCHEDULER_HEALTH_PORT || env.WORKER_HEALTH_PORT || env.PORT,
      13000,
      '健康端点端口',
    ),
  }
}

/**
 * 是否到了下一拍。`lastMs = 0`（从未跑过）⇒ 首次调用即跑。
 * 边界：差值 **小于** `tickMs` 不跑，**等于**跑。
 */
export function shouldRunTick(nowMs: number, lastMs: number, tickMs: number): boolean {
  return nowMs - lastMs >= tickMs
}
