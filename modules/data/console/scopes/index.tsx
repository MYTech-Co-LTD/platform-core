// console/scopes/index.tsx — 「数据范围」页签（data:manage；spec 2026-11-10 §5.5，#1901）。
//
// 定位：运营自助面——查/建/改/删 scope、整组替换 assignment、预览某人有效范围。
// 判定全在服务端（domain/scope-admin.ts）；本页只做展示与转发，**不复制校验逻辑**
// （配置错值 ⇒ 服务端 VALUE_NOT_IN_DIMS 并点名未知值，本页原样回显 detail）。
// 页签本身只在持 data:manage 时出现（入口按 session.scopes 过滤；API 侧门卫仍是真闸）。
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  Alert, Button, Card, Checkbox, Collapse, Drawer, Input, Modal, Popconfirm, Select, Space, Switch,
  Table, Tag, Typography, message,
} from 'antd'
import { apiGet, apiSend, ApiError } from '../lib/api'

/** Console 壳经 Outlet 注入的会话（demo 模块先例；reports 页同款类型）。 */
interface ConsoleContext { session: { scopes: string[] } }

type Kind = 'brand' | 'store' | 'category'
type Selector = { system_book?: string[]; region_l1?: string[]; region_name?: string[]; category_group?: string[]; all?: boolean }
interface AssignmentItem {
  subjectType: 'dept' | 'role' | 'user'
  subjectId: string
  /** 仅 dept：true（默认）= 该部门及其下级都生效；false = 只给直属成员（战区内分级靠它） */
  includeChildren?: boolean
}
interface DeptOption { ext_id: string; name: string; path: string }
interface ScopeView {
  id: number; name: string; kind: Kind; selector: Selector
  legacyLabel: string | null; assignments: AssignmentItem[]
}
interface EffectivePreview {
  user: string; roles: string[]
  effective: { brand: Selector[]; store: Selector[]; category: Selector[] }
  granted: Array<{ name: string; kind: Kind }>
}

const KIND_LABEL: Record<Kind, string> = { brand: '品牌', store: '门店', category: '品类' }

/** selector → 人读（列表与预览共用一份渲染）。 */
function selectorText(kind: Kind, s: Selector): string {
  if (s.all === true) return '全部'
  if (kind === 'brand') return `账套 ${(s.system_book ?? []).join(' + ')}`
  if (kind === 'store') {
    const parts: string[] = []
    if ((s.region_l1 ?? []).length > 0) parts.push(`一级：${(s.region_l1 ?? []).join('、')}`)
    if ((s.region_name ?? []).length > 0) parts.push(`二级：${(s.region_name ?? []).join('、')}`)
    return parts.join('；')
  }
  return `品类组 ${(s.category_group ?? []).join('、')}`
}

/** 逗号分隔输入 → 去空去重的字符串数组（服务端仍会做维表校验，这里只做基本清洗）。 */
const csv = (v: string): string[] => [...new Set(v.split(/[,，]/).map((x) => x.trim()).filter((x) => x !== ''))]

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail === undefined ? e.code : `${e.code}：${e.detail}`
  return e instanceof Error ? e.message : String(e)
}

/** 表单形状（编辑弹窗）：kind 决定哪几组输入在场。 */
interface FormState { name: string; kind: Kind; all: boolean; systemBook: string; regionL1: string; regionName: string; categoryGroup: string }
const EMPTY_FORM: FormState = { name: '', kind: 'store', all: false, systemBook: '', regionL1: '', regionName: '', categoryGroup: '' }

function formOf(s: ScopeView): FormState {
  return {
    name: s.name, kind: s.kind, all: s.selector.all === true,
    systemBook: (s.selector.system_book ?? []).join(','),
    regionL1: (s.selector.region_l1 ?? []).join(','),
    regionName: (s.selector.region_name ?? []).join(','),
    categoryGroup: (s.selector.category_group ?? []).join(','),
  }
}

function selectorOf(f: FormState): Selector {
  if (f.kind === 'brand') return { system_book: csv(f.systemBook) }
  if (f.kind === 'category') return f.all ? { all: true } : { category_group: csv(f.categoryGroup) }
  return f.all ? { all: true } : { ...(csv(f.regionL1).length > 0 ? { region_l1: csv(f.regionL1) } : {}), ...(csv(f.regionName).length > 0 ? { region_name: csv(f.regionName) } : {}) }
}

