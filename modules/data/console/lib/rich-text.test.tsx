// rich-text.test.tsx — 受限富文本（R3/L1）：白名单、外链安全、无 innerHTML。
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RichText } from './rich-text'

afterEach(cleanup)

describe('RichText', () => {
  it('行内：粗体 / 斜体 / 代码', () => {
    const { container } = render(<RichText text="**粗** *斜* `code`" />)
    expect(container.querySelector('strong')?.textContent).toBe('粗')
    expect(container.querySelector('em')?.textContent).toBe('斜')
    expect(container.querySelector('code')?.textContent).toBe('code')
  })

  it('链接：http(s) 才成链，外链带 noopener noreferrer', () => {
    const { container } = render(<RichText text="[报表](https://example.com/a)" />)
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/a')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a?.getAttribute('target')).toBe('_blank')
  })

  it('非 http 协议不成链（防 javascript:）', () => {
    const { container } = render(<RichText text="[坏](javascript:alert(1))" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('javascript:alert(1)')
  })

  it('块级：列表与小标题', () => {
    const { container } = render(<RichText text={'## 今日结论\n- 第一条\n- 第二条'} />)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.textContent).toContain('今日结论')
  })

  it('不渲染 HTML：标签按文本出现', () => {
    const { container } = render(<RichText text={'<img src=x onerror=alert(1)>'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img')
  })

  it('数字高亮只在开启时生效；日期不着色', () => {
    const on = render(<RichText text="下滑 -3.2%，日期 2026-11-05" highlightNumbers />)
    const strong = on.container.querySelectorAll('strong')
    expect(strong).toHaveLength(1)
    expect(strong[0]?.textContent).toBe('-3.2%')
    expect(strong[0]?.style.color).toBe('#cf1322')
    on.unmount()

    const off = render(<RichText text="下滑 -3.2%" />)
    expect(off.container.querySelector('strong')).toBeNull()
  })
})
