// console/lib/api.ts —— 模块 API 薄封装：前缀拼接、错误体翻译、非 JSON 回落。
// 契约照 modules/aftersales/console/lib/api.ts（同一套语义，别改形状）——但**各模块一份**，
// 模块之间不互相依赖（B1），所以这里整文件复制语义而不 import aftersales。
import { platformFetch } from '@platform/sdk/web'

/** 三同纪律：模块 id = DB schema = API 前缀。 */
const PREFIX = '/api/modules/data'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return new ApiError(res.status, typeof body.error === 'string' ? body.error : `HTTP_${res.status}`)
  } catch {
    // 响应体不是 JSON（edge 502 的 HTML 页等）⇒ 回落成状态码，**不因解析失败吞掉状态**
    return new ApiError(res.status, `HTTP_${res.status}`)
  }
}

export async function apiGet(path: string): Promise<unknown> {
  const res = await platformFetch(PREFIX + path)
  if (!res.ok) throw await toError(res)
  return res.json()
}

export async function apiSend(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<unknown> {
  const res = await platformFetch(PREFIX + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
  if (!res.ok) throw await toError(res)
  return res.status === 204 ? undefined : res.json()
}

const MESSAGES: Record<string, string> = {
  INVALID_BODY: '输入不合法，请检查后重试',
  NOT_FOUND: '目标不存在或已被删除',
  LLM_UNCONFIGURED: '本站未开启智能问数（未配置 LLM）',
  AGENT_FAILED: '问数过程中出错了，请稍后重试',
}

/** 已知码给中文文案；未知码回落成码本身（便于排障）。 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.code
  return '网络异常，请稍后重试'
}
