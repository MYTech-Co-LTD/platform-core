// agent-message.ts — 通用消息 `ext.<namespace>.message` 的内置声明与文案（N2）。
//
// 事件仍然入 outbox、走规则/模板；只是声明/模板/默认规则由平台在 namespace 开通时 seed，
// agent 一次 `POST /agent/messages` 就能发（默认 in-app，外发仍受通道权限约束）。
import type { NotificationEventDecl } from '@platform/sdk'

export const AGENT_MESSAGE_EVENT = 'message'

export function agentMessageKey(namespace: string): string {
  return `ext.${namespace}.${AGENT_MESSAGE_EVENT}`
}

export function isAgentMessageKey(key: string): boolean {
  const parts = key.split('.')
  return parts.length === 3 && parts[0] === 'ext' && parts[2] === AGENT_MESSAGE_EVENT
}

export function agentMessageTemplateKey(namespace: string): string {
  return `agent_generic_message__${namespace}`
}

/** 系统 seed 的默认规则 id（`derived:` 前缀 = 客户端不可覆盖）。 */
export function agentMessageRuleId(namespace: string): string {
  return `derived:ext:${namespace}.${AGENT_MESSAGE_EVENT}:*`
}

/** 通用消息的事件声明（与 manifest 同形；由 ensureAgentMessageDefaults 写入 event_decl）。 */
export function agentMessageDecl(namespace: string): NotificationEventDecl {
  return {
    key: agentMessageKey(namespace),
    title: '通用消息',
    description: 'agent 一次性消息（默认 in-app）',
    payload: {
      to: { type: 'user_list', required: true, label: '收件人' },
      title: { type: 'string', required: true, label: '标题' },
      body: { type: 'string', required: true, label: '正文' },
      link: { type: 'url', label: '链接' },
    },
    recipients: { to: { kind: 'field', field: 'to' } },
    defaults: {
      recipient: 'to',
      template: agentMessageTemplateKey(namespace),
      channels: ['inapp_default'],
    },
  }
}

/** 内置文案：link 可选；wecom markdown 链接闭合（#44 教训）。 */
export const AGENT_MESSAGE_CONTENTS: Record<string, Record<string, string>> = {
  wecom_chat: {
    text: '{{title}}\n{{body}}{{#if link}}\n👉 [查看详情]({{link}}){{/if}}',
  },
  in_app: {
    title: '{{title}}',
    body: '{{body}}',
    link: '{{#if link}}{{link}}{{/if}}',
  },
}
