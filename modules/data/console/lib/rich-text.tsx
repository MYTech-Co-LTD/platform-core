// rich-text.tsx — 受限富文本的唯一渲染实现（R3 / L1）。
//
// 语法白名单（**不是 Markdown 全量实现**）：
//   `**粗体**` · `*斜体*` · `` `代码` `` · `[文字](https://…)` · 行首 `- ` 列表 ·
//   `# / ## / ###` 小标题 · 空行分段。
// 安全边界：**只产出 React 节点，绝不使用 innerHTML**；链接协议白名单 http/https，
// 外链一律 noopener noreferrer。语法之外的内容按纯文本渲染（不会被当成 HTML 执行）。
import type { ReactNode } from 'react'

/** 数字高亮（叙事用）：日期/时间保持原样，数值按符号着色。 */
const NUM_TOKEN = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d[\d,]*(?:\.\d+)?(?:%|pp|°C|℃|mm|cm|单|件|个|天|家)?/g

function withNumbers(s: string, keyPrefix: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let hit = false
  for (const m of s.matchAll(NUM_TOKEN)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (at > last) out.push(s.slice(last, at))
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok) || /^\d{1,2}:\d{2}/.test(tok)) {
      out.push(tok)
    } else {
      hit = true
      const color = tok.startsWith('-') ? '#cf1322' : tok.startsWith('+') ? '#389e0d' : '#1f1f1f'
      out.push(<strong key={`${keyPrefix}:${at}`} style={{ color, fontWeight: 600 }}>{tok}</strong>)
    }
    last = at + tok.length
  }
  if (!hit) return s
  if (last < s.length) out.push(s.slice(last))
  return <>{out}</>
}

/** 行内语法：粗体 / 斜体 / 代码 / 链接。嵌套只支持「粗体内数字高亮」这一层。 */
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g

function inline(text: string, keyPrefix: string, highlight: boolean): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (at > last) {
      const plain = text.slice(last, at)
      out.push(highlight ? withNumbers(plain, `${keyPrefix}:p${at}`) : plain)
    }
    if (tok.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}:b${at}`} style={{ fontWeight: 650 }}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={`${keyPrefix}:c${at}`} style={{
          background: '#f1f3f5', borderRadius: 4, padding: '1px 5px', fontSize: '0.92em',
          fontFamily: 'SFMono-Regular, Menlo, monospace',
        }}>{tok.slice(1, -1)}</code>,
      )
    } else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']'))
      const href = tok.slice(tok.indexOf('](') + 2, -1)
      out.push(
        <a key={`${keyPrefix}:a${at}`} href={href} target="_blank" rel="noopener noreferrer"
          style={{ color: '#0f766e', textDecoration: 'underline' }}>{label}</a>,
      )
    } else {
      out.push(<em key={`${keyPrefix}:i${at}`}>{tok.slice(1, -1)}</em>)
    }
    last = at + tok.length
  }
  if (last < text.length) {
    const plain = text.slice(last)
    out.push(highlight ? withNumbers(plain, `${keyPrefix}:p${last}`) : plain)
  }
  return out
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/
const BULLET_RE = /^\s*-\s+(.*)$/

/**
 * 受限富文本。`highlightNumbers` 只给叙事用（普通说明文字不需要数值着色）。
 * 块级解析按行：小标题 / 列表 / 空行分段；其余按段落。
 */
export function RichText({
  text, highlightNumbers = false,
}: { text: string; highlightNumbers?: boolean }): ReactNode {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  let paragraph: string[] = []

  const flushBullets = (): void => {
    if (bullets.length === 0) return
    blocks.push(
      <ul key={`ul:${blocks.length}`} style={{ margin: '6px 0', paddingLeft: 20 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ marginBottom: i === bullets.length - 1 ? 0 : 4, lineHeight: 1.8 }}>
            {inline(b, `li:${blocks.length}:${i}`, highlightNumbers)}
          </li>
        ))}
      </ul>,
    )
    bullets = []
  }
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const body = paragraph.join('\n')
    blocks.push(
      <p key={`p:${blocks.length}`} style={{ margin: '0 0 8px', lineHeight: 1.85 }}>
        {inline(body, `p:${blocks.length}`, highlightNumbers)}
      </p>,
    )
    paragraph = []
  }

  for (const line of lines) {
    const bullet = BULLET_RE.exec(line)
    if (bullet !== null) {
      flushParagraph()
      bullets.push(bullet[1] ?? '')
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      flushParagraph(); flushBullets()
      blocks.push(
        <p key={`h:${blocks.length}`} style={{
          margin: '4px 0 8px', lineHeight: 1.5,
          fontWeight: 650, fontSize: heading[1] === '#' ? 17 : heading[1] === '##' ? 16 : 15,
        }}>
          {inline(heading[2] ?? '', `h:${blocks.length}`, highlightNumbers)}
        </p>,
      )
      continue
    }
    if (line.trim() === '') {
      flushParagraph(); flushBullets()
      continue
    }
    flushBullets()
    paragraph.push(line)
  }
  flushParagraph(); flushBullets()
  return <>{blocks}</>
}
