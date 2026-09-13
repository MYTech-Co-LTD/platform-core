// pages/admin/Permissions.tsx — 角色与授权（M3，spec §6.7 口径：权限码 ↔ 用户直挂）
//
// 每行 = 一个权限码（宇宙 = 平台内置 + 已装载模块）；已授权用户以可关闭 Tag 展示，
// 关闭即回收；「授权」弹窗输入用户名（仅字母数字）。tenant:admin 行有交接警示文案。
import { useCallback, useEffect, useState } from 'react'
import { App, Button, Card, Form, Input, Modal, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiError,
  grantAdminPermission,
  listAdminPermissions,
  revokeAdminPermission,
  type AdminPermission,
} from '../../lib/api'

export default function AdminPermissionsPage() {
  const { message } = App.useApp()
  const [permissions, setPermissions] = useState<AdminPermission[]>([])
  const [loading, setLoading] = useState(false)
  const [granting, setGranting] = useState<AdminPermission | null>(null)
  const [form] = Form.useForm<{ user: string }>()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setPermissions((await listAdminPermissions()).permissions)
    } catch (e) {
      message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { void reload() }, [reload])

  const onGrant = async (code: string, v: { user: string }) => {
    try {
      await grantAdminPermission(code, v.user)
      message.success(`已授权 ${v.user} ← ${code}`)
      setGranting(null)
      form.resetFields()
      void reload()
    } catch (e) {
      message.error(e instanceof ApiError ? `授权失败：${e.code}` : '授权失败')
    }
  }

  const columns: ColumnsType<AdminPermission> = [
    { title: '权限码', dataIndex: 'code', key: 'code', width: 200 },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      render: (v: string, p) => (
        <>
          {v}
          {p.code === 'tenant:admin' && (
            <Typography.Text type="warning" style={{ display: 'block', fontSize: 12 }}>
              授予此码 = 租户管理员；谨慎交接
            </Typography.Text>
          )}
        </>
      ),
    },
    {
      title: '已授权用户',
      dataIndex: 'users',
      key: 'users',
      render: (users: string[], p) => (
        <>
          {users.map((u) => (
            <Tag
              key={u}
              closable
              onClose={async (e) => {
                ;(e as unknown as Event).preventDefault?.()
                try {
                  await revokeAdminPermission(p.code, u)
                  message.success(`已回收 ${u} ← ${p.code}`)
                  void reload()
                } catch (err) {
                  message.error(err instanceof ApiError ? `回收失败：${err.code}` : '回收失败')
                }
              }}
            >
              {u}
            </Tag>
          ))}
          {users.length === 0 && <Typography.Text type="secondary">无人持有</Typography.Text>}
        </>
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 100,
      render: (_, p) => <Button size="small" type="primary" ghost onClick={() => setGranting(p)}>授权</Button>,
    },
  ]

  return (
    <Card title="角色与授权">
      <Table<AdminPermission> rowKey="code" size="small" loading={loading} columns={columns} dataSource={permissions} pagination={false} />
      <Modal
        title={`授权：${granting?.name ?? ''}（${granting?.code ?? ''}）`}
        open={!!granting}
        onCancel={() => setGranting(null)}
        onOk={() => void form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => void onGrant(granting!.code, v)}>
          <Form.Item
            name="user"
            label="用户名"
            rules={[
              { required: true, message: '必填' },
              { pattern: /^[A-Za-z0-9]+$/, message: '仅字母数字' },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
