// render.test.ts — 模板渲染纯函数（预览与投递共用；2026-10-27 通知基础设施 §5.2）
import { describe, it, expect } from 'vitest'
import { renderContents } from './render'

const contents = {
  wecom_chat: { text: '【待审批】{{title}}\n👉 [去审批]({{link}})' },
  in_app: { title: '{{title}}', body: '申请人：{{applicant}}', link: '{{link}}' },
}

describe('renderContents', () => {
  it('按通道渲染（摊平变量、不转义 markdown）', () => {
    const r = renderContents(contents, { title: 'T', link: 'https://x', applicant: '张三' },
      ['wecom_chat', 'in_app'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rendered.wecom_chat.text).toBe('【待审批】T\n👉 [去审批](https://x)')
    expect(r.rendered.in_app.title).toBe('T')
  })

  it('未知变量 ⇒ 渲染错误（strict）', () => {
    const r = renderContents(contents, { title: 'T', link: 'https://x' }, ['wecom_chat', 'in_app'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.includes('applicant'))).toBe(true)
  })

  it('企微文案超长 ⇒ 错误（3800 字节上限）', () => {
    const r = renderContents({ wecom_chat: { text: 'x'.repeat(4000) } }, {}, ['wecom_chat'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.includes('too_long'))).toBe(true)
  })

  it('缺通道内容 ⇒ 错误', () => {
    const r = renderContents({ wecom_chat: { text: 'x' } }, {}, ['in_app'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.includes('missing_channel:in_app'))).toBe(true)
  })
})
