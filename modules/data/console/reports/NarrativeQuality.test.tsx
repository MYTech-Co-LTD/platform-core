// NarrativeQuality.test.tsx — AI 叙事质量面板（R5）：阈值越线必须可见，健康不误报。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { NarrativeQuality } from './NarrativeQuality'

const m = vi.mocked(platformFetch)
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const stats = (over: Record<string, unknown> = {}) => ({
  days: 7,
  total: 4,
  byOutcome: { ok: 2, fallback: 1, cached: 1, error: 0 },
  fallbackRate: 1 / 3,
  numberCheckCount: 1,
  numberCheckRate: 1 / 3,
  cacheHitRate: 0.25,
  p95Ms: 12_000,
  factsP95Ms: 1_200,
  breaches: ['fallback_rate', 'number_check'],
  slo: { fallbackRate: 0.2, p95Ms: 45_000, numberCheckRate: 0.05 },
  byPromptVersion: [],
  byDay: [],
  ...over,
})

afterEach(() => {
  cleanup()
  m.mockReset()
})

describe('NarrativeQuality', () => {
  it('★ 越线 ⇒ 「需关注」+ 逐条阈值说明（口径由服务端下发）', async () => {
    m.mockResolvedValue(json(stats()))
    render(<NarrativeQuality />)

    expect(await screen.findByText('需关注')).toBeInTheDocument()
    expect(screen.getByText('生成次数')).toBeInTheDocument()
    expect(screen.getAllByText('33.3%').length).toBeGreaterThan(0)
    expect(screen.getByText(/回退率超过阈值/)).toBeInTheDocument()
    expect(screen.getByText(/数字校验越界率超过阈值/)).toBeInTheDocument()
    expect(screen.getByText(/缓存命中 25.0%/)).toBeInTheDocument()
    expect(screen.getByTestId('facts-p95').textContent).toContain('1.2s')
  })

  it('健康窗口 ⇒ 「健康」且不出告警', async () => {
    m.mockResolvedValue(json(stats({
      total: 2, byOutcome: { ok: 2, fallback: 0, cached: 0, error: 0 },
      fallbackRate: 0, numberCheckCount: 0, numberCheckRate: 0, cacheHitRate: 0,
      breaches: [],
    })))
    render(<NarrativeQuality />)

    expect(await screen.findByText('健康')).toBeInTheDocument()
    expect(screen.queryByText(/超过阈值/)).not.toBeInTheDocument()
  })

  it('没有样本 ⇒ 不画 0，明确说没有记录', async () => {
    m.mockResolvedValue(json(stats({
      total: 0, byOutcome: { ok: 0, fallback: 0, cached: 0, error: 0 },
      fallbackRate: null, numberCheckRate: null, cacheHitRate: null, p95Ms: null,
      breaches: [],
    })))
    render(<NarrativeQuality />)

    expect(await screen.findByText('近 7 天没有叙事生成记录')).toBeInTheDocument()
  })

  it('回包形状不完整 ⇒ 人话（面板是增补面，不拖垮整页）', async () => {
    m.mockResolvedValue(json({}))
    render(<NarrativeQuality />)

    expect(await screen.findByText(/返回数据不完整/)).toBeInTheDocument()
  })

  it('接口失败 ⇒ 人话（不吞成空白）', async () => {
    m.mockResolvedValue(json({ error: 'FORBIDDEN' }, 403))
    render(<NarrativeQuality />)

    expect(await screen.findByText(/AI 叙事质量统计暂不可用/)).toBeInTheDocument()
  })
})