export default function ScopesPage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canManage = session.scopes.includes('data:manage')

  const [rows, setRows] = useState<ScopeView[]>([])
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const [editing, setEditing] = useState<{ id: number | null } | null>(null)   // null=关；id=null=新建
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const [assigning, setAssigning] = useState<ScopeView | null>(null)
  const [assignRows, setAssignRows] = useState<AssignmentItem[]>([])
  // 部门候选（dept 主体选择用）；打不开就退化成手填 ext_id，不阻断
  const [depts, setDepts] = useState<DeptOption[]>([])

  const [auditOpen, setAuditOpen] = useState(false)
  const [auditRows, setAuditRows] = useState<Array<{ id: number; actor: string; action: string; detail: Record<string, unknown>; createdAt: string }>>([])
  const [auditLoading, setAuditLoading] = useState(false)

  const [pUser, setPUser] = useState('')
  const [pRoles, setPRoles] = useState('')
  const [preview, setPreview] = useState<EffectivePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setLoadErr(null)
    try {
      const b = await apiGet('/scopes') as { scopes: ScopeView[] }
      setRows(b.scopes)
    } catch (e) {
      setLoadErr(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { if (canManage) void load() }, [canManage, load])

  if (!canManage) {
    return <Alert type="warning" showIcon message="需要 data:manage 权限才能管理数据范围。" />
  }

  const openAudit = async () => {
    setAuditOpen(true); setAuditLoading(true)
    try {
      const b = await apiGet('/scopes/audit?limit=100') as { audit: typeof auditRows }
      setAuditRows(b.audit)
    } catch (e) {
      message.error(errText(e))
    } finally { setAuditLoading(false) }
  }

  const openCreate = () => { setForm(EMPTY_FORM); setEditing({ id: null }) }
  const openEdit = (s: ScopeView) => { setForm(formOf(s)); setEditing({ id: s.id }) }

  const save = async () => {
    if (editing === null) return
    setSaving(true)
    try {
      const body = { name: form.name.trim(), kind: form.kind, selector: selectorOf(form) }
      await apiSend(editing.id === null ? '/scopes' : `/scopes/${editing.id}`,
        editing.id === null ? 'POST' : 'PUT', body)
      message.success(editing.id === null ? '已创建' : '已更新')
      setEditing(null)
      await load()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (s: ScopeView) => {
    try {
      await apiSend(`/scopes/${s.id}`, 'DELETE')
      message.success(`已删除 ${s.name}（分配随之清空）`)
      await load()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const openAssign = async (s: ScopeView) => {
    setAssigning(s)
    setAssignRows(s.assignments.map((a) => ({ ...a })))
    try {
      const r = await apiGet('/scopes/depts') as { depts: DeptOption[] }
      setDepts(r.depts)
    } catch {
      setDepts([]) // 组织没同步也能配 role/user；dept 退化成手填
    }
  }

  const saveAssign = async () => {
    if (assigning === null) return
    setSaving(true)
    try {
      await apiSend(`/scopes/${assigning.id}/assignments`, 'PUT', { assignments: assignRows })
      message.success('分配已整组替换')
      setAssigning(null)
      await load()
    } catch (e) {
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const runPreview = async () => {
    if (pUser.trim() === '') { message.warning('先填要预览的用户名'); return }
    setPreviewing(true)
    try {
      const roles = csv(pRoles).join(',')
      const q = `user=${encodeURIComponent(pUser.trim())}${roles === '' ? '' : `&roles=${encodeURIComponent(roles)}`}`
      setPreview(await apiGet(`/scopes/effective?${q}`) as EffectivePreview)
    } catch (e) {
      message.error(errText(e))
      setPreview(null)
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {/* 用法说明（2026-11-12 真机反馈：管理员看得懂表，但不知道整体怎么用）：
          这一段只讲「三步 + 两条判定规则」，不写实现细节。 */}
      <Collapse
        items={[{
          key: 'how',
          label: '怎么用：三步看清「谁能看什么」',
          children: (
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text>
                <b>① 建范围</b>：一条范围就是一个数据切片——品牌（账套）/ 门店（战区或区）/ 品类。
                例如「门店|东部一区」= 东部一区下的所有门店。
              </Typography.Text>
              <Typography.Text>
                <b>② 分配</b>：把范围发给「谁」。<b>部门是主路径</b>（人调岗自动跟随），
                角色用于跨部门岗位，个人只作例外。部门行有「含下级部门」开关：
                区级范围勾上（整个区生效），战区级范围取消勾选（只给战区总，区/店不继承）。
              </Typography.Text>
              <Typography.Text>
                <b>③ 判定</b>：按人算。<b>同类型取并集</b>（部门给一区 + 个人给二区 = 两个区都能看）；
                <b>三种类型缺一不可</b>（品牌、门店、品类任一没有 ⇒ 查询被拒，不是部分显示）。
                没有门店范围的人看不到门店数据——这是默认拒绝，不是出错。
              </Typography.Text>
              <Typography.Text type="secondary">
                排查「某人为什么看不见 / 看得太宽」：用下面的「试算」输入他的账号，直接看他最终拿到什么。
              </Typography.Text>
            </Space>
          ),
        }]}
      />

      <Card title="试算：输入一个账号，看他最终能看什么">
        <Space wrap style={{ marginBottom: 12 }}>
          <Input placeholder="用户名（Casdoor name / 企微 userid）" style={{ width: 260 }}
                 value={pUser} onChange={(e) => setPUser(e.target.value)} />
          <Input placeholder="角色（逗号分隔，可空）" style={{ width: 220 }}
                 value={pRoles} onChange={(e) => setPRoles(e.target.value)} />
          <Button loading={previewing} onClick={() => void runPreview()}>预览</Button>
        </Space>
        {preview === null
          ? <Typography.Text type="secondary">
              填用户名后预览其有效品牌 / 门店 / 品类范围（只读，不改动任何配置）。
              例：`caohongye`（东部一区的店员）应看到 品牌 + 东部一区 + 品类。
            </Typography.Text>
          : (
            <Space orientation="vertical" size={4}>
              <div>
                命中范围：
                {preview.granted.length === 0
                  ? <Typography.Text type="warning"> 无（enforce 下该用户的数据查询会被拒绝）</Typography.Text>
                  : preview.granted.map((g) => <Tag key={`${g.kind}:${g.name}`}>{g.name}</Tag>)}
              </div>
              <div>品牌：{preview.effective.brand.map((s, i) => <Tag key={i}>{selectorText('brand', s)}</Tag>)}</div>
              <div>门店：{preview.effective.store.length === 0 ? <Tag color="warning">无</Tag>
                : preview.effective.store.map((s, i) => <Tag key={i}>{selectorText('store', s)}</Tag>)}</div>
              <div>品类：{preview.effective.category.map((s, i) => <Tag key={i}>{selectorText('category', s)}</Tag>)}</div>
              {preview.effective.brand.length === 0 || preview.effective.store.length === 0 || preview.effective.category.length === 0
                ? (
                  <Typography.Text type="warning">
                    结论：三项不全 ⇒ 在 enforce 下他的查询会被拒绝（原因码：
                    {preview.effective.brand.length === 0 ? ' no_brand_scope' : ''}
                    {preview.effective.store.length === 0 ? ' no_store_scope' : ''}
                    {preview.effective.category.length === 0 ? ' no_category_scope' : ''}）。
                  </Typography.Text>
                )
                : <Typography.Text type="success">结论：三项齐全，可以正常查数。</Typography.Text>}
            </Space>
          )}
      </Card>

      <Card
        title="范围清单"
        extra={<Space><Button onClick={() => void openAudit()}>变更历史</Button><Button type="primary" onClick={openCreate}>新建范围</Button></Space>}
      >
        {loadErr !== null && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={loadErr} />}
        <Table<ScopeView>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name' },
            {
              title: '类型', dataIndex: 'kind', width: 80,
              render: (k: Kind) => <Tag>{KIND_LABEL[k]}</Tag>,
            },
            { title: '范围', render: (_: unknown, r) => selectorText(r.kind, r.selector) },
            {
              title: '分配', width: 90,
              render: (_: unknown, r) => (
                <Button size="small" onClick={() => openAssign(r)}>{r.assignments.length} 条</Button>
              ),
            },
            {
              title: '操作', width: 150,
              render: (_: unknown, r) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
                  <Popconfirm
                    title={`删除「${r.name}」？`}
                    description={`${r.assignments.length} 条分配会一并清空`}
                    onConfirm={() => void remove(r)}
                  >
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          locale={{
            emptyText: (
              <div style={{ padding: '32px 0' }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                  还没有任何范围。先建一个（如「华东门店」勾上 region_l1=华东），再去「分配」把它挂给角色或人。
                </Typography.Paragraph>
                <Button type="primary" onClick={openCreate}>新建范围</Button>
              </div>
            ),
          }}
        />
      </Card>


      <Modal
        title={editing?.id === null ? '新建范围' : `编辑：${form.name}`}
        open={editing !== null}
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Input placeholder="名称（如 门店|东部一区）" value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select value={form.kind} style={{ width: 120 }}
                  onChange={(kind) => setForm({ ...form, kind })}
                  options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
          {form.kind === 'brand' && (
            <Input placeholder="账套，逗号分隔（3120, 64188）" value={form.systemBook}
                   onChange={(e) => setForm({ ...form, systemBook: e.target.value })} />
          )}
          {form.kind === 'store' && (
            <>
              <Space>全部门店 <Switch checked={form.all} onChange={(all) => setForm({ ...form, all })} /></Space>
              {!form.all && (
                <>
                  <Input placeholder="一级战区，逗号分隔（东部战区, 西部战区）" value={form.regionL1}
                         onChange={(e) => setForm({ ...form, regionL1: e.target.value })} />
                  <Input placeholder="二级战区，逗号分隔（东部一区, 西部二区）" value={form.regionName}
                         onChange={(e) => setForm({ ...form, regionName: e.target.value })} />
                </>
              )}
            </>
          )}
          {form.kind === 'category' && (
            <>
              <Space>全部品类 <Switch checked={form.all} onChange={(all) => setForm({ ...form, all })} /></Space>
              {!form.all && (
                <Input placeholder="品类组，逗号分隔（水果, 标品, 耗材）" value={form.categoryGroup}
                       onChange={(e) => setForm({ ...form, categoryGroup: e.target.value })} />
              )}
            </>
          )}
          <Typography.Text type="secondary">
            值必须存在于受控维表（dim_brand / dim_region / dim_item_latest），错值会被服务端点名拒绝。
          </Typography.Text>
        </Space>
      </Modal>

      <Drawer
        title={`分配：${assigning?.name ?? ''}`}
        width={480}
        open={assigning !== null}
        onClose={() => setAssigning(null)}
        extra={<Button type="primary" loading={saving} onClick={() => void saveAssign()}>整组替换</Button>}
      >
        <Typography.Paragraph type="secondary">
          保存即**整组替换**该范围的全部分配（不是追加）。
          优先用「部门」——人调岗自动跟随；「角色」用于跨部门的职能岗；「用户」只作例外。
          「含下级部门」取消勾选 = 只给该部门**直属成员**（战区内分级：战区范围只给战区总，区/店不继承）。
        </Typography.Paragraph>
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          {assignRows.map((a, i) => (
            <Space key={i} style={{ width: '100%' }}>
              <Select value={a.subjectType} style={{ width: 90 }}
                      options={[
                        { value: 'dept', label: '部门' },
                        { value: 'role', label: '角色' },
                        { value: 'user', label: '用户' },
                      ]}
                      onChange={(subjectType) => setAssignRows(assignRows.map((x, j) => j === i ? { ...x, subjectType } : x))} />
              {a.subjectType === 'dept' && (
                <Checkbox
                  checked={a.includeChildren !== false}
                  onChange={(e) => setAssignRows(assignRows.map((x, j) => j === i ? { ...x, includeChildren: e.target.checked } : x))}
                >
                  含下级部门
                </Checkbox>
              )}
              {a.subjectType === 'dept' && depts.length > 0 ? (
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择部门"
                  style={{ width: 260 }}
                  value={a.subjectId === '' ? undefined : a.subjectId}
                  options={depts.map((d) => ({ value: d.ext_id, label: `${d.name}（${d.path}）` }))}
                  onChange={(subjectId) => setAssignRows(assignRows.map((x, j) => j === i ? { ...x, subjectId } : x))}
                />
              ) : (
                <Input placeholder={a.subjectType === 'dept' ? '部门 ext_id' : 'subjectId'} style={{ width: 220 }} value={a.subjectId}
                       onChange={(e) => setAssignRows(assignRows.map((x, j) => j === i ? { ...x, subjectId: e.target.value } : x))} />
              )}
              <Button size="small" danger onClick={() => setAssignRows(assignRows.filter((_, j) => j !== i))}>删</Button>
            </Space>
          ))}
          <Button block onClick={() => setAssignRows([...assignRows, { subjectType: 'dept', subjectId: '' }])}>+ 添加</Button>
        </Space>
      </Drawer>
      <Drawer title="变更历史（data.scope_audit）" width={560} open={auditOpen} onClose={() => setAuditOpen(false)}>
        <Table
          rowKey="id" size="small" loading={auditLoading} dataSource={auditRows} pagination={false}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '操作人', dataIndex: 'actor', width: 150 },
            { title: '动作', dataIndex: 'action', width: 170, render: (v: string) => <Tag>{v}</Tag> },
            { title: '详情', render: (_: unknown, r) => <Typography.Text code style={{ fontSize: 11 }}>{JSON.stringify(r.detail)}</Typography.Text> },
          ]}
        />
      </Drawer>
    </Space>
  )
}
