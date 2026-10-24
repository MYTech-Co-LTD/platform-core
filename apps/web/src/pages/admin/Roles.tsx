// pages/admin/Roles.tsx — 角色管理（账户和权限体系 spec §3.4：角色批量授权面）
//
// 数据源 /api/platform/admin/roles（后端已锁 org）。写操作走 csrfWrite 通道（现取 csrf）。
// 成员管理 = setAdminRoleMembers 整组替换；码↔角色 = grant/revokeAdminPermissionRole 勾选差分。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { App, Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiError,
  createAdminRole,
  deleteAdminRole,
  grantAdminPermissionRole,
  listAdminMembers,
  listAdminPermissions,
  listAdminRoles,
  revokeAdminPermissionRole,
  setAdminRoleMembers,
  type AdminMember,
  type AdminRoleRow,
} from '../../lib/api'
import type { ConsoleOutletContext } from '../Console'

/** 与后端 RoleNameSchema 同源：Casdoor name 禁用字符集 `"/?:#&%=+;"` + 长度上限 */
const ROLE_NAME_RE = /^[^/?:#&%=+;]{1,64}$/

export default function AdminRolesPage() {
  useOutletContext<ConsoleOutletContext>()
  const { message } = App.useApp()
  const [roles, setRoles] = useState<AdminRoleRow[]>([])
  const [members, setMembers] = useState<AdminMember[]>([])
  const [codes, setCodes] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminRoleRow | null>(null)
  const [editMembers, setEditMembers] = useState<string[]>([])
  const [editCodes, setEditCodes] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<{ name: string; displayName?: string }>()

  const reload = useCallback(async () => {
    try {
      setRoles((await listAdminRoles()).roles)
    } catch (e) {
      message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
    }
  }, [message])

  useEffect(() => {
    void reload()
  }, [reload])

  // 编辑弹窗的候选集：全员（成员选择）+ 权限码宇宙（码勾选）——打开时拉一次
  const openEdit = useCallback(
    async (r: AdminRoleRow) => {
      setEditing(r)
      setEditMembers(r.users)
      setEditCodes(r.codes)
      try {
        setMembers((await listAdminMembers()).users)
        setCodes((await listAdminPermissions()).permissions.map((p) => p.code))
      } catch (e) {
        message.error(e instanceof ApiError ? `候选集加载失败：${e.code}` : '候选集加载失败')
      }
    },
    [message],
  )

  const onCreate = async (v: { name: string; displayName?: string }) => {
    try {
      setSaving(true)
      await createAdminRole(v)
      setCreating(false)
      await reload() // 顺序纪律（Users.tsx 实测回归）：先刷新再 message
      message.success(`已创建 ${v.name}`)
    } catch (e) {
      message.error(e instanceof ApiError ? `创建失败：${e.code}` : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async (r: AdminRoleRow) => {
    try {
      await deleteAdminRole(r.name)
      await reload()
      message.success(`已删除 ${r.displayName || r.name}`)
    } catch (e) {
      message.error(e instanceof ApiError ? `删除失败：${e.code}` : '删除失败')
    }
  }

  const onSaveEdit = async () => {
    if (!editing) return
    try {
      setSaving(true)
      // 成员整组替换（一次调用承载全部增删）
      const changedMembers =
        editMembers.length !== editing.users.length ||
        editMembers.some((u) => !editing.users.includes(u))
      if (changedMembers) await setAdminRoleMembers(editing.name, editMembers)
      // 码↔角色勾选差分：新勾的挂、取消的收
      const prevCodes = new Set(editing.codes)
      const nextCodes = new Set(editCodes)
      for (const c of editCodes) if (!prevCodes.has(c)) await grantAdminPermissionRole(c, editing.name)
      for (const c of editing.codes) if (!nextCodes.has(c)) await revokeAdminPermissionRole(c, editing.name)
      setEditing(null)
      await reload()
      message.success(`已保存 ${editing.displayName || editing.name}`)
    } catch (e) {
      message.error(e instanceof ApiError ? `保存失败：${e.code}` : '保存失败')
      await reload()
    } finally {
      setSaving(false)
    }
  }

  const columns: ColumnsType<AdminRoleRow> = useMemo(
    () => [
      { title: '角色', dataIndex: 'displayName', render: (v: string, r) => v || r.name },
      { title: '成员数', dataIndex: 'members', width: 90 },
      {
        title: '挂码',
        dataIndex: 'codes',
        render: (codes: string[]) =>
          codes.length ? codes.map((c) => <Tag key={c}>{c}</Tag>) : <span style={{ color: '#999' }}>—</span>,
      },
      {
        title: '操作',
        width: 160,
        render: (_, r) => (
          <Space>
            <a onClick={() => void openEdit(r)}>编辑</a>
            <Popconfirm title={`确认删除角色「${r.displayName || r.name}」？`} onConfirm={() => void onDelete(r)}>
              <a style={{ color: '#cf1322' }}>删除</a>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openEdit/onDelete 引用随闭包稳定
    [openEdit],
  )

  return (
    <Card
      title="角色管理"
      extra={
        <Button type="primary" onClick={() => setCreating(true)}>
          新建角色
        </Button>
      }
    >
      <Table<AdminRoleRow> rowKey="name" columns={columns} dataSource={roles} size="small" pagination={false} />

      <Modal
        title="新建角色"
        open={creating}
        onOk={() => form.submit()}
        confirmLoading={saving}
        onCancel={() => setCreating(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={onCreate}>
          <Form.Item
            name="name"
            label="角色名（标识）"
            rules={[
              { required: true, message: '必填' },
              { pattern: ROLE_NAME_RE, message: '仅限 1–64 位，且不含 /?:#&%=+;' },
            ]}
          >
            <Input placeholder="如 store-manager" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选）" rules={[{ max: 128, message: '最长 128 字' }]}>
            <Input placeholder="如 门店店长" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editing ? `编辑角色：${editing.displayName || editing.name}` : ''}
        open={editing !== null}
        onOk={onSaveEdit}
        confirmLoading={saving}
        onCancel={() => setEditing(null)}
        width={640}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          成员（整组保存）
        </Typography.Paragraph>
        <Checkbox.Group
          style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto', marginBottom: 16 }}
          options={members.map((m) => ({ value: m.name, label: `${m.displayName}（${m.name}）` }))}
          value={editMembers}
          onChange={(v) => setEditMembers(v as string[])}
        />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          权限码（勾选即挂、取消即收）
        </Typography.Paragraph>
        <Checkbox.Group
          style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}
          options={codes.map((c) => ({ value: c, label: c }))}
          value={editCodes}
          onChange={(v) => setEditCodes(v as string[])}
        />
      </Modal>
    </Card>
  )
}
