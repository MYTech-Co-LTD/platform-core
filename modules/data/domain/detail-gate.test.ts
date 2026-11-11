import { afterEach, describe, expect, it } from 'vitest'
import { DetailGate, DetailGateBusyError, detailGate, resetDetailGate } from './detail-gate'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('DetailGate（明细并发准入门，#1951）', () => {
  afterEach(() => {
    resetDetailGate()
    delete process.env.DATA_DETAIL_CONCURRENCY
    delete process.env.DATA_DETAIL_WAIT_MS
  })

  it('并发上限内直接放行，release 后名额回补', async () => {
    const g = new DetailGate({ concurrency: 2, waitMs: 100 })
    const r1 = await g.acquire()
    const r2 = await g.acquire()
    expect(g.stats().inFlight).toBe(2)
    r1()
    expect(g.stats().inFlight).toBe(1)
    r2()
    expect(g.stats().inFlight).toBe(0)
  })

  it('超限排队：前一个 release 后，等待者拿到名额', async () => {
    const g = new DetailGate({ concurrency: 1, waitMs: 200 })
    const r1 = await g.acquire()
    let got = false
    const p = g.acquire().then((release) => { got = true; return release })
    await tick()
    expect(got).toBe(false)
    expect(g.stats().waiting).toBe(1)
    r1()
    const r2 = await p
    expect(got).toBe(true)
    r2()
  })

  it('等不到名额 ⇒ DetailGateBusyError（可重试，不是 500）', async () => {
    const g = new DetailGate({ concurrency: 1, waitMs: 30 })
    const r1 = await g.acquire()
    await expect(g.acquire()).rejects.toBeInstanceOf(DetailGateBusyError)
    r1()
    expect(g.stats().waiting).toBe(0)
  })

  it('release 幂等：重复调用不会多放名额', async () => {
    const g = new DetailGate({ concurrency: 2, waitMs: 100 })
    const r1 = await g.acquire()
    r1(); r1()
    expect(g.stats().inFlight).toBe(0)
  })

  it('单例从 env 读并发与等待时间', () => {
    process.env.DATA_DETAIL_CONCURRENCY = '1'
    process.env.DATA_DETAIL_WAIT_MS = '1234'
    const s = detailGate().stats()
    expect(s.concurrency).toBe(1)
    expect(s.waitMs).toBe(1234)
  })
})
