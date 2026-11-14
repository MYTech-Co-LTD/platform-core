// agent-event.ts — 租户/agent 事件声明的校验与版本 diff（N1）。
//
// 校验**复用 SDK 的 ManifestSchema**：用一个 synthetic manifest（id='ext'）包住单条声明，
// 这样 payload/recipients/defaults/scope 的语义与模块 manifest 完全同源，不另写一套。
// 代价：namespace 段必须是 snake_case（与事件 key 的段字符集一致），不支持 kebab-case。
//
// 版本纪律：payload/recipients **只增不改**；任何破坏性变更都要求换新 key。
import { ManifestSchema, type NotificationEventDecl } from '@platform/sdk'

/** namespace 段：与 manifest 事件 key 的段字符集一致。 */
export const NAMESPACE_RE = /^[a-z][a-z0-9_]{1,31}$/

/** 事件 key 必须是 `ext.<namespace>.<event>`（更细的校验交给 ManifestSchema）。 */
export function isAgentEventKey(key: string): boolean {
  return key.startsWith('ext.')
}

/**
 * 用 manifest 的同一套规则校验一条 agent 事件声明。
 * 返回问题清单（空 = 通过）；调用方把问题原样返回给 agent。
 */
export function validateAgentEventDecl(decl: NotificationEventDecl): string[] {
  const parsed = ManifestSchema.safeParse({
    id: 'ext',
    name: 'agent events',
    version: '0.0.0',
    platform: '>=0.1',
    permissions: [],
    notifications: { events: [decl] },
  })
  if (parsed.success) return []
  // synthetic manifest 的 id 恒为 'ext'，ManifestSchema 会把它当保留前缀拒掉；
  // 这是校验脚手架自身的 expected issue，过滤掉，其余（key/payload/recipients…）原样返回。
  return parsed.error.issues
    .filter((i) => !(i.path.length === 1 && i.path[0] === 'id'))
    .map((i) => `${i.path.join('.')}: ${i.message}`)
}

/**
 * 计算破坏性变更。空数组 = 可以原地升级（version+1）。
 *
 * 允许：新增 optional payload 字段、新增 recipient 档、改 label/description/title/defaults。
 * 拒绝：删字段、改 type/required、改 scope、删/改已有 recipient 的 kind/field/scope。
 */
export function diffAgentEventDecl(
  oldDecl: NotificationEventDecl,
  nextDecl: NotificationEventDecl,
): string[] {
  const issues: string[] = []
  if (oldDecl.key !== nextDecl.key) issues.push('key: changed')

  for (const [name, oldField] of Object.entries(oldDecl.payload)) {
    const nextField = nextDecl.payload[name]
    if (!nextField) {
      issues.push(`payload.${name}: removed`)
      continue
    }
    if (nextField.type !== oldField.type) issues.push(`payload.${name}.type: changed`)
    if (Boolean(nextField.required) !== Boolean(oldField.required)) {
      issues.push(`payload.${name}.required: changed`)
    }
  }
  for (const [name, nextField] of Object.entries(nextDecl.payload)) {
    if (oldDecl.payload[name]) continue
    if (nextField.required) issues.push(`payload.${name}: new required field`)
  }

  const oldScope = oldDecl.scope?.key
  const nextScope = nextDecl.scope?.key
  if (oldScope !== nextScope) issues.push('scope: changed')

  for (const [name, oldRecipient] of Object.entries(oldDecl.recipients)) {
    const nextRecipient = nextDecl.recipients[name]
    if (!nextRecipient) {
      issues.push(`recipients.${name}: removed`)
      continue
    }
    if (nextRecipient.kind !== oldRecipient.kind) issues.push(`recipients.${name}.kind: changed`)
    if (nextRecipient.field !== oldRecipient.field) issues.push(`recipients.${name}.field: changed`)
    if (nextRecipient.scope !== oldRecipient.scope) issues.push(`recipients.${name}.scope: changed`)
  }
  return issues
}
