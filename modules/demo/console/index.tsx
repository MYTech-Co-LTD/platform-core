// console/index.tsx — 演示模块的 console 页（Task 19）：接入协议首个前端用例。
//
// 模块页只写业务：HTTP 走 platformFetch（会话 cookie + 401 统一跳登录都由它管），
// 权限判定只读 Console 壳经 Outlet 注入的 session.scopes——不 import apps/web 的
// 任何类型（模块 → 宿主应用零反向依赖），只本地声明用到的结构子集。
import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Button, Card, Input, Typography } from 'antd'
import { platformFetch } from '@platform/sdk/web'

/** Console 壳 Outlet context 的结构子集（壳侧真实形状见 apps/web ConsoleOutletContext） */
interface ConsoleContext {
  session: { scopes: string[] }
}

interface NoteRow {
  id: number
  body: string
  created_at: string
}

/** platformFetch 非 2xx → 可展示的错误文案（形状 {error}，模块 API 约定） */
async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
}

export default function DemoConsolePage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canNote = session.scopes.includes('demo:note')

  const [pingResult, setPingResult] = useState('（未调用）')
  const [pinging, setPinging] = useState(false)
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const loadNotes = async () => {
    const res = await platformFetch('/api/modules/demo/notes')
    if (!res.ok) {
      setNotes([])
      return
    }
    const body = (await res.json()) as { notes: NoteRow[] }
    setNotes(body.notes)
  }

  // 有 demo:note 权限才拉便签（无权限的人不该看到列表骨架/触发 403 噪音）
  useEffect(() => {
    if (canNote) void loadNotes()
  }, [canNote])

  const ping = async () => {
    setPinging(true)
    try {
      const res = await platformFetch('/api/modules/demo/ping')
      const text = res.ok ? JSON.stringify(await res.json(), null, 2) : await readError(res)
      setPingResult(text)
    } catch {
      setPingResult('NETWORK')
    } finally {
      setPinging(false)
    }
  }

  const addNote = async () => {
    const body = draft.trim()
    if (!body) return
    setSaving(true)
    try {
      const res = await platformFetch('/api/modules/demo/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (res.ok) {
        setDraft('')
        await loadNotes()
      } else {
        setPingResult(await readError(res))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="演示模块">
      <Typography.Paragraph type="secondary">
        接入协议演示：Ping 走模块 API（宿主注入身份），便签走模块迁移表。
      </Typography.Paragraph>
      <div style={{ marginBottom: 24 }}>
        <Button type="primary" loading={pinging} onClick={() => void ping()}>
          Ping
        </Button>
        <pre
          style={{
            marginTop: 12,
            padding: 12,
            background: '#f6f8fa',
            borderRadius: 6,
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {pingResult}
        </pre>
      </div>
      {canNote ? (
        <div>
          <Typography.Title level={5}>便签（demo:note）</Typography.Title>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Input
              placeholder="写点什么…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPressEnter={() => void addNote()}
            />
            <Button loading={saving} onClick={() => void addNote()}>
              添加便签
            </Button>
          </div>
          {/* antd 6.6 起 List 已弃用，演示页用素列表（模块页不该给后来者留弃用告警） */}
          <div
            style={{
              border: '1px solid #f0f0f0',
              borderRadius: 6,
              padding: notes.length === 0 ? '12px 16px' : '4px 16px',
            }}
          >
            {notes.length === 0 ? (
              <Typography.Text type="secondary">暂无便签</Typography.Text>
            ) : (
              notes.map((n) => (
                <div
                  key={n.id}
                  style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}
                >
                  <Typography.Text>#{n.id} {n.body}</Typography.Text>
                  <Typography.Text type="secondary">{n.created_at}</Typography.Text>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </Card>
  )
}
