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
  // 报表面（#150 T7）。两码分开：没接 = 配置状态（运维该去配），调用失败 = 上游故障（该重试）
  METABASE_UNCONFIGURED: '本站未接报表服务（未配置 Metabase）',
  METABASE_ERROR: '报表服务暂时不可用，请稍后重试',
  TENANT_PARAM_RESERVED: 'tenant 参数由平台保留，不能自定义',
  // L2 派生指标（#150 T8）。逐码给文案：这几个都是**调用方改一下就能过**的错，
  // 回落成裸码（如 UNKNOWN_DIM）会让用户不知道该改什么——而这一页的用户正是要自己定义指标的人。
  L1_BASE_NOT_FOUND: '要派生的平台指标不存在（平台词表以 dbt 声明为准）',
  UNKNOWN_DIM: '用到了平台指标没有声明的维度，请从下拉里选',
  BAD_FILTER: '过滤条件不合法：用 = 只能给一个值，用 in 至少给一个值',
  ID_RESERVED_BY_L1: '这个 id 属于平台词表，不能占用（换一个 id）',
  READONLY_L1: '平台词表经 API 只读，改它要改 dbt 声明后重新物化',
  TARGET_NOT_SUPPORTED: '目标值当前没有存储位置，暂不支持',
  L1_BASE_SQL_INVALID: '平台指标的 SQL 形状不合契约，请联系平台侧处理',
  ID_MISMATCH: '路径 id 与提交内容不一致',
}

/** 已知码给中文文案；未知码回落成码本身（便于排障）。 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.code
  return '网络异常，请稍后重试'
}
