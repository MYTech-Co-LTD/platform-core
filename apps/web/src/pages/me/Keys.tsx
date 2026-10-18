// pages/me/Keys.tsx — 个人 Key（PAT，通道 B）。issue #894，正典 §1.5。
//
// **免 scope**：任何已认证账号都能管自己的 token——发 token 不提权（它只承载本账号自己的
// Casdoor scopes，能做什么仍由权限实时决定）。故本页**不套 AdminGate**。
//
// 明文 token **只在创建响应里出现一次**：页面用一个一次性弹窗显示，刷新即失（库里只有哈希）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography, message } from 'antd'
import { createMyKey, listMyKeys, revokeMyKey, type ApiKeyRow } from '../../lib/api'

export default function MyKeysPage() {
  const [rows, setRows] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [once, setOnce] = useState<string | null>(null) // 只显示一次的明文 token

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows((await listMyKeys()).keys)
    } catch (e) {
      message.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const onCreate = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return message.warning('请先填一个名称（便于日后辨认这把 Key）')
    try {
      const r = await createMyKey(trimmed)
      setOnce(r.token)
      setName('')
      await load()
    } catch (e) {
      message.error(`创建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onRevoke = async (id: number) => {
    try {
      await revokeMyKey(id)
      message.success('已吊销（立即生效）')
      await load()
    } catch (e) {
      message.error(`吊销失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <Typography.Title level={4}>个人 Key</Typography.Title>
      <Typography.Paragraph type="secondary">
        用于<Typography.Text strong>外部 agent</Typography.Text>（如 Claude Code 经 MCP）代表你操作平台。
        它承载的是<Typography.Text strong>你自己的权限</Typography.Text>——能做什么由你的账号权限实时决定；
        吊销<Typography.Text strong>立即生效</Typography.Text>。
      </Typography.Paragraph>

      <Space style={{ marginBottom: 12 }}>
        <Input
          placeholder="名称（如：我的笔记本 / CI）"
          value={name}
          maxLength={64}
          style={{ width: 260 }}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void onCreate()}
        />
        <Button type="primary" onClick={() => void onCreate()}>
          生成
        </Button>
      </Space>

      <Table<ApiKeyRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        size="small"
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '创建于', dataIndex: 'createdAt', width: 200 },
          {
            title: '最近使用',
            dataIndex: 'lastUsedAt',
            width: 200,
            render: (v: string | null) => v ?? '—',
          },
          {
            title: '状态',
            dataIndex: 'revoked',
            width: 90,
            render: (revoked: boolean) => (revoked ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag>),
          },
          {
            title: '操作',
            width: 90,
            render: (_, r) =>
              r.revoked ? null : (
                <Button danger size="small" type="link" onClick={() => void onRevoke(r.id)}>
                  吊销
                </Button>
              ),
          },
        ]}
      />

      <Modal
        open={once !== null}
        title="请立即复制——它只显示这一次"
        onCancel={() => setOnce(null)}
        onOk={() => setOnce(null)}
        okText="我已复制"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="离开本页后无法再次查看"
          description="平台只保存它的哈希；丢失只能吊销后重建。"
        />
        <Typography.Paragraph copyable={{ text: once ?? '' }} code style={{ wordBreak: 'break-all' }}>
          {once}
        </Typography.Paragraph>
      </Modal>
    </>
  )
}
