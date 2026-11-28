// ProcessDialog.test.tsx — 三路提交体 / 服务端金额预览 / 409 分支（2026-11-26 重写，#2884）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { ProcessDialog } from './ProcessDialog'
import { __resetAttachmentCacheForTests } from './lib/attachment-cache'

const m = vi.mocked(platformFetch)
const sends: Array<{ url: string; body: Record<string, unknown> }> = []
const quotes: Array<Record<string, unknown>> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const detail = {
  id: 7,
  code: 'AS-00000007',
  status: 'pending',
  product_name: '苹果',
  store_name: '一号店',
  damage_quantity: 2,
  basic_quantity: 15,
  basic_unit_price_minor: 450,
  settlement_price_minor: 450,
  damage_amount_minor: 900,
  related_order: '',
  arrival_at: null,
  attachments: [],
}

const rules = {
  items: [
    { id: 1, name: '全额', refundRatio: 0, remark: null, createdAt: '' },
    { id: 2, name: '一成', refundRatio: 0.1, remark: null, createdAt: '' },
  ],
  total: 2,
  page: 1,
  size: 100,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  sends.length = 0
  quotes.length = 0
  fetchMock = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  __resetAttachmentCacheForTests()
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/quote')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      quotes.push(body)
      const fixed = body.amountType === 'fixed'
      return json({
        status: 'completed',
        amountType: body.amountType,
        amountMinor: fixed ? body.amountMinor : 225,
        refundRatio: fixed ? null : body.refundRatio,
        damageAmountMinor: 900,
      })
    }
    if (url.includes('/process')) {
      sends.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return json({ ok: true, id: 7, status: 'completed', amountType: 'ratio', amountMinor: 225 })
    }
    if (url.includes('/tickets/7')) return json(detail)
    if (url.includes('/rules')) return json(rules)
    return json({ error: 'NOT_FOUND' }, 404)
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetAttachmentCacheForTests()
})

function open(onConflict = vi.fn()) {
  render(
    <ProcessDialog
      ticketId={7}
      open
      onClose={() => {}}
      onDone={() => {}}
      onConflict={onConflict}
    />,
  )
  return onConflict
}

/** 按标签选比例：antd Select 用 mousedown 打开（实测有效的驱动方式）。
 *  2026-11-28：弹窗里多了「售后提报规范性」下拉 ⇒ combobox 不止一个，按 DOM 顺序取第一个（比例）。 */
async function pickRatio(label: string): Promise<void> {
  const boxes = await screen.findAllByRole('combobox')
  fireEvent.mouseDown(boxes[0]!)
  fireEvent.click(await screen.findByText(label))
}

/** 售后提报规范性（必选）：DOM 里最后一个 combobox 就是它。 */
async function pickQuality(label = '正常提交'): Promise<void> {
  const boxes = await screen.findAllByRole('combobox')
  fireEvent.mouseDown(boxes[boxes.length - 1]!)
  fireEvent.click(await screen.findByText(label))
}

function fillOpinion(text = '外观破损'): void {
  fireEvent.change(screen.getByLabelText('售后意见'), { target: { value: text } })
}

