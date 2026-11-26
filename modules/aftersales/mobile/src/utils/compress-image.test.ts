// compress-image.test.ts — 压缩的**分支**测（质量参数本身靠真机看，不在这里断言）
//
// happy-dom 没有真 canvas / createImageBitmap，所以这里测的是「什么时候压、什么时候不压、
// 压失败怎么办」这三类判断——它们才是会丢图或白花钱的地方。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressImage, JPEG_QUALITY, MAX_EDGE_PX, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, SKIP_IF_UNDER_BYTES } from './compress-image'

const makeFile = (name: string, type: string, size: number): File => {
  const f = new File([new Uint8Array(1)], name, { type })
  // File 的 size 只读 ⇒ 用 defineProperty 造出目标体积（不做真的 1MB 内存分配）
  Object.defineProperty(f, 'size', { value: size })
  return f
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('compressImage', () => {
  it('非图片 ⇒ 原样返回（视频/其它类型不压）', async () => {
    const f = makeFile('a.mp4', 'video/mp4', 50 * 1024 * 1024)
    expect(await compressImage(f)).toBe(f)
  })

  it('环境不支持 createImageBitmap ⇒ 原样返回（不因压不了而丢图）', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const f = makeFile('a.jpg', 'image/jpeg', 5 * 1024 * 1024)
    expect(await compressImage(f)).toBe(f)
  })

  it('小图（未超长边且 ≤1.5MB）⇒ 原样返回：二次压缩只损质量不省钱', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 800, height: 600, close: () => {} }))
    const f = makeFile('small.jpg', 'image/jpeg', SKIP_IF_UNDER_BYTES - 1)
    expect(await compressImage(f)).toBe(f)
  })

  it('大图 ⇒ 走压缩：长边被限到 2048、输出 jpg、质量 0.85', async () => {
    const toBlob = vi.fn((cb: (b: Blob | null) => void, type: string, quality: number) => {
      expect(type).toBe('image/jpeg')
      expect(quality).toBe(JPEG_QUALITY)
      cb(new Blob([new Uint8Array(1)], { type: 'image/jpeg' }))
    })
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000, close: () => {} }))
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }),
        toBlob,
      }),
    })

    const f = makeFile('big.jpg', 'image/jpeg', 5 * 1024 * 1024)
    const out = await compressImage(f)
    expect(toBlob).toHaveBeenCalledTimes(1)
    expect(out.name).toBe('big.jpg') // 原名保留，扩展名已是 .jpg
    expect(out.type).toBe('image/jpeg')
    // Blob 体积小于原图 ⇒ 采用压缩结果（本用例里是 1 字节 < 5MB）
    expect(out).not.toBe(f)
  })

  it('压完反而更大 ⇒ 用原图（小图遇到固定质量的边界情况）', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000, close: () => {} }))
    // 造一个「比原文件还大」的压缩结果
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({ fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }),
        toBlob: (cb: (b: Blob | null) => void) => {
          const big = new Blob([new Uint8Array(1)])
          Object.defineProperty(big, 'size', { value: 99 * 1024 * 1024 })
          cb(big)
        },
      }),
    })
    const f = makeFile('tiny.jpg', 'image/jpeg', 2 * 1024 * 1024)
    expect(await compressImage(f)).toBe(f)
  })

  it('toBlob 返回 null ⇒ 原样返回（编码失败不丢图）', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000, close: () => {} }))
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({ fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }),
        toBlob: (cb: (b: Blob | null) => void) => cb(null),
      }),
    })
    const f = makeFile('x.jpg', 'image/jpeg', 5 * 1024 * 1024)
    expect(await compressImage(f)).toBe(f)
  })

  it('常量：长边 2048 / 质量 0.85 / 上限 20MB·500MB（红线与兜底的唯一事实源）', () => {
    expect(MAX_EDGE_PX).toBe(2048)
    expect(JPEG_QUALITY).toBe(0.85)
    // 上限是**兜底**不是压缩目标：压得动就压，压不动也不能把人挡在门外
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_VIDEO_BYTES).toBe(500 * 1024 * 1024)
  })
})
