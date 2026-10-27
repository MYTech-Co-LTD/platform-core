// template.test.ts — 模板内容校验（变量子集 / 渲染 / 长度 / 链接）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import { samplePayload, validateContents } from './template'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: {
    title: { type: 'string' },
    link: { type: 'url' },
    assignee: { type: 'user' },
  },
  recipients: {},
}

describe('samplePayload', () => {
  it('按字段类型给样例', () => {
    expect(samplePayload(decl)).toEqual({
      title: 'sample', link: 'https://example.com', assignee: 'sample',
    })
  })
})

describe('validateContents', () => {
  it('变量都是声明字段 ⇒ 通过', () => {
    expect(validateContents(
      { wecom_chat: { text: '【T】{{title}}\n👉 [去]({{link}})' } }, decl, ['wecom_chat'],
    )).toEqual([])
  })

  it('未知变量 ⇒ unknown_variable', () => {
    expect(validateContents(
      { wecom_chat: { text: '{{nope}}' } }, decl, ['wecom_chat'],
    )).toContain('unknown_variable:nope')
  })

  it('启用通道缺内容 ⇒ missing_channel', () => {
    expect(validateContents({}, decl, ['in_app'])).toContain('missing_channel:in_app')
  })

  it('企微超长 ⇒ too_long', () => {
    expect(validateContents(
      { wecom_chat: { text: 'x'.repeat(4000) } }, decl, ['wecom_chat'],
    )).toContain('too_long:wecom_chat.text')
  })

  it('in_app 标题/正文超长 ⇒ too_long', () => {
    const long = 'x'.repeat(80)
    const issues = validateContents(
      { in_app: { title: long, body: 'x'.repeat(600), link: 'https://x' } },
      decl, ['in_app'],
    )
    expect(issues).toContain('too_long:in_app.title')
    expect(issues).toContain('too_long:in_app.body')
  })

  it('link 非 https ⇒ link_not_https', () => {
    expect(validateContents(
      { in_app: { title: 'T', body: 'B', link: 'http://x' } }, decl, ['in_app'],
    )).toContain('link_not_https')
  })
})
