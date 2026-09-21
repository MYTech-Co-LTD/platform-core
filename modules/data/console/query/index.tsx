// console/query/index.tsx —— 通道 A 的对话 UI。
// ⚠️ 用 fetch + ReadableStream 读 SSE，**不用 EventSource**：EventSource 只能 GET，
// 带不了 POST body，而且不能带自定义头/JSON。
import { useState } from 'react'
import { Alert, Button, Card, Input, Space, Table, Typography } from 'antd'
import { platformFetch } from '@platform/sdk/web'
import type { AgentEvent } from '../../domain/agent-loop'

interface Bubble { kind: 'user' | 'activity' | 'answer' | 'error'; text: string; table?: AgentEvent & { type: 'final' } }

/** 逐行解析 SSE：**必须按块缓冲**——一个 chunk 可能切开一行，也可能含多行。 */
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
      if (!line.startsWith('data:')) continue          // 空行/注释行（保活）跳过
      try {
        yield JSON.parse(line.slice(5).trim()) as AgentEvent
      } catch {
        // 单行坏了不该中断整条流；继续读下一行
      }
    }
  }
}

export default function QueryPage() {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])

  async function ask() {
    const q = question.trim()
    if (!q || busy) return
    setQuestion('')
    setBusy(true)
    setBubbles((b) => [...b, { kind: 'user', text: q }])
    try {
      const res = await platformFetch('/api/modules/data/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setBubbles((b) => [...b, { kind: 'error', text: body.error ?? `HTTP_${res.status}` }])
        return
      }
      for await (const ev of readEvents(res)) {
        if (ev.type === 'activity') setBubbles((b) => [...b, { kind: 'activity', text: `${ev.tool}：${ev.detail}` }])
        else if (ev.type === 'final') setBubbles((b) => [...b, { kind: 'answer', text: ev.text, table: ev }])
        else setBubbles((b) => [...b, { kind: 'error', text: ev.detail ?? ev.reason }])
      }
    } catch {
      setBubbles((b) => [...b, { kind: 'error', text: '连接中断' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space.Compact style={{ width: '100%' }}>
        <Input value={question} onChange={(e) => setQuestion(e.target.value)}
               onPressEnter={ask} placeholder="问点什么，例如：上个月各门店销售额" disabled={busy} />
        <Button type="primary" onClick={ask} loading={busy}>问数</Button>
      </Space.Compact>
      {bubbles.map((b, i) => (
        <Card key={i} size="small">
          {b.kind === 'answer' && b.table?.table ? (
            <>
              <Typography.Paragraph>{b.text}</Typography.Paragraph>
              <Table size="small" rowKey={(_, idx) => String(idx)}
                     columns={b.table.table.columns.map((c) => ({ title: c, dataIndex: c }))}
                     dataSource={b.table.table.rows.map((row) =>
                       Object.fromEntries(b.table!.table!.columns.map((c, ci) => [c, String(row[ci])])))}
                     pagination={false} />
            </>
          ) : b.kind === 'error' ? (
            <Alert type="error" message={b.text} showIcon />
          ) : (
            <Typography.Text type={b.kind === 'user' ? undefined : 'secondary'}>{b.text}</Typography.Text>
          )}
        </Card>
      ))}
    </Space>
  )
}
