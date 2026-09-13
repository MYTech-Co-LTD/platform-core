// pages/admin/Users.tsx — 用户管理（M3，spec D4/D9，issue #46）
//
// 数据源 /api/platform/admin/users（后端已滤锚用户 tenantsub、锁本租户 org）。
// 写操作（建/禁启/重置密码/删）走 adminWrite 通道：现取 csrf + x-csrf-token。
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { App, Button, Card, Form, Input, Modal, Popconfirm, Switch, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiError,
  createAdminUser,
  deleteAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
  setAdminUserForbidden,
  type AdminUser,
} from '../../lib/api'
import type { ConsoleOutletContext } from '../Console'

export default function AdminUsersPage() {
  const { session } = useOutletContext<ConsoleOutletContext>()
  const { message } = App.useApp()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{ username: string; displayName?: string; password: string }>()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setUsers((await listAdminUsers()).users)
    } catch (e) {
      message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { void reload() }, [reload])

  const onCreate = async (v: { username: string; displayName?: string; password: string }) => {
    try {
      await createAdminUser(v)
      message.success(`已创建 ${v.username}`)
      setCreating(false)
      form.resetFields()
      void reload()
    } catch (e) {
      message.error(e instanceof ApiError ? `创建失败：${e.code}` : '创建失败')
    }
  }

  const columns: ColumnsType<AdminUser> = [
    { title: '用户名', dataIndex: 'name', key: 'name' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    {
      title: '状态',
      dataIndex: 'isForbidden',
      key: 'isForbidden',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>),
    },
    {
      title: '启用',
      key: 'toggle',
      width: 80,
      render: (_, u) => (
        <Switch
          checked={!u.isForbidden}
          size="small"
          onChange={async (on) => {
            try {
              await setAdminUserForbidden(u.name, !on)
              message.success(on ? `已启用 ${u.name}` : `已禁用 ${u.name}`)
              void reload()
            } catch (e) {
              message.error(e instanceof ApiError ? `操作失败：${e.code}` : '操作失败')
            }
          }}
        />
      ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 200,
      render: (_, u) => {
        const self = u.name === session.user.id
        return (
          <>
            <Button
              size="small"
              onClick={() => {
                Modal.confirm({
                  title: `重置 ${u.name} 的密码`,
                  content: '新密码至少 8 位，请线下安全渠道告知用户。',
                  okText: '重置为随机密码',
                  onOk: async () => {
                    // 随机初始密码（一次一密，不落日志；audit 只记 reset:true）
                    const pwd = crypto.randomUUID().slice(0, 13) + 'Aa1'
                    try {
                      await resetAdminUserPassword(u.name, pwd)
                      Modal.success({ title: '新密码（仅本次显示）', content: pwd })
                      void reload()
                    } catch (e) {
                      message.error(e instanceof ApiError ? `重置失败：${e.code}` : '重置失败')
                    }
                  },
                })
              }}
            >
              重置密码
            </Button>{' '}
            <Popconfirm
              title={`删除用户 ${u.name}？`}
              description="该操作不可恢复"
              disabled={self}
              onConfirm={async () => {
                try {
                  await deleteAdminUser(u.name)
                  message.success(`已删除 ${u.name}`)
                  void reload()
                } catch (e) {
                  message.error(e instanceof ApiError ? `删除失败：${e.code}` : '删除失败')
                }
              }}
            >
              <Button size="small" danger disabled={self}>删除</Button>
            </Popconfirm>
          </>
        )
      },
    },
  ]

  return (
    <Card
      title="用户管理"
      extra={<Button type="primary" onClick={() => setCreating(true)}>新建用户</Button>}
    >
      <Table<AdminUser>
        rowKey="name"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={users}
        pagination={false}
      />
      <Modal
        title="新建用户"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => void form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={onCreate} requiredMark="optional">
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '必填' },
              { pattern: /^[A-Za-z0-9]+$/, message: '仅字母数字（Casdoor 用户名限制）' },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选）">
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[{ required: true, message: '必填' }, { min: 8, message: '至少 8 位' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
