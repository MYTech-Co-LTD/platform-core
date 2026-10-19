// assignees.ts — §2.4「指派与催办」：名单**只存引用**，本体在受管数据集（字典）。
// 解析走与字段字典**同一套** `dictOptions`（不新增解析器）；key = Casdoor 用户名。
import type { Pool } from 'pg'
import { DICT_REF_RE } from './contract'
import { dictOptions, type DictScope } from '../storage'

export type Assignment = { dictRef: string; afterDays: number | null }

/**
 * 纯函数：从契约 body 取指派声明；无 `assignees` ⇒ `null`（该表单没有指派语义）。
 * 编译闸（compileGate ⑧⑨）已在发布前挡非法形状；此处再兜一次，保证解析侧不因脏 body 崩。
 */
export function parseAssignment(body: unknown): Assignment | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const a = (body as Record<string, unknown>)['assignees']
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return null
  const ref = (a as { dictRef?: unknown }).dictRef
  if (typeof ref !== 'string' || !DICT_REF_RE.test(ref)) return null
  const d = (body as Record<string, unknown>)['due']
  const n = d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as { afterDays?: unknown }).afterDays : undefined
  const afterDays = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
  return { dictRef: ref, afterDays }
}

/** 解析名单：dictRef → **已生效**（enabled）条目 key 列表（`dictOptions` 只返 enabled）。key = Casdoor 用户名。 */
export async function resolveAssigneeKeys(pool: Pool, org: string, dictRef: string): Promise<string[]> {
  const scope: DictScope = dictRef.startsWith('gdict:') ? 'global' : 'tenant'
  const dictId = dictRef.replace(/^(dict|gdict):/, '')
  const options = await dictOptions(pool, scope, scope === 'tenant' ? org : null, dictId)
  return options.map((o) => o.key)
}
