// worker-healthz.ts — worker `/healthz` 的**纯判定**（不碰 HTTP、不碰库）。
//
// 为什么单独抽出来：worker 曾把「投递 loop + 调度 loop」放在同一进程（Wave 6 P1）。
// 健康判定要把两份心跳合并成一条 200/503。把判定留在 `scripts/notify-worker.mjs`
// 的请求回调里就只能起 HTTP + 真库去测；抽成纯函数后，开关语义（尤其
// `SCHEDULER_ENABLED=0` / `NOTIFY_DELIVERY_ENABLED=0`）可以直接用桩覆盖。
//
// ── 角色拆分（2026-11-19，#2504）─────────────────────────────────────────────
// 两个 loop 拆进两个**部署单元**：投递留在应用单元（随应用频繁发版重建），
// 调度搬进数据单元（不随应用部署重启，否则每次发版都收掉正在跑的采集/物化子进程）。
// 同一个入口进程按 role env 扮演其一：
//   · `NOTIFY_DELIVERY_ENABLED=0` ⇒ 调度专用容器：**没有**投递心跳，判定不得因它红；
//   · `SCHEDULER_ENABLED=0`       ⇒ 投递专用容器（应用单元默认）：不看调度健康。
//
// 判定表（`notifyFresh` = `notify.worker_heartbeat` 2 分钟内有过跳动）：
//
// | deliveryEnabled | notifyFresh | schedulerEnabled | jobHealth.ok | 结果 |
// |-----------------|-------------|------------------|--------------|------|
// | true            | true        | false            | 任意/缺省     | 200  |
// | true            | false       | false            | 任意/缺省     | 503（只报投递心跳，**不因调度红**） |
// | true            | true        | true             | true         | 200  |
// | true            | true        | true             | false        | 503（原因来自 jobHealth） |
// | true            | false       | true             | true         | 503（投递心跳） |
// | 任意            | 任意        | true             | 缺省         | 503（调度健康未求值，fail-closed） |
// | false           | 忽略        | true             | true         | 200（调度专用容器） |
// | false           | 忽略        | true             | false        | 503 |
// | false           | 忽略        | false            | 任意         | 503（两个 loop 都关 = 这容器无事可做，配错而非健康） |
import type { JobHealth } from './health'

export interface WorkerHealthzInput {
  /** `notify.worker_heartbeat` 在 2 分钟窗口内有跳动。deliveryEnabled=false 时忽略。 */
  notifyFresh: boolean
  /**
   * `NOTIFY_DELIVERY_ENABLED !== '0'`。false = 本进程不跑投递 loop ⇒
   * **不许**再拿投递心跳判红（调度专用容器本来就没有这条心跳）。
   */
  deliveryEnabled: boolean
  /** `SCHEDULER_ENABLED !== '0'`。false = 本进程不跑调度 loop，调度健康**不参与**判定。 */
  schedulerEnabled: boolean
  /**
   * 调度健康（`jobHealth(pool, now)` 的结果）。schedulerEnabled=false 时忽略；
   * 开了调度却给 null ⇒ 判红（健康面不可观测，不许假绿）。
   */
  jobHealth?: JobHealth | null
  /**
   * 因缺 env 而**不进入 claim 集合**的作业（#2511）。非空即红：
   * 配置错必须在这里可见，而不是等它的 cron 时刻在台账里静默失败一次。
   */
  blockedJobs?: ReadonlyArray<{ key: string; missing: string[] }>
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

  // 投递心跳只在**本进程跑投递 loop**时才要求新鲜：调度专用容器没有它，判它等于恒红。
  if (input.deliveryEnabled && !input.notifyFresh) reasons.push('通知投递心跳陈旧')

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

  // 两个角色都关：进程活着但什么也不做 —— 这是 env 配错（多半是拆机时两边都设了 0），
  // 判定为红，否则一个空转容器会显示"健康"。
  if (!input.deliveryEnabled && !input.schedulerEnabled) {
    reasons.push('投递与调度 loop 都被关闭（本进程无事可做）')
  }

  // 缺 env 被挡在 claim 集合外的作业：同样是"配置错"，必须在健康面可见（#2511）。
  for (const b of input.blockedJobs ?? []) {
    reasons.push(`${b.key}：缺 env 未启用（${b.missing.join(', ')}）`)
  }

  const ok = reasons.length === 0
  return { ok, status: ok ? 200 : 503, body: ok ? 'ok' : reasons.join('; '), reasons }
}
