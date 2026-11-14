// worker-healthz.ts — worker `/healthz` 的**纯判定**（不碰 HTTP、不碰库）。
//
// 为什么单独抽出来：worker 是「投递 loop + 调度 loop」同进程（Wave 6 P1），
// 健康判定要把两份心跳合并成一条 200/503。把判定留在 `scripts/notify-worker.mjs`
// 的请求回调里就只能靠起 HTTP + 真库去测；抽成纯函数后，开关语义（尤其
// `SCHEDULER_ENABLED=0`）可以直接用桩覆盖。
//
// 判定表（`notifyFresh` = `notify.worker_heartbeat` 2 分钟内有过跳动）：
//
// | notifyFresh | schedulerEnabled | jobHealth.ok | 结果 |
// |-------------|------------------|--------------|------|
// | true        | false            | 任意/缺省     | 200  |
// | false       | false            | 任意/缺省     | 503（只报投递心跳，**不因调度红**） |
// | true        | true             | true         | 200  |
// | true        | true             | false        | 503（原因来自 jobHealth） |
// | false       | true             | true         | 503（投递心跳） |
// | 任意        | true             | 缺省         | 503（调度健康未求值，fail-closed） |
import type { JobHealth } from './health'

export interface WorkerHealthzInput {
  /** `notify.worker_heartbeat` 在 2 分钟窗口内有跳动。 */
  notifyFresh: boolean
  /** `SCHEDULER_ENABLED !== '0'`。false = 本进程不跑调度 loop，调度健康**不参与**判定。 */
  schedulerEnabled: boolean
  /**
   * 调度健康（`jobHealth(pool, now)` 的结果）。schedulerEnabled=false 时忽略；
   * 开了调度却给 null ⇒ 判红（健康面不可观测，不许假绿）。
   */
  jobHealth?: JobHealth | null
}

export interface WorkerHealthzResult {
  ok: boolean
  /** 直接可写给 HTTP 响应。 */
  status: 200 | 503
  body: string
  reasons: string[]
}

export function workerHealthz(input: WorkerHealthzInput): WorkerHealthzResult {
  const reasons: string[] = []

  // 投递 loop 是本进程的本职，无论调度开关如何都必须新鲜。
  if (!input.notifyFresh) reasons.push('通知投递心跳陈旧')

  // 调度关闭时**完全不看** jobHealth：SCHEDULER_ENABLED=0 只停调度 loop，
  // 不能让「调度器本来就没跑」把整个 worker 判红（那会把回滚开关变成新的故障源）。
  if (input.schedulerEnabled) {
    if (!input.jobHealth) {
      reasons.push('调度健康未求值')
    } else if (!input.jobHealth.ok) {
      if (input.jobHealth.reasons.length > 0) reasons.push(...input.jobHealth.reasons)
      else reasons.push('调度健康异常（未给出具体原因）')
    }
  }

  const ok = reasons.length === 0
  return { ok, status: ok ? 200 : 503, body: ok ? 'ok' : reasons.join('; '), reasons }
}
