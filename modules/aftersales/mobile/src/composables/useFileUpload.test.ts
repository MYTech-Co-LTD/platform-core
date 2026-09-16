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

type UploadResult = Awaited<ReturnType<typeof uploadImage>>
const file = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/jpeg' })

/**
 * 可控的 in-flight 上传：**不 await** 就停在「上传中」，由测试决定何时成功。
 * F1 的两个场景都要求「上传还没回来时删掉列表里的行」，靠 `mockResolvedValue` 做不出来。
 */
const deferredUpload = () => {
  let resolve!: (v: UploadResult) => void
  const promise = new Promise<UploadResult>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

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

  // ── F1 回归（独立评审）：回写**不能依赖下标** ────────────────────────────────────
  // 页面的删除按钮在上传中**可点**（afterSalesWorkOrderSubmit.vue 的删除按钮无 v-if），
  // 而 `removeAttachment` 会 splice ⇒ 上传前记下的下标当场失效。两条各钉一个症状。

  it('F1-A：删掉正在上传的那条 ⇒ 上传成功后它**不复活**（找不到就丢弃结果）', async () => {
    const f = mount()
    const d = deferredUpload()
    up.mockReturnValue(d.promise)

    const pending = f.addAttachment(file('a.jpg'))
    expect(list(f)).toHaveLength(1)

    f.removeAttachment(0)
    expect(list(f)).toEqual([])

    d.resolve({ id: 42, objectKey: 'k', uploadUrl: 'u', expiresIn: 60 })
    await pending

    // 旧实现按下标回写 `attachments.value[0] = {...}` ⇒ 把删掉的那条**复活**成 completed，
    // 且它的 previewUrl 已被 revoke（缩略图是坏的），还会被计进提交。
    expect(list(f)).toEqual([])
  })

  it('F1-B：删掉**前面**的条目 ⇒ 无僵尸 uploading、无重复（回写落到同一个附件上）', async () => {
    const f = mount()
    await f.addAttachment(file('a.jpg')) // 第一条：已传完，占 0 号位

    const d = deferredUpload()
    up.mockReturnValue(d.promise)
    const pending = f.addAttachment(file('b.jpg')) // 第二条：上传中，占 1 号位
    expect(list(f).map((a) => a.name)).toEqual(['a.jpg', 'b.jpg'])

    f.removeAttachment(0) // 删掉前面的 ⇒ 数组左移，b 落到 0 号位
    d.resolve({ id: 43, objectKey: 'k2', uploadUrl: 'u', expiresIn: 60 })
    await pending

    const l = list(f)
    // 旧实现写回 `attachments.value[1]`：1 号位现在是**空位**，于是长出第二条 b
    // ——旧下标上那条永远是 uploading（僵尸），新下标上那条是 completed（重复）。
    expect(l.map((a) => a.name)).toEqual(['b.jpg'])
    expect(l[0].uploadStatus).toBe('completed')
    expect(l.filter((a) => a.uploadStatus === 'uploading')).toHaveLength(0)
  })

  it('clearAttachments：逐个 revoke（否则每次清空漏一批 blob）', async () => {
    const f = mount()
    await f.addAttachment(new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }))
    f.clearAttachments()
    expect(list(f)).toEqual([])
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
  })
})
