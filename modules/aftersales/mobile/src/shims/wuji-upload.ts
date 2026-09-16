// src/shims/wuji-upload.ts —— `@wujibase/wuji-upload` 的收窄替身（spec §3.2 三 shim 表）。
//
// 源侧形状是 `uploadFn(file, uniqueFilePath)` → **string url**。域侧的路是**预签名直传**：
// `POST /guest/attachments` 拿 URL（字节**不过平台**，spec §2.3），再 PUT 到 ZOS。
//
// ⚠️ 返回值与源侧**不同**（`{id, objectKey}` 而不是 url）：源侧的 url 是它自己 CDN 的
// 可读地址，而平台的预签名 **PUT** URL 不是可读地址（GET 要另签）。页面需要的两样东西是
// 「本地预览」与「提交时认领的 attachmentId」——前者由 composable 用 `URL.createObjectURL`
// 自己持有，后者就是这里的 `id`。适配点写在 `useFileUpload.ts`（Task 7）。
import { ApiError, apiSend } from './http'
import { currentClientRequestId } from './client-request-id'

export interface UploadResult {
  id: number
  objectKey: string
}

interface PresignResponse {
  id: number
  objectKey: string
  uploadUrl: string
  expiresIn: number
}

async function upload(file: File, _path: string): Promise<UploadResult> {
  // `_path`（源侧的 object key）刻意不参与：key 由**服务端**按 `objectKeyFor(org, clientRequestId)`
  // 生成（spec §2.3），客户端拼的那条路径没有消费方。留着形参是为了让调用点一字不改。
  const presigned = await apiSend<PresignResponse>('/guest/attachments', 'POST', {
    clientRequestId: currentClientRequestId(),
    contentType: file.type,
    sizeBytes: file.size,
  })

  // 直传：字节从客户端直达 ZOS，平台全程不过手（spec §2.3）
  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  // ⚠️ 直传失败必须**上抛**：预签名成功只代表「拿到了一张票」，票没核销就没有对象。
  //    静默吞掉会留下一张永远看不到图的工单（比报错难查得多）。
  if (!put.ok) throw new ApiError(put.status, `UPLOAD_${put.status}`)

  return { id: presigned.id, objectKey: presigned.objectKey }
}

export const uploadImage = upload
export const uploadFile = upload
