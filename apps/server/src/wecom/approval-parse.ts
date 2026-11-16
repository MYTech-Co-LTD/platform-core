// approval-parse.ts — 企微审批状态变更回调（解密后的 inner XML）解析（OA P2 Task 3）
//
// 不引入 XML 依赖：企微回调是扁平（+ 一层 Applyer）的固定结构，用按标签取值即可；
// 需要的语义不是「通用 XML 解析」，而是「按双形标签取已知字段」。
//
// 双形兼容（真实标签大小写/下划线以 T1 抓包为准，T1 完成前两者都认）：
//   SpNo|sp_no、SpStatus|sp_status、TemplateId|template_id、ApplyTime|apply_time、
//   FromUserName|from_user_name、AgentID|AgentId|agent_id、Event|event。
//
// 未知事件返回 null —— 「不静默」：调用方据此落 attention/告警，而不是当成已知事件继续。

/** 已知的审批状态变更事件（T1 确认前两者都收）。 */
export const SUPPORTED_APPROVAL_EVENTS = ['sys_approval_change', 'open_approval_change'] as const

export type SupportedApprovalEvent = (typeof SUPPORTED_APPROVAL_EVENTS)[number]

export interface ApprovalChange {
  event: SupportedApprovalEvent
  /** 审批单号（企微 SpNo）。 */
  spNo: string | undefined
  /** 企微状态码（1 审批中 / 2 已同意 / 3 已驳回 / 4 已撤销 …，码表以 T1 为准）。 */
  spStatus: number | undefined
  /** 审批模板 id（用于绑定 approval_def(provider=wecom_native)）。 */
  templateId: string | undefined
  /** 发起时间（Unix 秒）。 */
  applyTime: number | undefined
  /** 发起人：优先 ApprovalInfo/Applyer/UserId；无该节点时回落 FromUserName。 */
  requester: string | undefined
  /** 企微应用 AgentID（用于反查租户）。 */
  agentId: number | undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 按标签名取第一个非空值（大小写不敏感；支持 `<![CDATA[...]]>` 与纯文本，值 trim）。
 * 标签名按给定顺序尝试，先命中先返回 —— 用于 CamelCase / snake_case 双形。
 */
function pickTag(xml: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const tag = escapeRegExp(name)
    const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, 'i')
    const match = re.exec(xml)
    if (!match) continue
    const value = (match[1] ?? match[2] ?? '').trim()
    if (value !== '') return value
  }
  return undefined
}

/** 发起人优先取嵌套的 `<Applyer><UserId>`（真实回调里 FromUserName 是 `sys`）。 */
function pickApplyerUserId(xml: string): string | undefined {
  const block = /<Applyer>([\s\S]*?)<\/Applyer>/i.exec(xml)?.[1]
  if (!block) return undefined
  return pickTag(block, ['UserId', 'userid'])
}

/** 只接受十进制整数；其余（空 / 非数字 / 溢出）一律 undefined，不产出 NaN。 */
function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^-?\d+$/.test(value)) return undefined
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * 解析解密后的回调 inner XML。
 * 未知事件 / 缺 Event / 非 XML ⇒ null（调用方决定落 attention，不静默丢弃）。
 */
export function parseApprovalChange(xml: string): ApprovalChange | null {
  if (typeof xml !== 'string' || xml.trim() === '') return null

  const event = pickTag(xml, ['Event'])
  if (!event || !(SUPPORTED_APPROVAL_EVENTS as readonly string[]).includes(event)) return null

  return {
    event: event as SupportedApprovalEvent,
    spNo: pickTag(xml, ['SpNo', 'sp_no']),
    spStatus: toInt(pickTag(xml, ['SpStatus', 'sp_status'])),
    templateId: pickTag(xml, ['TemplateId', 'template_id']),
    applyTime: toInt(pickTag(xml, ['ApplyTime', 'apply_time'])),
    requester: pickApplyerUserId(xml) ?? pickTag(xml, ['FromUserName', 'from_user_name']),
    agentId: toInt(pickTag(xml, ['AgentID', 'agent_id'])),
  }
}
