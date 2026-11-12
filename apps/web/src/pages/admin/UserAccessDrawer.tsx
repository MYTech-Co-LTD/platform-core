// UserAccessDrawer.tsx — 「配置权限」动线（#1953 二期）。
//
// 为什么要有这一屏：管理台的权限模型有三层（角色 / 个人加码 / 数据范围），此前分散在
// 「角色」「权限码授权」「数据范围」三个页面里，管理员必须先知道模型才知道去哪点。
// 这一屏把「给一个人配权限」收成**一个动作**：打开 → 勾角色 → （可选）加码 → （可选）圈数据
// → 保存。页面里出现的顺序 = 管理员脑子里的顺序，不是后端表的顺序。
//
// 语义提醒（沿用既有实现，不另造）：
// - 角色成员是**整组替换**（setAdminRoleMembers 设置的是角色的成员表）⇒ 本抽屉按差集算 ±本用户。
// - 数据范围分配也是**整组替换** ⇒ 按差集算 ±本用户，绝不整表覆盖别人的分配。
// - 保存是「一次性提交全部差集」，任一步失败即整体报错并重载（不做静默半成功）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, App, Button, Checkbox, Collapse, Drawer, Empty, Space, Spin, Tag, Typography,
} from 'antd'
import {
  ApiError,
  grantAdminPermission,
  listAdminPermissions,
  listAdminRoles,
  listDataScopes,
  putDataScopeAssignments,
  revokeAdminPermission,
  setAdminRoleMembers,
  type AdminPermission,
  type AdminRoleRow,
  type AdminUser,
  type DataScopeRow,
} from '../../lib/api'

const KIND_LABEL: Record<DataScopeRow['kind'], string> = { brand: '品牌', store: '门店', category: '品类' }
const KIND_ORDER: DataScopeRow['kind'][] = ['brand', 'store', 'category']

/** selector → 人读（与 modules/data/console/scopes 同一口径；仅展示，不参与判定） */
function scopeText(s: DataScopeRow): string {
  if (s.selector.all === true) return '全部'
  if (s.kind === 'brand') return `账套 ${(s.selector.system_book ?? []).join(' + ')}`
  if (s.kind === 'store') {
    const l1 = s.selector.region_l1 ?? []
    const l2 = s.selector.region_name ?? []
    return [l1.length ? `战区 ${l1.join('、')}` : '', l2.length ? `小区 ${l2.join('、')}` : '']
      .filter(Boolean).join(' · ')
  }
  return `品类 ${(s.selector.category_group ?? []).join('、')}`
}

interface Props {
  user: AdminUser
  open: boolean
  onClose: () => void
  /** 保存成功后的回调（父页刷新列表） */
  onSaved: () => void
  /** 是否有数据范围管理面（data 模块启用 + 持 data:manage）；false ⇒ 整节隐藏 */
  dataScopesEnabled: boolean
}

