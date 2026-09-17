// storage-probe.ts — 存储配置的连通性探测（HeadBucket）。**只在请求路径之外调用**（裁定 5）。
//
// 为什么必须存在：预签名（SigV4）是**纯本地计算、不发网络请求** ⇒ 宿主**永远无法**在请求路径上发现
// 「配置存在但连不上」。那种错误只在客户端拿预签名 URL 直连对象存储时出现，平台侧零日志、零告警、各处都绿。
// ⇒ 探测点是**唯一**能在平台侧发现配置错的位置：管理端保存时（拒绝保存）+ 显式「测试连接」（事后场景：
// 桶被删 / AK 轮换 / 网络策略变更）。
//
// 为什么**不**在请求路径上探测：每请求一次网络往返，会把存储侧的抖动**放大成平台 5xx**，
// 且把一个可选依赖变成硬依赖。
//
// 超时是主动设的手段，不是默认值：管理端「保存」是同步等待，没有上界 = 页面挂到网关超时。
// ⚠️ **装上的那一版（@aws-sdk/client-s3 3.1131.0）实测核对过的三件事**（别照抄记忆改回去）：
//   ① `requestTimeout` **单独设不构成上界** —— 官方文档原文是 "If exceeded, a warning will be emitted
//      unless throwOnRequestTimeout=true"。实测：对「接受连接但永不响应」的服务端，只设 requestTimeout
//      会**无限挂起**（本文件写成时挂满 300s 仍未返回）。故必须同时给 `throwOnRequestTimeout: true`。
//   ② `connectionTimeout` 默认 0 = **关闭**，所以 3s 这个值是手段而非默认。
//   ③ 重试是 SDK 默认（maxAttempts 3）⇒ 真正的最坏耗时 ≈ 3 × REQUEST_TIMEOUT_MS 量级
//      （实测 1s 的 requestTimeout 三次≈3.1s），**有界但长达十几秒**——这是接受的代价：
//      保留重试是为了不让一次网络抖动被误报成「你的凭据不对」。
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { normalizeEndpoint, type TenantStorageConfig } from '@platform/sdk'

/** 失败档（有限枚举）。**为什么分类而不是透传**：回给前端的东西里不许有任何凭据/URL 细节。 */
export type ProbeFailure = {
  reason: 'TIMEOUT' | 'DNS' | 'TLS' | 'CONNECT' | 'HTTP_403' | 'HTTP_404' | 'HTTP_OTHER' | 'UNKNOWN'
  detail: string
}
export type ProbeResult = { ok: true } | ({ ok: false } & ProbeFailure)

const CONNECT_TIMEOUT_MS = 3_000
const REQUEST_TIMEOUT_MS = 5_000

export async function probeStorage(cfg: TenantStorageConfig): Promise<ProbeResult> {
  const endpoint = normalizeEndpoint(cfg.endpoint)
  const client = new S3Client({
    endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true, // 与 modules/aftersales/storage.ts 同一口径（ZOS 实测要求 path-style）
    // requestHandler 收**构造参数对象**（本版类型 `HttpHandlerUserInput` 含 `NodeHttpHandlerOptions`）
    requestHandler: {
      connectionTimeout: CONNECT_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      // 见文件头 ①：缺了这行，requestTimeout 只打 warning、请求永不返回
      throwOnRequestTimeout: true,
    },
  })
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
    return { ok: true }
  } catch (err) {
    return { ok: false, ...classify(err, endpoint) }
  } finally {
    client.destroy()
  }
}

/**
 * 分类：把 SDK 的错误收成**有限的几档**。理由不是整洁——是**回给前端的东西里不许有任何凭据**，
 * 而 SDK 的原始 message 可能带上 URL/签名细节。原始 message 只进服务端日志。
 *
 * ⚠️ 映射表是**实测**出来的（3.1131.0），不是按记忆写：网络类错误挂 `code`（`Error`/`ECONNREFUSED`），
 * 超时挂 `name='TimeoutError'`，HTTP 状态只挂在 `$metadata.httpStatusCode`（403 的 `name` 甚至是
 * `Unknown` —— 按 name 判 HTTP 档会错，故 HTTP 档一律先看状态码）。
 */
function classify(err: unknown, endpoint: string): ProbeFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>
  const code = typeof e.code === 'string' ? e.code : undefined
  const name = typeof e.name === 'string' ? e.name : undefined
  // detail 只放 `<endpoint 的 host>: <HTTP 状态或错误码>`：host 取 URL 的 host（不含 userinfo）
  const host = hostOf(endpoint)

  // HTTP 档优先：有状态码就说明 socket 通了，此时 code/name 都是噪声（403 的 name 实测是 'Unknown'）
  const status = httpStatusOf(e)
  if (status !== undefined) {
    if (status === 403) return { reason: 'HTTP_403', detail: `${host}: 403` }
    if (status === 404) return { reason: 'HTTP_404', detail: `${host}: 404` }
    return { reason: 'HTTP_OTHER', detail: `${host}: ${status}` }
  }
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return { reason: 'TIMEOUT', detail: `${host}: 超时` }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { reason: 'DNS', detail: `${host}: ${code}` }
  if (
    code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE'
    || code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
  ) {
    return { reason: 'CONNECT', detail: `${host}: ${code}` }
  }
  if (
    code !== undefined
    && (/^CERT_/.test(code) || /^UNABLE_TO/.test(code) || /^SELF_SIGNED/.test(code) || /^ERR_TLS_/.test(code)
      || code === 'EPROTO')
  ) {
    return { reason: 'TLS', detail: `${host}: ${code}` }
  }
  // detail 里给一个**分类标签**而不是 SDK 原文（原文可能带 URL/签名细节，只进服务端日志）
  return { reason: 'UNKNOWN', detail: `${host}: ${code ?? name ?? '未知错误'}` }
}

/** `$metadata.httpStatusCode`（SDK 把 HTTP 状态只挂在这里；实测 `$response` 也有但形状随版本变） */
function httpStatusOf(e: Record<string, unknown>): number | undefined {
  const meta = e.$metadata
  if (typeof meta !== 'object' || meta === null) return undefined
  const status = (meta as Record<string, unknown>).httpStatusCode
  return typeof status === 'number' ? status : undefined
}

/** endpoint → host（含端口，**不含 userinfo**——detail 会回给前端）。解析不了就退回原串。 */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}
