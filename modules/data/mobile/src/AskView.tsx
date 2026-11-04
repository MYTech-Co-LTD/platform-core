// AskView.tsx — 移动端「问数」tab（报表中心三 tab 之一，#1369）。
//
// 复用 console 同一条通路：POST /api/modules/data/chat（SSE）。逐行解析必须按块缓冲
// （一个 chunk 可能切开一行，也可能含多行）——与 console/query 同一份解析逻辑的移动版。
// 权限：整个 App 已被 userApp.scope=data:query 门住；本页无管理动作，纯业务使用。
import { useCallback, useRef, useState } from 'react'
import { Button, Input, SpinLoading } from 'antd-mobile'
import type { AgentEvent } from '../../domain/agent-loop'

interface Bubble {
  kind: 'user' | 'activity' | 'answer' | 'error'
  text: string
  table?: { columns: string[]; rows: unknown[][] }
}

/** 逐行解析 SSE（按块缓冲）；单行坏了不中断整条流。 */
async function* readEvents(res: Response): AsyncGenerator<AgentEvent> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      try {
        yield JSON.parse(line.slice(5).trim()) as AgentEvent
      } catch {
        // 忽略坏行
      }
    }
  }
}

const SUGGESTIONS = [
  '上个月各门店销售额是多少',
  '本月会员复购率',
  '近 7 天销量最高的 10 个商品',
]

export default function AskView() {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  // 首次提问前给示例问题；提问后消失（列表底部自动滚到最新一条由浏览器默认行为即可）
  const listRef = useRef<HTMLDivElement>(null)

  const ask = useCallback(async (explicit?: string) => {
    const q = (explicit ?? question).trim()
    if (!q || busy) return
    setQuestion('')
    setBusy(true)
    setBubbles((b) => [...b, { kind: 'user', text: q }])
    try {
      const res = await fetch('/api/modules/data/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setBubbles((b) => [...b, { kind: 'error', text: body.error ?? `HTTP_${res.status}` }])
        return
      }
      for await (const ev of readEvents(res)) {
        if (ev.type === 'activity') {
          setBubbles((b) => [...b, { kind: 'activity', text: `${ev.tool}：${ev.detail}` }])
        } else if (ev.type === 'final') {
          setBubbles((b) => [...b, {
            kind: 'answer',
            text: ev.text,
            table: ev.table ?? undefined,
          }])
        } else {
          setBubbles((b) => [...b, { kind: 'error', text: ev.detail ?? ev.reason }])
        }
      }
    } catch {
      setBubbles((b) => [...b, { kind: 'error', text: '连接中断，请稍后重试' }])
    } finally {
      setBusy(false)
      // 新气泡出现后滚到底
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
      })
    }
  }, [busy, question])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 110px)' }}>
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        {bubbles.length === 0 && !busy ? (
          <div style={{ padding: '8px 0' }}>
            <div style={{ fontSize: 13, color: '#999' }}>可以这样问：</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {SUGGESTIONS.map((sug) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => void ask(sug)}
                  style={{
                    textAlign: 'left', padding: '12px 14px', fontSize: 14,
                    background: '#fff', border: '1px solid #eee', borderRadius: 10, cursor: 'pointer',
                    color: '#1f1f1f',
                  }}
                >{sug}</button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bubbles.map((b, i) => (
              <div
                key={i}
                style={{
                  alignSelf: b.kind === 'user' ? 'flex-end' : 'stretch',
                  maxWidth: b.kind === 'user' ? '80%' : '100%',
                  background: b.kind === 'user' ? '#1677ff' : '#fff',
                  color: b.kind === 'user' ? '#fff' : b.kind === 'error' ? '#ff4d4f' : '#1f1f1f',
                  borderRadius: 12, padding: '10px 12px',
                  fontSize: 14, lineHeight: 1.6,
                  border: b.kind === 'user' ? 'none' : '1px solid #f0f0f0',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {b.kind === 'activity' ? <span style={{ color: '#999' }}>{b.text}</span> : b.text}
                {b.table ? (
                  <div style={{ marginTop: 8, overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr>
                          {b.table.columns.map((c) => (
                            <th key={c} style={{ border: '1px solid #eee', padding: '4px 8px', background: '#fafafa', textAlign: 'left' }}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {b.table.rows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td key={ci} style={{ border: '1px solid #eee', padding: '4px 8px' }}>{String(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ))}
            {busy ? <div style={{ padding: 8 }}><SpinLoading style={{ '--size': '18px' }} /></div> : null}
          </div>
        )}
      </div>
      <div style={{
        display: 'flex', gap: 8, padding: '8px 12px',
        paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
        background: '#f5f5f5',
      }}>
        <Input
          placeholder="问点什么，例如：上个月各门店销售额"
          value={question}
          onChange={setQuestion}
          disabled={busy}
          onEnterPress={() => void ask()}
          style={{
            flex: 1, '--placeholder-color': '#bbb',
            background: '#fff', borderRadius: 10, border: '1px solid #e5e5e5',
          }}
        />
        <Button
          color="primary"
          onClick={() => void ask()}
          loading={busy}
          disabled={!question.trim()}
          style={{ borderRadius: 10, minWidth: 76, height: 44 }}
        >问数</Button>
      </div>
    </div>
  )
}
