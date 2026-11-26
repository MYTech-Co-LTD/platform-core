// utils/compress-image.ts — 上传前的图片压缩（2026-11-26）。
//
// 为什么要有它：附件直传对象存储，**出流量与存储量都按量计费**；手机原图 3–5MB
// 而屏幕 390px 宽、3x DPR 也只要 1170px——传原图是为不存在的像素付费。
//
// 质量红线（这是本模块唯一重要的判断）：
//   · 长边上限 **2048px**：手机屏幕 390px × 3 DPR = 1170px；2048 留足放大余量，
//     打印 A4 也够。再大就是纯浪费。
//   · JPEG **q=0.85**：视觉上与原图几乎无差（q<0.7 才开始出现可见块状）。
//   · **已经够小的不压**（≤1.5MB 且长边 ≤2048）：二次压缩只损质量不省钱。
//   · **EXIF 方向必须应用**（`imageOrientation: 'from-image'`）：否则 iPhone 竖拍
//     照片会横着出现——这是 canvas 压缩最常见的坑。
//   · 压不动（HEIC 等浏览器解不了的格式）就**原样返回**，绝不因为压缩失败丢图。

/** 长边像素上限（见头注：屏幕 390×3DPR=1170，留足余量） */
export const MAX_EDGE_PX = 2048
/** JPEG 质量（0–1）：0.85 是「肉眼无法与原图区分」的常用下限 */
export const JPEG_QUALITY = 0.85
/** 小于这个体积且长边不超限的文件不值得再压（二次压缩只损质量） */
export const SKIP_IF_UNDER_BYTES = 1.5 * 1024 * 1024

/** 图片体积上限（压缩后通常 <1MB；10MB 是给「压不动」的格式留的余量） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** 视频体积上限（客户端不转码——转码放服务端；这里只挡异常大文件） */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024

const isImage = (file: File): boolean => file.type.startsWith('image/')

/**
 * 压缩图片。**任何失败都返回原文件**——压缩是省钱手段，不是上传的前置条件。
 * @returns 压缩后的 File（文件名扩展名同步改为 .jpg），或原文件
 */
export async function compressImage(file: File): Promise<File> {
  if (!isImage(file)) return file
  // 压不动就原样传（HEIC / 异常编码）：宁可多花点钱，也不能丢用户的图
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

  let bitmap: ImageBitmap | null = null
  try {
    // `from-image` ⇒ 应用 EXIF 方向（否则 iPhone 竖拍会横过来）
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const maxEdge = Math.max(bitmap.width, bitmap.height)
    const scale = maxEdge > MAX_EDGE_PX ? MAX_EDGE_PX / maxEdge : 1
    // 已经够小：不压（二次压缩只损质量）
    if (scale >= 1 && file.size <= SKIP_IF_UNDER_BYTES) return file

    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    // 透明背景转白底（PNG 截图转 JPEG 时透明会变黑，那是明显的观感缺陷）
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    if (!blob) return file
    // 压完反而更大（小图遇到 q0.85 的极小情况）⇒ 用原图
    if (blob.size >= file.size) return file

    const baseName = file.name.replace(/\.[^.]+$/, '')
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified })
  } catch {
    return file
  } finally {
    bitmap?.close?.()
  }
}
