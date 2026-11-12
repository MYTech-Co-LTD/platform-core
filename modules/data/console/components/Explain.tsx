// components/Explain.tsx — 术语问号（Wave 4.4）：把「工程词」的解释收在一处。
//
// 用 antd Tooltip 而不是 Popover：默认层只该「悬停/点一下看到一句话」，不该打断阅读。
// 术语未登记 ⇒ **不渲染**（而不是渲染一个空提示）——见 `lib/explain.ts` 的 `termEntry`。
import { Tooltip } from 'antd'
import { termEntry } from '../lib/explain'

export function Explain({ term, children }: { term: string; children?: React.ReactNode }) {
  const entry = termEntry(term)
  if (entry === null) return <>{children ?? null}</>
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {children ?? entry.label}
      <Tooltip title={`${entry.label}：${entry.text}`}>
        <span
          aria-label={`解释：${entry.label}`}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, marginLeft: 3, borderRadius: '50%',
            border: '1px solid #C4C8D0', color: '#8A9099', fontSize: 10,
            lineHeight: 1, cursor: 'help', userSelect: 'none', verticalAlign: 'middle',
          }}
        >?</span>
      </Tooltip>
    </span>
  )
}