export function UserAccessDrawer({ user, open, onClose, onSaved, dataScopesEnabled }: Props) {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [roles, setRoles] = useState<AdminRoleRow[]>([])
  const [perms, setPerms] = useState<AdminPermission[]>([])
  const [scopes, setScopes] = useState<DataScopeRow[]>([])
  // 三组勾选（初始值来自服务端；保存时只提交差集）
  const [pickedRoles, setPickedRoles] = useState<Set<string>>(new Set())
  const [pickedCodes, setPickedCodes] = useState<Set<string>>(new Set())
  const [pickedScopes, setPickedScopes] = useState<Set<number>>(new Set())
  // 初始快照：差集计算的基准
  const [initialRoles, setInitialRoles] = useState<Set<string>>(new Set())
  const [initialCodes, setInitialCodes] = useState<Set<string>>(new Set())
  const [initialScopes, setInitialScopes] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [roleList, permList] = await Promise.all([listAdminRoles(), listAdminPermissions()])
      setRoles(roleList.roles)
      setPerms(permList.permissions)
      const userRoles = new Set(roleList.roles.filter((r) => r.users.includes(user.name)).map((r) => r.name))
      const userCodes = new Set(permList.permissions.filter((p) => p.users.includes(user.name)).map((p) => p.code))
      setPickedRoles(userRoles)
      setInitialRoles(userRoles)
      setPickedCodes(userCodes)
      setInitialCodes(userCodes)

      if (dataScopesEnabled) {
        const { scopes: list } = await listDataScopes()
        setScopes(list)
        const mine = new Set(
          list.filter((s) => s.assignments.some((a) => a.subjectType === 'user' && a.subjectId === user.name)).map((s) => s.id),
        )
        setPickedScopes(mine)
        setInitialScopes(mine)
      }
    } catch (e) {
      message.error(e instanceof ApiError ? `加载失败：${e.code}` : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [dataScopesEnabled, message, user.name])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  /** 角色授予后，这些角色的码也算生效——用于「生效预览」而不是让管理员自己脑补 */
  const effectiveCodes = useMemo(() => {
    const out = new Set(pickedCodes)
    for (const r of roles) if (pickedRoles.has(r.name)) for (const c of r.codes) out.add(c)
    return out
  }, [pickedCodes, pickedRoles, roles])

  const roleDiff = useMemo(() => {
    const added = [...pickedRoles].filter((r) => !initialRoles.has(r))
    const removed = [...initialRoles].filter((r) => !pickedRoles.has(r))
    return { added, removed }
  }, [pickedRoles, initialRoles])

  const save = async () => {
    setSaving(true)
    try {
      const ops: Array<Promise<unknown>> = []

      // 1) 角色：整组替换 ⇒ 对每个变更角色算「现成员 ± 本用户」
      for (const name of [...roleDiff.added, ...roleDiff.removed]) {
        const role = roles.find((r) => r.name === name)
        if (!role) continue
        const members = new Set(role.users)
        if (roleDiff.added.includes(name)) members.add(user.name)
        else members.delete(user.name)
        ops.push(setAdminRoleMembers(name, [...members]))
      }

      // 2) 个人加码：只提交真正变化的码
      for (const code of pickedCodes) if (!initialCodes.has(code)) ops.push(grantAdminPermission(code, user.name))
      for (const code of initialCodes) if (!pickedCodes.has(code)) ops.push(revokeAdminPermission(code, user.name))

      // 3) 数据范围：整组替换 ⇒ 只动「这个人」这一条，别人的分配原样带回
      if (dataScopesEnabled) {
        const touched = new Set([...pickedScopes, ...initialScopes])
        for (const id of touched) {
          const had = initialScopes.has(id)
          const has = pickedScopes.has(id)
          if (had === has) continue
          const scope = scopes.find((s) => s.id === id)
          if (!scope) continue
          const others = scope.assignments.filter((a) => !(a.subjectType === 'user' && a.subjectId === user.name))
          ops.push(putDataScopeAssignments(id, [...others, ...(has ? [{ subjectType: 'user' as const, subjectId: user.name }] : [])]))
        }
      }

      await Promise.all(ops)
      message.success(`已保存 ${user.displayName || user.name} 的权限`)
      onSaved()
      onClose()
    } catch (e) {
      message.error(e instanceof ApiError ? `保存失败：${e.code}（已重新加载当前配置）` : '保存失败（已重新加载当前配置）')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const roleOptions = roles.map((r) => ({
    value: r.name,
    label: (
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Typography.Text strong>{r.displayName || r.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.members} 人使用 · {r.codes.length} 个权限
          </Typography.Text>
        </Space>
        {r.codes.length > 0 && (
          <Space size={4} wrap>
            {r.codes.slice(0, 6).map((c) => <Tag key={c} style={{ marginInlineEnd: 0 }}>{c}</Tag>)}
            {r.codes.length > 6 && <Tag>+{r.codes.length - 6}</Tag>}
          </Space>
        )}
      </Space>
    ),
  }))

  return (
    <Drawer
      title={`配置权限 · ${user.displayName || user.name}（${user.name}）`}
      width={720}
      open={open}
      onClose={onClose}
      destroyOnClose
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void save()} disabled={loading}>
            保存
          </Button>
        </Space>
      }
    >
      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : (
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="这个人的权限 = 角色里的码 + 个人追加的码；能看哪些数据由「数据范围」决定。"
            description="日常按岗位配「角色」，个别人缺一个功能时才用「个人追加」。改动点底部「保存」一次提交。"
          />

          {/* ① 角色 */}
          <section>
            <Typography.Title level={5} style={{ marginTop: 0 }}>① 他能干什么 · 角色</Typography.Title>
            {roles.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有角色。先去「角色」页建一个岗位包（例如「门店店长」），勾好权限码再回来。"
              />
            ) : (
              <Checkbox.Group
                style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}
                value={[...pickedRoles]}
                onChange={(v) => setPickedRoles(new Set(v as string[]))}
                options={roleOptions}
              />
            )}
          </section>

          {/* ② 数据范围 */}
          {dataScopesEnabled && (
            <section>
              <Space size={12} wrap style={{ marginBottom: 2 }}>
                <Typography.Title level={5} style={{ margin: 0 }}>② 他能看哪些数据 · 数据范围</Typography.Title>
                {/* 范围定义本身不在这屏（属于数据面配置）⇒ 给明确出口，别让人在这里找「新建范围」 */}
                <Typography.Link href="/console/data/scopes" target="_blank" rel="noopener" style={{ fontSize: 12 }}>
                  管理范围定义 ↗
                </Typography.Link>
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
                不勾任何范围 = 报表里看不到数据（这是「默认不可见」，不是出错）。按部门/区域给范围即可。
              </Typography.Paragraph>
              {scopes.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有数据范围。先去「数据范围」页建一个（如「华东门店」），再回来分配。"
                />
              ) : (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {KIND_ORDER.map((kind) => {
                    const rows = scopes.filter((s) => s.kind === kind)
                    if (rows.length === 0) return null
                    return (
                      <div key={kind}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{KIND_LABEL[kind]}</Typography.Text>
                        <Checkbox.Group
                          style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 4 }}
                          value={rows.filter((s) => pickedScopes.has(s.id)).map((s) => String(s.id))}
                          onChange={(v) => {
                            const next = new Set(pickedScopes)
                            for (const r of rows) {
                              if ((v as string[]).includes(String(r.id))) next.add(r.id)
                              else next.delete(r.id)
                            }
                            setPickedScopes(next)
                          }}
                          options={rows.map((s) => ({
                            value: String(s.id),
                            label: (
                              <Space size={8} wrap>
                                <span>{s.name}</span>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{scopeText(s)}</Typography.Text>
                              </Space>
                            ),
                          }))}
                        />
                      </div>
                    )
                  })}
                </Space>
              )}
            </section>
          )}

          {/* ③ 个人追加（默认收起：这是例外动作，不该是常规路径） */}
          <Collapse
            ghost
            items={[{
              key: 'extra',
              label: <span>③ 个人追加权限码（高级 · 仅当角色缺一个功能时用）</span>,
              children: (
                <Checkbox.Group
                  style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}
                  value={[...pickedCodes]}
                  onChange={(v) => setPickedCodes(new Set(v as string[]))}
                  options={perms.map((p) => ({
                    value: p.code,
                    label: (
                      <Space size={8} wrap>
                        <span>{p.code}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.name}</Typography.Text>
                      </Space>
                    ),
                  }))}
                />
              ),
            }]}
          />

          <Alert
            type="success"
            showIcon
            message={`保存后将生效：${effectiveCodes.size} 个权限码${dataScopesEnabled ? ` · ${pickedScopes.size} 个数据范围` : ''}`}
            description={roleDiff.added.length + roleDiff.removed.length > 0
              ? `角色变更：+${roleDiff.added.length} / -${roleDiff.removed.length}（其余不变）`
              : '角色无变更'}
          />
        </Space>
      )}
    </Drawer>
  )
}