describe('ProcessDialog', () => {
  it('ratio：提交体带 refundRatio / opinion / watermarkAt（不再带 remark）', async () => {
    open()
    await pickRatio('10%')
    fillOpinion()
    await pickQuality('虚假报损')
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.url).toBe('/api/modules/aftersales/tickets/7/process')
    expect(sends[0]!.body).toMatchObject({
      amountType: 'ratio', refundRatio: 0.1, opinion: '外观破损', submissionQuality: 'false_claim',
    })
    expect(sends[0]!.body.watermarkAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(sends[0]!.body).not.toHaveProperty('remark')
  })

  it('★ 金额只来自服务端：选比例后出现预览值，前端不写公式', async () => {
    open()
    expect(screen.queryByText('¥2.25')).toBeNull()
    await pickRatio('10%')
    await waitFor(() => expect(screen.getByText('¥2.25')).toBeInTheDocument())
    expect(quotes.at(-1)).toEqual({ amountType: 'ratio', refundRatio: 0.1 })
  })

  it('附件只显示 chip，不渲染 <img> 缩略图（不提前下载字节）', async () => {
    m.mockImplementation(async (url: string) => {
      if (url.includes('/tickets/7')) {
        return json({
          ...detail,
          attachments: [{ id: 9, objectKey: 'k', contentType: 'image/jpeg', sizeBytes: 10, url: 'https://x/1.jpg' }],
        })
      }
      if (url.includes('/rules')) return json(rules)
      if (url.includes('/quote')) return json({ amountMinor: 0, damageAmountMinor: 900 })
      return json({ error: 'NOT_FOUND' }, 404)
    })
    open()
    await screen.findByText('处理工单 AS-00000007')
    expect(screen.getByText('图片 1')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    // 打开处理弹窗就预缓存了这张图（不是等预览才下载）
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('关闭再打开处理弹窗：图片走缓存，不重复下载', async () => {
    m.mockImplementation(async (url: string) => {
      if (url.includes('/tickets/7')) {
        return json({
          ...detail,
          attachments: [
            { id: 9, objectKey: 'k9', contentType: 'image/jpeg', sizeBytes: 10, url: 'https://x/9.jpg' },
            { id: 10, objectKey: 'k10', contentType: 'image/jpeg', sizeBytes: 10, url: 'https://x/10.jpg' },
          ],
        })
      }
      if (url.includes('/rules')) return json(rules)
      if (url.includes('/quote')) return json({ amountMinor: 0, damageAmountMinor: 900 })
      return json({ error: 'NOT_FOUND' }, 404)
    })
    const { rerender } = render(
      <ProcessDialog ticketId={7} open onClose={() => {}} onDone={() => {}} />,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    rerender(<ProcessDialog ticketId={7} open={false} onClose={() => {}} onDone={() => {}} />)
    rerender(<ProcessDialog ticketId={7} open onClose={() => {}} onDone={() => {}} />)
    await waitFor(() => expect(screen.getByText('处理工单 AS-00000007')).toBeInTheDocument())
    // 缓存命中，没有第二次下载
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fixed：操作员填元，提交换算成整数分', async () => {
    open()
    await screen.findByText('处理工单 AS-00000007')
    fireEvent.click(screen.getByText('固定金额'))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '8.34' } })
    fillOpinion()
    await pickQuality()
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.body).toMatchObject({ amountType: 'fixed', amountMinor: 834, opinion: '外观破损' })
  })

  it('reject：带 amountType + 必填事实', async () => {
    open()
    await screen.findByText('处理工单 AS-00000007')
    fireEvent.click(screen.getByText('驳回'))
    fillOpinion()
    await pickQuality()
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.body).toMatchObject({
      amountType: 'reject', opinion: '外观破损', submissionQuality: 'normal',
    })
  })

  it('意见为空 ⇒ 提交按钮禁用（必填）', async () => {
    open()
    await screen.findByText('处理工单 AS-00000007')
    fireEvent.click(screen.getByText('驳回'))
    expect(screen.getByRole('button', { name: /提\s*交/ })).toBeDisabled()
  })

  it('409 ALREADY_PROCESSED → 明确提示「已被他人处理」并刷新', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/process')) return json({ error: 'ALREADY_PROCESSED' }, 409)
      if (url.includes('/tickets/7')) return json(detail)
      if (url.includes('/rules')) return json(rules)
      return json({ amountMinor: 0, damageAmountMinor: 900 }, 200)
    })
    const onConflict = open()
    await screen.findByText('处理工单 AS-00000007')
    fireEvent.click(screen.getByText('驳回'))
    fillOpinion()
    await pickQuality()
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(screen.getByText(/已被他人处理/)).toBeInTheDocument())
    expect(onConflict).toHaveBeenCalled()
  })
})
