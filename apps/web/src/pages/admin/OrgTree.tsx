// pages/admin/OrgTree.tsx — 组织架构（账户和权限体系 spec §3.4；Casdoor group 树代理视图）
//
// 数据源 /api/platform/admin/org-tree + /org-tree/members（后端已锁 org、剔锚用户）。
// 授角色语义：setAdminRoleMembers 设置的是【角色的成员表】——给用户授/收角色 =
// 对每个变更角色算「现成员 ± 该用户」整组替换（见 onGrant 注释），不是改「用户的角色列表」。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { App, Card, Form, Input, Modal, Select, Table, Tag, Tree } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiError,
  getAdminOrgTree,
  listAdminMembers,
  listAdminRoles,
  setAdminRoleMembers,
  type AdminGroupNode,
  type AdminMember,
  type AdminRoleRow,
} from '../../lib/api'
import type { ConsoleOutletContext } from '../Console'

/** AdminGroupNode → antd TreeDataNode（displayName + 孤儿标记 + 成员数） */
function toTreeData(nodes: AdminGroupNode[]): { title: string; key: string; children: ReturnType<typeof toTreeData> }[] {
  return nodes.map((n) => ({
    title: `${n.displayName}${n.orphan ? '（未挂接）' : ''}（${n.memberCount}）`,
    key: n.name,
    children: toTreeData(n.children),
  }))
}

export default function AdminOrgTreePage() {
  useOutletContext<ConsoleOutletContext>()
  const { message } = App.useApp()
  const [tree, setTree] = useState<AdminGroupNode[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [members, setMembers] = useState<AdminMember[]>([])
  const [roles, setRoles] = useState<AdminRoleRow[]>([])
  const [granting, setGranting] = useState<AdminMember | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [form] = Form.useForm<{ roles: string[] }>()

  const reload = useCallback(
    async (group?: string) => {
      try {
        const t = await getAdminOrgTree()
        setTree(t.tree)
        setRoles((await listAdminRoles()).roles)
        setMembers((await listAdminMembers(group ?? selected)).users)
      } catch (e) {
        message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- message 引用稳定；selected 经参数显式传递
    [selected],
  )

  useEffect(() => {
    void reload()
    // 初次装载拉全量；首选项未定时 members 即全员视图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shown = useMemo(
    () => members.filter((m) => !search || m.displayName.includes(search) || m.name.includes(search)),
    [members, search],
  )

  const onSelect = (keys: React.Key[]) => {
    const group = keys[0] as string | undefined
    setSelected(group)
    void reload(group)
  }

  const onGrant = async () => {
    if (!granting) return
    const picked = new Set((form.getFieldValue('roles') as string[]) ?? [])
    const current = new Set(granting.roles)
    try {
      setSaving(true)
      // 关键语义：setAdminRoleMembers 设置的是【角色的成员表】。对本用户发生变更的每个角色，
      // 取该角色现成员（GET /roles 的短名 users）± 本用户，整组替换——不是改「用户的角色列表」。
      const changed: Array<Promise<unknown>> = []
      for (const r of roles) {
        if (picked.has(r.name) === current.has(r.name)) continue
        const members = new Set(r.users)
        if (picked.has(r.name)) members.add(granting.name)
        else members.delete(granting.name)
        changed.push(setAdminRoleMembers(r.name, [...members]))
      }
      await Promise.all(changed)
      setGranting(null)
      void reload() // 顺序纪律（Users.tsx 实测回归）：先刷新再 message，防 UI 调用抛错吞刷新
      message.success(`已更新 ${granting.displayName || granting.name} 的角色`)
    } catch (e) {
      message.error(e instanceof ApiError ? `操作失败：${e.code}` : '操作失败')
    } finally {
      setSaving(false)
    }
  }

  const columns: ColumnsType<AdminMember> = [
    { title: '姓名', dataIndex: 'displayName' },
    { title: '账号', dataIndex: 'name' },
    {
      title: '状态',
      dataIndex: 'isForbidden',
      render: (v: boolean) => (v ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>),
    },
    {
      title: '角色',
      dataIndex: 'roles',
      render: (roles: string[]) =>
        roles.length ? roles.map((r) => <Tag key={r}>{r}</Tag>) : <span style={{ color: '#999' }}>—</span>,
    },
    {
      title: '操作',
      render: (_, u) => (
        <a
          onClick={() => {
            setGranting(u)
            form.setFieldValue('roles', u.roles)
          }}
        >
          授角色
        </a>
      ),
    },
  ]

  return (
    <Card
      title="组织架构"
      extra={
        <Input.Search
          placeholder="搜索姓名/账号"
          onSearch={setSearch}
          onChange={(e) => {
            if (!e.target.value) setSearch('')
          }}
          style={{ width: 220 }}
          allowClear
        />
      }
    >
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Card size="small" style={{ width: 300, flexShrink: 0 }}>
          {tree.length ? (
            <Tree treeData={toTreeData(tree)} defaultExpandAll onSelect={onSelect} />
          ) : (
            <span style={{ color: '#999' }}>（暂无组织数据——待企微通讯录同步）</span>
          )}
        </Card>
        <Table<AdminMember>
          style={{ flex: 1 }}
          size="small"
          rowKey="name"
          columns={columns}
          dataSource={shown}
          pagination={false}
        />
      </div>
      <Modal
        title={granting ? `授予角色：${granting.displayName || granting.name}` : ''}
        open={granting !== null}
        onOk={onGrant}
        confirmLoading={saving}
        onCancel={() => setGranting(null)}
        destroyOnClose
      >
        <Form form={form}>
          <Form.Item name="roles" label="角色">
            <Select
              mode="multiple"
              placeholder="选择要授予的角色（可多选）"
              options={roles.map((r) => ({ value: r.name, label: r.displayName || r.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
