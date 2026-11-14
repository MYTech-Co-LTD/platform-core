// QueryQuality.test.tsx — 查询性能面板（R4）：p95/慢查询占比越线可见，健康不误报。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { QueryQuality } from './QueryQuality'

const m = vi.mocked(platformFetch)
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const stats = (over: Record<string, unknown> = {}) => ({
  days: 7, total: 20, sampled: 18, p95Ms: 5_200, slow: 4, slowRate: 0.2,
  breaches: ['p95', 'slow_rate'],
  slo: { p95Ms: 3_000, slowRate: 0.1 },
  byMetric: [
    { metricId: 'm:slow', total: 6, slow: 3, p95Ms: 8_000 },
    { metricId: 'm:fast', total: 12, slow: 0, p95Ms: 200 },
  ],
  byDay: [],
  ...over,
})

afterEach(() => { cleanup(); m.mockReset() })

describe('QueryQuality', () => {
  it('★ 越线 ⇒ 「需关注」+ 阈值说明 + 最慢指标', async () => {
    m.mockResolvedValue(json(stats()))
    render(<QueryQuality />)

    expect(await screen.findByText('需关注')).toBeInTheDocument()
    expect(screen.getByText('5.2s')).toBeInTheDocument()
    expect(screen.getByText(/查询 p95 超过阈值/)).toBeInTheDocument()
    expect(screen.getByText(/慢查询占比超过阈值/)).toBeInTheDocument()
    expect(screen.getByText(/最慢指标：m:slow/)).toBeInTheDocument()
    expect(screen.getByText(/2 条旧记录无耗时样本/)).toBeInTheDocument()
  })

  it('健康窗口 ⇒ 「健康」且不出告警', async () => {
    m.mockResolvedValue(json(stats({
      p95Ms: 900, slow: 0, slowRate: 0, breaches: [], sampled: 20,
    })))
    render(<QueryQuality />)

    expect(await screen.findByText('健康')).toBeInTheDocument()
    expect(screen.queryByText(/超过阈值/)).not.toBeInTheDocument()
  })

  it('无查询记录 ⇒ 不画 0', async () => {
    m.mockResolvedValue(json(stats({
      total: 0, sampled: 0, p95Ms: null, slow: 0, slowRate: null, breaches: [], byMetric: [],
    })))
    render(<QueryQuality />)
    expect(await screen.findByText('近 7 天没有查询记录')).toBeInTheDocument()
  })

  it('回包不完整 ⇒ 人话，不崩', async () => {
    m.mockResolvedValue(json({}))
    render(<QueryQuality />)
    expect(await screen.findByText(/返回数据不完整/)).toBeInTheDocument()
  })
})
