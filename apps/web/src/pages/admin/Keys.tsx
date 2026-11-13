// pages/admin/Keys.tsx — 全租户 Key 管理（`tenant:admin`）。issue #894，正典 §1.5 定案②。
//
// 只读 + 吊销：**不代建**（key 是「每个账号自己的」——代建等于把别人的凭据经你手发出去）。
// 门禁由 App.tsx 的 <AdminGate> 施加（本页不自判 scope，与其它管理页同构）。
import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Popconfirm, Table, Typography, message } from 'antd'
import { listAllKeys, revokeAnyKey, type AdminApiKeyRow } from '../../lib/api'
import { ConsolePage } from '../../components/ConsolePage'

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
    <ConsolePage
      title="API Key"
      description="本租户全部 API Key，只可吊销。创建入口在「我的 Key」。"
    >
      <Card>
      <Table<AdminApiKeyRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        locale={{
          emptyText: (
            <div style={{ padding: '32px 0' }}>
              <Typography.Text type="secondary">
                本租户还没有任何 API Key。Key 由账号在「个人 Key」页自助创建；你在这里只负责吊销。
              </Typography.Text>
            </div>
          ),
        }}
        size="small"
        columns={[
          { title: 'Key', dataIndex: 'name', render: (v: string, r: AdminApiKeyRow) => (
            <div>
              <div style={{ fontWeight: 500 }}>{v}</div>
              <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, color: '#9AA0A6' }}>{r.casdoorUser}</div>
            </div>
          ) },
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
            render: (revoked: boolean) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <i style={{ width: 6, height: 6, borderRadius: '50%', display: 'inline-block', background: revoked ? '#C9CDD4' : '#0FA958' }} />
                {revoked ? '已吊销' : '有效'}
              </span>
            ),
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
      </Card>
    </ConsolePage>
  )
}
