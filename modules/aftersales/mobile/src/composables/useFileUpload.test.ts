import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadImage } from '@/shims/wuji-upload'
import { useFileUpload } from './useFileUpload'

vi.mock('@/shims/wuji-upload', () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }))
vi.mock('@wujibase/wuji', () => ({ Message: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const up = vi.mocked(uploadImage)

// ⚠️ 构造方式与计划稿不同：`useFileUpload` 的**源侧签名就是无参**（它自建 `attachments` ref，
// 由 `useAfterSalesWorkOrder` 转出去给页面）——计划稿里那个 `useFileUpload({attachments})` 的写法
// 与实读不符，按计划的注记改**测试的构造方式**，不动 composable 的对外签名。
const mount = () => useFileUpload()
const list = (f: ReturnType<typeof useFileUpload>) => (f.attachments as { value: any[] }).value

beforeEach(() => {
  up.mockReset().mockResolvedValue({ id: 42, objectKey: 'k' })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:local-preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('useFileUpload', () => {
  it('成功后：previewUrl 是本地 blob、attachmentId 是服务端给的 id', async () => {
    const f = mount()
    await f.addAttachment(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))
    const a = list(f)[0]
    expect(a).toMatchObject({ type: 'image', previewUrl: 'blob:local-preview', attachmentId: 42, uploadStatus: 'completed' })
    // 成功后**不能** revoke：本地 blob 是域侧唯一的预览源（源侧才 revoke，它的 url 是远端地址）
    expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('失败：标记 failed 且上抛（不留下一个「看起来成了」的附件）', async () => {
    up.mockRejectedValue(new Error('boom'))
    const f = mount()
    await expect(f.addAttachment(new File([], 'a.jpg', { type: 'image/jpeg' }))).rejects.toThrow('boom')
    expect(list(f)[0].uploadStatus).toBe('failed')
  })

  it('removeAttachment：同时 revoke 本地预览 URL（源侧没有这一步，因为它的 url 是远端地址）', async () => {
    const f = mount()
    await f.addAttachment(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))
    f.removeAttachment(0)
    expect(list(f)).toEqual([])
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
  })

  it('clearAttachments：逐个 revoke（否则每次清空漏一批 blob）', async () => {
    const f = mount()
    await f.addAttachment(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))
    f.clearAttachments()
    expect(list(f)).toEqual([])
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
  })
})
