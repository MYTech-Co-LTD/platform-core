// AskView.tsx — 移动端「问数」tab（报表中心三 tab 之一，#1369）。
//
// 复用 console 同一条通路：POST /api/modules/data/chat（SSE）。逐行解析必须按块缓冲
// （一个 chunk 可能切开一行，也可能含多行）——与 console/query 同一份解析逻辑的移动版。
// 权限：整个 App 已被 userApp.scope=data:query 门住；本页无管理动作，纯业务使用。
import { useCallback, useRef, useState } from 'react'
import { Button, Input, SpinLoading } from 'antd-mobile'
import type { AgentEvent } from '../../domain/agent-loop'
import { C, Icon, cardStyle, radius } from './ui'

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
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 58px - env(safe-area-inset-bottom, 0px))' }}>
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {bubbles.length === 0 && !busy ? (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>可以这样问</div>
            <div style={{ fontSize: 12, color: C.mute, marginTop: 4, lineHeight: 1.6 }}>
              用自然语言问指标、门店和期间，答案只来自有权限的指标。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
              {SUGGESTIONS.map((sug) => (
                <button
                  className="m-card-btn"
                  key={sug}
                  type="button"
                  onClick={() => void ask(sug)}
                  style={{
                    ...cardStyle, textAlign: 'left', padding: '14px 16px', fontSize: 14,
                    cursor: 'pointer', color: C.ink, display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', gap: 12, lineHeight: 1.55,
                  }}
                >
                  <span>{sug}</span>
                  <Icon name="chevron" size={16} color={C.mute} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {bubbles.map((b, i) => (
              <div
                key={i}
                style={{
                  alignSelf: b.kind === 'user' ? 'flex-end' : 'stretch',
                  maxWidth: b.kind === 'user' ? '82%' : '100%',
                  background: b.kind === 'user' ? C.accentDeep : C.surface,
                  color: b.kind === 'user' ? '#FFFFFF'
                    : b.kind === 'error' ? C.danger : b.kind === 'activity' ? C.mute : C.ink,
                  borderRadius: b.kind === 'user' ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
                  padding: '11px 14px',
                  fontSize: b.kind === 'activity' ? 12 : 14, lineHeight: 1.7,
                  border: b.kind === 'user' ? 'none' : `1px solid ${C.lineSoft}`,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {b.text}
                {b.table ? (
                  <div style={{ marginTop: 10, overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
                      <thead>
                        <tr>
                          {b.table.columns.map((c) => (
                            <th key={c} style={{
                              borderBottom: `1px solid ${C.line}`, padding: '6px 10px',
                              background: C.lineSoft, textAlign: 'left', color: C.sub, fontWeight: 600,
                              whiteSpace: 'nowrap',
                            }}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {b.table.rows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td key={ci} style={{
                                borderBottom: `1px solid ${C.lineSoft}`, padding: '6px 10px',
                                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                              }}>{String(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ))}
            {busy ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
                <SpinLoading style={{ '--size': '16px', '--color': C.accent }} />
                <span style={{ fontSize: 12, color: C.mute }}>正在查数…</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div style={{
        display: 'flex', gap: 10, padding: '10px 16px',
        background: 'rgba(255,255,255,0.96)',
        borderTop: `1px solid ${C.line}`,
        backdropFilter: 'saturate(160%) blur(14px)', WebkitBackdropFilter: 'saturate(160%) blur(14px)',
      }}>
        <Input
          placeholder="问点什么，例如：上个月各门店销售额"
          value={question}
          onChange={setQuestion}
          disabled={busy}
          onEnterPress={() => void ask()}
          style={{
            flex: 1, '--placeholder-color': C.mute, '--font-size': '14px',
            background: C.bg, borderRadius: radius.field, border: `1px solid ${C.line}`,
            padding: '0 12px', height: 42,
          }}
        />
        <Button
          color="primary"
          onClick={() => void ask()}
          loading={busy}
          disabled={!question.trim()}
          style={{
            borderRadius: radius.field, minWidth: 64, height: 42,
            '--background-color': C.accent, '--border-color': C.accent,
            fontWeight: 600, fontSize: 14,
          }}
        >问数</Button>
      </div>
    </div>
  )
}
