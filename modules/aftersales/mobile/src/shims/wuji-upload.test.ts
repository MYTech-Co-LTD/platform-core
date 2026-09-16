import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadFile, uploadImage } from './wuji-upload'

const calls: Array<{ url: string; init?: RequestInit }> = []
const origFetch = globalThis.fetch

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  calls.length = 0
  sessionStorage.clear()
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.startsWith('/api/modules/aftersales/guest/attachments')) {
      return json(201, { id: 42, objectKey: 'org/ref/a.jpg', uploadUrl: 'https://zos.test/put?a=1', expiresIn: 600 })
    }
    return new Response(null, { status: 200 }) // 直传 PUT
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = origFetch })

describe('shims/wuji-upload', () => {
  it('uploadImage：先拿预签名，再直传字节，回 {id, objectKey}', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' })
    const r = await uploadImage(file, 'after-sales/temp/2026/09/16/temp_1_abcdef.jpg')
    expect(r).toEqual({ id: 42, objectKey: 'org/ref/a.jpg' })

    // ① 预签名请求：带 content-type 与**会话级幂等键**（附件挂在工单幂等键下，spec §2.3）
    const presign = JSON.parse(String(calls[0]!.init?.body))
    expect(calls[0]!.url).toBe('/api/modules/aftersales/guest/attachments')
    expect(presign.contentType).toBe('image/jpeg')
    expect(presign.sizeBytes).toBe(3)
    expect(presign.clientRequestId).toBe(sessionStorage.getItem('aftersales.clientRequestId'))

    // ② 直传：PUT 到预签名 URL，字节不过平台
    expect(calls[1]!.url).toBe('https://zos.test/put?a=1')
    expect(calls[1]!.init?.method).toBe('PUT')
    expect(calls[1]!.init?.headers).toEqual({ 'Content-Type': 'image/jpeg' })
  })

  it('uploadFile：非图片走同一路（白名单在服务端，客户端不重复判）', async () => {
    const file = new File([new Uint8Array([1])], 'v.mp4', { type: 'video/mp4' })
    await uploadFile(file, 'p')
    expect(JSON.parse(String(calls[0]!.init?.body)).contentType).toBe('video/mp4')
  })

  it('ZOS 未配置（503）⇒ 上抛，让页面能提示而不是留一张传不上去的工单', async () => {
    globalThis.fetch = vi.fn(async () => json(503, { error: 'ZOS_NOT_CONFIGURED' })) as unknown as typeof fetch
    await expect(uploadImage(new File([], 'a.jpg', { type: 'image/jpeg' }), 'p')).rejects.toMatchObject({
      code: 'ZOS_NOT_CONFIGURED',
    })
  })

  it('预签名成功但直传失败 ⇒ 上抛（不返回一个「看起来成了」的 id）', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.startsWith('/api/')) return json(201, { id: 42, objectKey: 'k', uploadUrl: 'https://zos.test/put' })
      return new Response('nope', { status: 403 })
    }) as unknown as typeof fetch
    await expect(uploadImage(new File([], 'a.jpg', { type: 'image/jpeg' }), 'p')).rejects.toMatchObject({ status: 403 })
  })
})
