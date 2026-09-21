// console/keys/index.tsx — 我的问数 Key（调 T7 的 /keys 端点）。
// 明文 token **只此一次**：创建响应里带一次，关掉 Modal 后不可再取（库里只有 sha256）。
import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Table, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

interface KeyRow { id: number; name: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }

export default function KeysPage() {
  const [rows, setRows] = useState<KeyRow[]>([])
  const [name, setName] = useState('')
  const [once, setOnce] = useState<string | null>(null)     // 明文 token：**只在内存里**，刷新即失
  const [messageApi, ctx] = message.useMessage()

  const load = () => apiGet('/keys')
    .then((b) => setRows((b as { keys: KeyRow[] }).keys))
    .catch((e) => messageApi.error(messageOf(e)))

  useEffect(() => { void load() }, [])

  async function create() {
    try {
      const b = (await apiSend('/keys', 'POST', { name: name.trim() })) as { token: string }
      setOnce(b.token)
      setName('')
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  async function revoke(id: number) {
    try { await apiSend(`/keys/${id}`, 'DELETE'); await load() }
    catch (e) { messageApi.error(messageOf(e)) }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Space.Compact>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key 名称，例如：我的 Claude Code"
               maxLength={64} />
        <Button type="primary" onClick={create} disabled={!name.trim()}>生成</Button>
      </Space.Compact>
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: '名称', dataIndex: 'name' },
        { title: '创建于', dataIndex: 'createdAt' },
        { title: '最近使用', dataIndex: 'lastUsedAt', render: (v: string | null) => v ?? '从未使用' },
        { title: '操作', render: (_: unknown, r: KeyRow) =>
            r.revoked ? '已吊销' : <Button danger size="small" onClick={() => revoke(r.id)}>吊销</Button> },
      ]} />
      {/* 明文 token **只在这一处**出现；关掉即不可再取（库里只有 sha256） */}
      <Modal open={once !== null} title="请立即复制——这条 Key 只显示这一次"
             onCancel={() => setOnce(null)} onOk={() => setOnce(null)} okText="我已保存">
        <Typography.Paragraph copyable={{ text: once ?? '' }} code>{once}</Typography.Paragraph>
        <Alert type="warning" showIcon message="关闭后无法再查看，只能重新生成。" />
      </Modal>
    </Space>
  )
}
