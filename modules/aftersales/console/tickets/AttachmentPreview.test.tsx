// AttachmentPreview.test.tsx — 懒加载 + 单次缓存（2026-11-27）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string) { super(code) }
  },
  apiGet: vi.fn(async () => ({ url: 'https://x/fresh.jpg' })),
  messageOf: (e: unknown) => (e instanceof Error ? e.message : '附件加载失败'),
}))

import { AttachmentPreview } from './AttachmentPreview'
import { __resetAttachmentCacheForTests } from './lib/attachment-cache'

const att = (id: number, contentType = 'image/jpeg') => ({
  id,
  objectKey: `k/${id}`,
  contentType,
  sizeBytes: 10,
  url: `https://x/${id}`,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => `blob:${Math.random()}`), configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  __resetAttachmentCacheForTests()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetAttachmentCacheForTests()
})

describe('AttachmentPreview', () => {
  it('未打开不加载；打开只加载当前；重复打开同一附件不再 fetch', async () => {
    const items = [att(1)]
    const { rerender } = render(<AttachmentPreview items={items} index={0} open={false} onClose={() => {}} />)
    expect(fetchMock).not.toHaveBeenCalled()

    rerender(<AttachmentPreview items={items} index={0} open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    rerender(<AttachmentPreview items={items} index={0} open={false} onClose={() => {}} />)
    rerender(<AttachmentPreview items={items} index={0} open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    // 缓存命中：第二次打开不重新下载
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('上一个/下一个各自只加载一次；返回已看过的附件走缓存', async () => {
    const items = [att(1), att(2)]
    render(<AttachmentPreview items={items} index={0} open onClose={() => {}} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: /下一个/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: /上一个/ }))
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('视频不整段 fetch，只使用预签名 URL 交给 <video> 流式播放', async () => {
    const { } = render(
      <AttachmentPreview items={[att(3, 'video/mp4')]} index={0} open onClose={() => {}} />,
    )
    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())
    expect(document.querySelector('video')?.getAttribute('src')).toBe('https://x/3')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('加载失败显示错误与重试，不白屏', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    render(<AttachmentPreview items={[att(4)]} index={0} open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/附件加载失败/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument()
  })
})
