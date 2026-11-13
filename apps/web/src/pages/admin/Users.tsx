// pages/admin/Users.tsx — 用户管理（M3，spec D4/D9，issue #46）
//
// 数据源 /api/platform/admin/users（后端已滤锚用户 tenantsub、锁本租户 org）。
// 写操作（建/禁启/重置密码/删）走 adminWrite 通道：现取 csrf + x-csrf-token。
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { App, Button, Card, Dropdown, Form, Input, Modal, Space, Switch, Table, Typography } from 'antd'
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
import { ConsolePage } from '../../components/ConsolePage'
import { UserAccessDrawer } from './UserAccessDrawer'

export default function AdminUsersPage() {
  const { session, config } = useOutletContext<ConsoleOutletContext>()
  // 数据范围那一节只在「数据模块启用 + 持 data:manage」时出现（跨模块 API 门卫仍是真闸）
  const dataScopesEnabled =
    config.modules.some((m) => m.id === 'data') && session.scopes.includes('data:manage')
  const { message } = App.useApp()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [accessUser, setAccessUser] = useState<AdminUser | null>(null)
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
      // 顺序（浏览器实测回归，issue #46）：关弹窗 → **立即刷新表** → 再做 UI 反馈。
      // reload 必须紧跟成功之后——任何夹在中间的 UI 调用抛错都会把刷新吞掉（表格静默陈旧）。
      // resetFields 不再调用：destroyOnClose 销毁字段即重置，手动 reset 反而在卸载竞态下断链。
      setCreating(false)
      void reload()
      message.success(`已创建 ${v.username}`)
    } catch (e) {
      message.error(e instanceof ApiError ? `创建失败：${e.code}` : '创建失败')
    }
  }

  // 成员多起来后靠肉眼扫表找不到人——列表页一律给搜索框（#1953 交互收口）
  const shown = users.filter(
    (u) => !search || u.name.includes(search) || (u.displayName ?? '').includes(search),
  )

  const columns: ColumnsType<AdminUser> = [
    { title: '用户名', dataIndex: 'name', key: 'name' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
    {
      title: '状态',
      dataIndex: 'isForbidden',
      key: 'isForbidden',
      width: 90,
      // 圆点 + 文字（2026-11-13 设计语言）：状态不用色块，避免整列被颜色占满
      render: (v: boolean) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: v ? '#6B7280' : '#1B1C1E' }}>
          <i style={{
            width: 6, height: 6, borderRadius: '50%',
            background: v ? '#C9CDD4' : '#0FA958', display: 'inline-block',
          }} />
          {v ? '已禁用' : '正常'}
        </span>
      ),
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
      width: 190,
      render: (_, u) => {
        const self = u.name === session.user.id
        return (
          <Space size={4}>
            {/* 主操作只有一个：配置权限。其余动作收进「更多」，避免一行三个按钮抢注意力 */}
            <Typography.Link onClick={() => setAccessUser(u)}>配置权限</Typography.Link>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'reset', label: '重置密码' },
                  { key: 'delete', label: '删除成员', danger: true, disabled: self },
                ],
                onClick: ({ key }) => {
                  if (key === 'reset') {
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
                    return
                  }
                  // 删除走二次确认（Dropdown 的菜单项本身不弹确认，用 Popconfirm 包不住，
                  // 所以这里显式 confirm —— 与旧版 Popconfirm 同一道闸）
                  Modal.confirm({
                    title: `删除用户 ${u.name}？`,
                    content: '该操作不可恢复',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      try {
                        await deleteAdminUser(u.name)
                        message.success(`已删除 ${u.name}`)
                        void reload()
                      } catch (e) {
                        message.error(e instanceof ApiError ? `删除失败：${e.code}` : '删除失败')
                      }
                    },
                  })
                },
              }}
            >
              <Button size="small">更多</Button>
            </Dropdown>
          </Space>
        )
      },
    },
  ]

  return (
    <ConsolePage
      title="成员"
      description="每人一个账号；禁用立即生效，删除不可恢复。"
      extra={
        <Space wrap>
          <Input.Search
            placeholder="搜索用户名/显示名"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
          <Button type="primary" onClick={() => setCreating(true)}>新建成员</Button>
        </Space>
      }
    >
    <Card>
      <Table<AdminUser>
        rowKey="name"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={shown}
        pagination={false}
        locale={{
          emptyText: search ? (
            <Typography.Text type="secondary">没有匹配「{search}」的成员</Typography.Text>
          ) : (
            <div style={{ padding: '32px 0' }}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                还没有成员。建完账号后，到「角色」页把权限码打包成角色，再回「组织架构」把人挂进角色。
              </Typography.Paragraph>
              <Button type="primary" onClick={() => setCreating(true)}>新建成员</Button>
            </div>
          ),
        }}
      />
      <Modal
        title="新建成员"
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
    {accessUser && (
      <UserAccessDrawer
        user={accessUser}
        open
        dataScopesEnabled={dataScopesEnabled}
        onClose={() => setAccessUser(null)}
        onSaved={() => void reload()}
      />
    )}
    </ConsolePage>
  )
}
