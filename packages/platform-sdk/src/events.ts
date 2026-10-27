// events.ts — 事件 payload 校验（宿主与模块共用的纯函数）。
// 形状契约在 manifest（NotificationEventDecl）；这里只做运行时校验，不碰 DB/HTTP。
import type { NotificationEventDecl } from './manifest'

const isType = (t: string, v: unknown): boolean => {
  switch (t) {
    case 'string':
    case 'date':
    case 'url':
    case 'user':
      return typeof v === 'string' && v.length > 0
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'user_list':
      return Array.isArray(v) && v.length > 0
        && v.every((x) => typeof x === 'string' && x.length > 0)
    default:
      return false
  }
}

/**
 * 返回 null = 通过；否则是**带字段名**的错误摘要（供日志/测试定位）。
 * 调用方对外只暴露 `payload_invalid` 这一档，不把内部摘要当 API。
 */
export function validatePayload(
  decl: NotificationEventDecl,
  payload: Record<string, unknown>,
): string | null {
  if (JSON.stringify(payload).length > 16 * 1024) return 'payload_too_large'
  for (const [k, f] of Object.entries(decl.payload)) {
    if (f.required && !(k in payload)) return `payload_missing:${k}`
    if (k in payload && !isType(f.type, payload[k])) return `payload_type:${k}`
  }
  return null
}
