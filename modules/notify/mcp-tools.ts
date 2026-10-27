// mcp-tools.ts — notify MCP 工具元数据（**纯**：无 Hono/pg 运行时依赖）。
// 供 scripts/check-mcp-toolface.mjs 静态检查；实现见 mcp.ts。
// 硬边界：没有 publish / channel 工具；没有「给别人试发」工具。

export const NOTIFY_MAX_TOOLS = 12

export type NotifyToolMeta = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutating: boolean
  annotations?: Record<string, unknown>
  requiredScope: string | null
}

const t = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  mutating: boolean,
  requiredScope: string | null,
): NotifyToolMeta => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  mutating,
  annotations: { readOnlyHint: !mutating },
  requiredScope,
})

const EVENT = { eventKey: { type: 'string' } }
const RULE_FIELDS = {
  eventKey: { type: 'string' },
  scope: { type: 'string' },
  recipientKey: { type: 'string' },
  recipientLiteral: { type: 'array', items: { type: 'string' } },
  templateKey: { type: 'string' },
  channels: { type: 'array', items: { type: 'string' } },
  cooldownMinutes: { type: 'number' },
}

export const NOTIFY_TOOLS: NotifyToolMeta[] = [
  t('list_events', '列出本租户可用的事件目录（建规则前先查）。', {}, [], false, null),
  t('get_event', '查看单个事件的 payload / 收件人 / 默认规则。', EVENT, ['eventKey'], false, null),
  t('list_rules', '列出通知规则。', {}, [], false, null),
  t('propose_rule', '创建一条通知规则（事件 × 作用域 × 收件人 × 模板 × 通道），即时生效、可一键停用。',
    RULE_FIELDS, ['eventKey', 'recipientKey', 'templateKey', 'channels'],
    true, 'notify:manage'),
  t('update_rule', '修改一条规则（字段同 propose_rule，另需 id）。',
    { id: { type: 'string' }, ...RULE_FIELDS }, ['id'], true, 'notify:manage'),
  t('set_rule_enabled', '启停一条规则。',
    { id: { type: 'string' }, enabled: { type: 'boolean' } }, ['id', 'enabled'],
    true, 'notify:manage'),
  t('list_templates', '列出模板与当前发布版本。', {}, [], false, null),
  t('get_template', '查看模板与全部 revision。', { key: { type: 'string' } }, ['key'], false, null),
  t('draft_template', '新建/更新模板草稿 revision（只写草稿，不发布）。',
    { key: { type: 'string' }, contents: { type: 'object' } }, ['key', 'contents'],
    true, 'notify:manage'),
  t('preview_template', '用样例 payload 渲染模板（纯预览，不外发）。',
    { key: { type: 'string' }, revision: { type: 'number' }, payload: { type: 'object' } },
    ['key', 'payload'], false, 'notify:manage'),
  t('list_deliveries', '查看投递回执与错误摘要。', { limit: { type: 'number' } }, ['limit'], false, null),
  t('send_test', '给自己试发一条（收件人强制为调用者本人）。',
    { templateKey: { type: 'string' }, channel: { type: 'string' }, payload: { type: 'object' } },
    ['templateKey', 'channel', 'payload'], true, 'notify:manage'),
]
