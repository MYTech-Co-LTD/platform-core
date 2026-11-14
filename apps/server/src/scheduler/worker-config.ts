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
