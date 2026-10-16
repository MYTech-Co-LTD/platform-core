// console/api.ts — console 页与模块 API 之间的薄层（issue #718）。
// HTTP 一律 platformFetch（会话 cookie / 401 统一跳登录由壳管）；错误按机检错误码透出。
// 铁律边界：**存储契约永不含值**（§2.4）；本文件的 injectDictEnums 造的是**渲染视图模型副本**
// ——值同源取自 /options（与服务端提交校验同一数据源），不回写、不落契约。
import { platformFetch } from '@platform/sdk/web'
import { DICT_REF_RE } from '../domain/contract'

export interface DefSummary {
  assetId: string
  headVersion: number | null
  draftCount: number
  publishedCount: number
  retiredCount: number
  updatedAt: string
}

export interface VersionInfo {
  version: number
  status: string
  createdBy: string
  publishedBy: string | null
  body: unknown
}

export interface OptionItem {
  key: string
  label: string
  sortNo: number
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

async function readBody(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
  const detail = typeof body?.detail === 'string' ? body.detail : undefined
  throw new ApiError(res.status, code, detail)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await platformFetch(path)
  if (!res.ok) await readBody(res)
  return (await res.json()) as T
}

export async function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await platformFetch(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
  if (!res.ok) await readBody(res)
  return (await res.json()) as T
}

export function parseDictRef(ref: string): { scope: 'tenant' | 'global'; dictId: string } | null {
  const m = DICT_REF_RE.exec(ref)
  if (!m) return null
  return { scope: m[1] === 'gdict' ? 'global' : 'tenant', dictId: m[2] }
}

/** 拉取一组字典引用的生效 options（渲染与提交校验同源——服务端 /options）。 */
export async function loadOptions(refs: string[]): Promise<Map<string, OptionItem[]>> {
  const out = new Map<string, OptionItem[]>()
  for (const ref of refs) {
    const parsed = parseDictRef(ref)
    if (!parsed) continue
    const base = parsed.scope === 'global' ? '/api/modules/forms/global-dicts' : '/api/modules/forms/dicts'
    const body = await apiGet<{ options: OptionItem[] }>(`${base}/${parsed.dictId}/options`)
    out.set(ref, body.options)
  }
  return out
}

/** 契约里出现过的字典引用（顶层属性；与服务端 dictRefs 同一判定语义的渲染侧版）。
 *  入参是**契约 body**（`{schema, uiSchema?}`，与 renderModelOf 同口径）。 */
export function schemaDictRefs(body: unknown): string[] {
  const props = ((body as { schema?: { properties?: unknown } } | null)?.schema)?.properties
  if (props === null || typeof props !== 'object') return []
  const refs: string[] = []
  for (const prop of Object.values(props as Record<string, unknown>)) {
    const rec = prop !== null && typeof prop === 'object' ? (prop as Record<string, unknown>) : undefined
    if (rec && typeof rec['x-dict'] === 'string') refs.push(rec['x-dict'])
  }
  return [...new Set(refs)]
}

/**
 * 渲染视图模型：把契约 body（`{schema, uiSchema?}`，#724 定案）变成 RJSF 直接可吃的一对，
 * 并**注入字典候选**——顶层 `required` 绑定的字段：值进 schema.enum、标签进 uiSchema
 * 的 `ui:options.enumNames`（副本，不改原契约）。open 绑定不注入（自由文本）。
 * 候选顺序 = options 的 (sort_no, key)（服务端已排序）。
 * ⚠️ RJSF v6 的标签来源是 **uiSchema 的 ui:options.enumNames**（@rjsf/utils optionsList
 * 走 getUiOptions，schema.enumNames 已不再消费——#718 真机截图实测）。
 */
export function renderModelOf(
  body: unknown,
  options: Map<string, OptionItem[]>,
): { schema: object; uiSchema: Record<string, unknown> } {
  const raw = (body ?? {}) as { schema?: unknown; uiSchema?: unknown }
  const copy = structuredClone(raw.schema ?? {}) as {
    properties?: Record<string, Record<string, unknown>>
  }
  // 契约自带的 uiSchema 是底，字典候选覆盖其上（同键合并，不丢契约里的其他 ui:* 设置）
  const uiSchema: Record<string, unknown> = structuredClone(
    (raw.uiSchema ?? {}) as Record<string, unknown>,
  )
  const props = copy.properties
  if (props !== undefined) {
    for (const [field, prop] of Object.entries(props)) {
      const ref = prop['x-dict']
      if (typeof ref !== 'string' || prop['x-binding'] !== 'required') continue
      const items = options.get(ref)
      if (items === undefined) continue
      prop['enum'] = items.map((o) => o.key)
      const prev = uiSchema[field]
      const base = prev !== null && typeof prev === 'object' && !Array.isArray(prev)
        ? (prev as Record<string, unknown>)
        : {}
      uiSchema[field] = { ...base, 'ui:options': { ...((base['ui:options'] as object) ?? {}), enumNames: items.map((o) => o.label) } }
    }
  }
  return { schema: copy, uiSchema }
}
