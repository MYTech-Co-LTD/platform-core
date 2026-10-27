// template.ts — 模板内容校验（纯函数；预览/草稿/发布共用）。
// 单一渲染实现是 renderContents；本层只做「变量子集 + 渲染 + 长度/链接」的业务校验。
import type { NotificationEventDecl } from '@platform/sdk'
import { renderContents } from './render'

export function samplePayload(decl: NotificationEventDecl): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(decl.payload)) {
    out[k] = f.type === 'number' ? 1
      : f.type === 'boolean' ? true
      : f.type === 'user_list' ? ['u1']
      : f.type === 'url' ? 'https://example.com'
      : 'sample'
  }
  return out
}

/** 返回问题清单（空 = 通过）。未知变量、缺通道、超长、非 https 链接都会暴露。 */
export function validateContents(
  contents: Record<string, Record<string, string>>,
  decl: NotificationEventDecl,
  providers: string[],
): string[] {
  const issues: string[] = []
  const known = new Set(Object.keys(decl.payload))

  for (const fields of Object.values(contents)) {
    for (const tpl of Object.values(fields)) {
      for (const m of String(tpl).matchAll(/\{\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!known.has(m[1]!)) issues.push(`unknown_variable:${m[1]}`)
      }
    }
  }

  const rendered = renderContents(contents, samplePayload(decl), providers)
  if (!rendered.ok) {
    issues.push(...rendered.issues)
  } else {
    for (const [ch, fields] of Object.entries(rendered.rendered)) {
      if (ch === 'in_app') {
        if ([...(fields.title ?? '')].length > 64) issues.push('too_long:in_app.title')
        if ([...(fields.body ?? '')].length > 500) issues.push('too_long:in_app.body')
      }
      if (fields.link !== undefined && !/^https:\/\//.test(fields.link)) {
        issues.push('link_not_https')
      }
    }
  }

  return [...new Set(issues)]
}
