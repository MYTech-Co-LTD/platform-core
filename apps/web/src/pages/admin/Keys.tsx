// pages/admin/Keys.tsx — 全租户 Key 管理（`tenant:admin`）。issue #894，正典 §1.5 定案②。
//
// 只读 + 吊销：**不代建**（key 是「每个账号自己的」——代建等于把别人的凭据经你手发出去）。
// 门禁由 App.tsx 的 <AdminGate> 施加（本页不自判 scope，与其它管理页同构）。
import { useCallback, useEffect, useState } from 'react'
import { Button, Popconfirm, Table, Tag, Typography, message } from 'antd'
import { listAllKeys, revokeAnyKey, type AdminApiKeyRow } from '../../lib/api'

export default function AdminKeysPage() {
  const [rows, setRows] = useState<AdminApiKeyRow[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows((await listAllKeys()).keys)
    } catch (e) {
      message.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const onRevoke = async (id: number) => {
    try {
      await revokeAnyKey(id)
      message.success('已吊销（立即生效）')
      await load()
    } catch (e) {
      message.error(`吊销失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <Typography.Title level={4}>Key 管理</Typography.Title>
      <Typography.Paragraph type="secondary">
        本租户<Typography.Text strong>全部</Typography.Text>个人 Key。只可吊销，
        <Typography.Text strong>不可代建</Typography.Text>——Key 是账号自己的凭据，
        代建等于把别人的 token 经你手发出去。用户自助入口在「个人 Key」页。
      </Typography.Paragraph>

      <Table<AdminApiKeyRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        size="small"
        columns={[
          { title: '账号', dataIndex: 'casdoorUser', width: 160 },
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
                <Popconfirm title="吊销这把 Key？（立即生效）" onConfirm={() => void onRevoke(r.id)}>
                  <Button danger size="small" type="link">
                    吊销
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
    </>
  )
}
