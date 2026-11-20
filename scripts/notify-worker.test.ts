// scripts/notify-worker.test.ts —— 停机收尾（#2567）的纯逻辑。
//
// 钉三件事：
//   ① 子进程全部收尾 ⇒ 立刻返回 0（不白等满预算）；
//   ② 一直到预算耗尽还没跑完 ⇒ 返回剩余条数（调用方照常退出，退回 docker SIGKILL 的老行为）；
//   ③ 等待期间**不** claim 新作业是主循环的事，这里只保证「轮询 to 归零」这一条语义。
import { describe, expect, it } from 'vitest'
import { drainInFlight } from './notify-worker.mjs'

/** 假调度器：按脚本逐次返回 inFlight。 */
function fakeSched(seq: number[]) {
  let i = 0
  return {
    calls: () => i,
    inFlight: () => {
      const v = seq[Math.min(i, seq.length - 1)]
      i += 1
      return v
    },
  }
}

describe('notify-worker drainInFlight', () => {
  it('★ 没有在跑的作业 ⇒ 立即返回 0，一次都不睡', async () => {
    const sched = fakeSched([0])
    const msgs: Array<Record<string, unknown>> = []
    // `now` 注入常量：本用例要钉的是「一次都没睡」，不是墙钟精度 ——
    // 用真 `Date.now()` 时两次调用跨毫秒边界会得到 waitedMs=1（2026-11-20 CI 偶发红，#2604）。
    const left = await drainInFlight(sched, 60_000, (m) => msgs.push(m), { sleepMs: 0, now: () => 1000 })
    expect(left).toBe(0)
    expect(msgs.at(-1)).toEqual({ drain: 'done', waitedMs: 0 })
    // 主证据：一次都没进循环（进了循环就会多查一次 inFlight，并至少 sleep 一轮）。
    expect(sched.calls()).toBe(1)
  })

  it('★ 先有作业、随后收尾 ⇒ 等到归零再返回', async () => {
    // 1 → 1 → 0：两轮 sleep 后归零。
    const sched = fakeSched([1, 1, 0])
    let t = 0
    const left = await drainInFlight(sched, 60_000, () => {}, { sleepMs: 0, now: () => (t += 1000) })
    expect(left).toBe(0)
    expect(sched.calls()).toBeGreaterThanOrEqual(3)
  })

  it('★ 预算耗尽仍在跑 ⇒ 返回剩余条数（不谎报「已收尾」）', async () => {
    const sched = fakeSched([2]) // 永远 2 条在跑
    let t = 0
    const msgs: Array<Record<string, unknown>> = []
    // 预算 5s、每轮 +2s ⇒ 3 轮后到点。
    const left = await drainInFlight(sched, 5_000, (m) => msgs.push(m), { sleepMs: 0, now: () => (t += 2000) })
    expect(left).toBe(2)
    expect(msgs.at(-1)).toMatchObject({ drain: 'timeout', inFlight: 2 })
  })

  it('预算为 0 ⇒ 一次都不等（用于 `--once` 之类不该阻塞的场景）', async () => {
    const sched = fakeSched([1])
    const left = await drainInFlight(sched, 0, () => {}, { sleepMs: 0 })
    expect(left).toBe(1)
  })
})
