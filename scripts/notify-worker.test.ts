// scripts/notify-worker.test.ts —— 停机收尾（#2567）的纯逻辑。
//
// 钉三件事：
//   ① 子进程全部收尾 ⇒ 立刻返回 0（不白等满预算）；
//   ② 一直到预算耗尽还没跑完 ⇒ 返回剩余条数（调用方照常退出，退回 docker SIGKILL 的老行为）；
//   ③ 等待期间**不** claim 新作业是主循环的事，这里只保证「轮询 to 归零」这一条语义。
import { describe, expect, it } from 'vitest'
import { checkMounts, drainInFlight } from './notify-worker.mjs'

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
    const left = await drainInFlight(sched, 60_000, (m) => { msgs.push(m) }, { sleepMs: 0 })
    expect(left).toBe(0)
    expect(msgs.at(-1)).toEqual({ drain: 'done', waitedMs: 0 })
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
    const left = await drainInFlight(sched, 5_000, (m) => { msgs.push(m) }, { sleepMs: 0, now: () => (t += 2000) })
    expect(left).toBe(2)
    expect(msgs.at(-1)).toMatchObject({ drain: 'timeout', inFlight: 2 })
  })

  it('预算为 0 ⇒ 一次都不等（用于 `--once` 之类不该阻塞的场景）', async () => {
    const sched = fakeSched([1])
    const left = await drainInFlight(sched, 0, () => {}, { sleepMs: 0 })
    expect(left).toBe(1)
  })
})

describe('notify-worker checkMounts（#2573 方案 B）', () => {
  const stat = (devs: Record<string, number>) => (p: string) => {
    if (!(p in devs)) throw new Error('ENOENT')
    return { dev: devs[p] }
  }

  it('★ st_dev 与 /app 不同 ⇒ 判定为已挂载', () => {
    const out = checkMounts([{ dir: '/app/scripts', parent: '/app' }], stat({ '/app': 1, '/app/scripts': 2 }))
    expect(out[0]).toEqual({ dir: '/app/scripts', mounted: true })
  })

  it('★ st_dev 与 /app 相同 ⇒ 判定为未挂载（正在用镜像里的旧副本）', () => {
    const out = checkMounts([{ dir: '/app/dbt', parent: '/app' }], stat({ '/app': 7, '/app/dbt': 7 }))
    expect(out[0]).toMatchObject({ dir: '/app/dbt', mounted: false })
    expect(out[0].reason).toMatch(/未挂载/)
  })

  it('★ 目录不存在 ⇒ 也算未挂载，并带上原因（不静默）', () => {
    const out = checkMounts([{ dir: '/app/contracts', parent: '/app' }], stat({ '/app': 1 }))
    expect(out[0]).toMatchObject({ dir: '/app/contracts', mounted: false })
    expect(out[0].reason).toMatch(/stat 失败/)
  })
})
