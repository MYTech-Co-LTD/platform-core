// domain/wecom-binding.ts — 标准审批（企微）绑定资产的形状校验（OA P2 Task 6 / issue #2385）。
//
// 绑定 = 「平台代理到企微原生审批模板」的**快照**：processCode 指到企微侧模板，deepLink 是
// agent/console 给用户的直达入口，verifiedChain/verifiedAt 是「这条绑定被真实验证过」的证据链。
// 它**不是**应用内审批的节点链 DSL（那是 domain/approval.ts 的 inapp 分支）——两条校验路径
// 互不代入：绑定 body 跑 validateWecomBinding，绝不跑节点校验（否则绑定必被 nodes 缺失拒掉）。
//
// 纪律：
//   · 纯函数（不碰 DB / Hono）：发布门、路由、对账脚本共用同一把尺子；
//   · 失败返回机检 code + detail（routes 直接映射 HTTP/warn），不抛错；
//   · 时间一律 RFC3339（带时区；平台写入用 Z/UTC，见 P2 计划 Global Constraints）。

export interface WecomBindingBody {
  provider: 'wecom_native'
  /** 企微审批模板编号（template_id / process_code，T1 取证口径） */
  processCode: string
  /** 直达企微审批的深链（https；agent 选模板后原样回给用户） */
  deepLink: string
  /** 绑定的人话名称（agent 选模板/console 列表用） */
  name: string
  /** 验证证据链（文本条目：谁在何时用哪条真实审批验过）——空 = 没验证过，不许发布 */
  verifiedChain: string[]
  /** 最近一次验证时间（RFC3339） */
  verifiedAt: string
}

export type WecomBindingResult =
  | { ok: true; body: WecomBindingBody }
  | { ok: false; code: string; detail: string }

/** 事项模板上的绑定引用（mode=approval + provider=wecom_native 才读）。 */
export interface ItemWecomRef {
  id: string
  version: number
}

export type ItemWecomRefResult =
  | { ok: true; ref: ItemWecomRef }
  | { ok: false; code: string; detail: string }

const ASSET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
/** RFC3339：日期 T 时间 + 亚秒（可选）+ 显式时区（Z 或 ±HH:MM）。**不接受裸本地时间**。 */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** 只看 provider 的粗判（列表/路由分流用；完整校验仍走 validateWecomBinding）。 */
export function isWecomBindingBody(v: unknown): boolean {
  return isObj(v) && v['provider'] === 'wecom_native'
}

function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname.length > 0
  } catch {
    return false
  }
}

export function validateWecomBinding(input: unknown): WecomBindingResult {
  if (!isObj(input)) {
    return { ok: false, code: 'BINDING_INCOMPLETE', detail: '绑定 body 必须是对象' }
  }
  if (input['provider'] !== 'wecom_native') {
    return {
      ok: false,
      code: 'BINDING_PROVIDER_INVALID',
      detail: `provider 必须是 wecom_native（当前 ${String(input['provider'])}）`,
    }
  }
  const processCode = input['processCode']
  if (!nonEmpty(processCode)) {
    return { ok: false, code: 'BINDING_INCOMPLETE', detail: '缺 processCode（企微审批模板编号）' }
  }
  const name = input['name']
  if (!nonEmpty(name)) {
    return { ok: false, code: 'BINDING_INCOMPLETE', detail: '缺 name（绑定的人话名称）' }
  }
  const chain = input['verifiedChain']
  if (!Array.isArray(chain) || chain.length === 0 || !chain.every(nonEmpty)) {
    return {
      ok: false,
      code: 'BINDING_INCOMPLETE',
      detail: 'verifiedChain 必须是非空的文本条目数组（没验证过的绑定不许发布）',
    }
  }
  const deepLink = input['deepLink']
  if (typeof deepLink !== 'string' || !isHttpsUrl(deepLink)) {
    return { ok: false, code: 'BINDING_DEEPLINK_INVALID', detail: 'deepLink 必须是 https URL' }
  }
  const verifiedAt = input['verifiedAt']
  if (typeof verifiedAt !== 'string' || !RFC3339_RE.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) {
    return {
      ok: false,
      code: 'BINDING_VERIFIED_AT_INVALID',
      detail: 'verifiedAt 必须是 RFC3339 时间（带时区，如 2026-11-16T10:00:00Z）',
    }
  }
  return {
    ok: true,
    body: {
      provider: 'wecom_native',
      processCode: processCode.trim(),
      deepLink: deepLink.trim(),
      name: name.trim(),
      verifiedChain: chain.map((s) => (s as string).trim()),
      verifiedAt,
    },
  }
}

/**
 * 事项模板（`mode=approval` + `provider=wecom_native`）上的绑定引用。
 * 与 storage.itemApprovalRefOf 的 inapp 版本同形不同路：这里**接受** wecom_native，
 * 且引用目标是**绑定资产**（kind 仍是 approval_def）。
 */
export function itemWecomRefOf(body: unknown): ItemWecomRefResult {
  const ref = isObj(body) ? body['approvalRef'] : undefined
  if (!isObj(ref) || typeof ref['id'] !== 'string' || !ASSET_ID_RE.test(ref['id'])) {
    return {
      ok: false,
      code: 'APPROVAL_REF_INVALID',
      detail: 'provider=wecom_native 需要 approvalRef.id（形如 expense）',
    }
  }
  const version = ref['version']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, code: 'APPROVAL_REF_INVALID', detail: 'approvalRef.version 必须是 >=1 的整数' }
  }
  return { ok: true, ref: { id: ref['id'], version } }
}
