// employees/index.tsx — 人员：员工档案 + 注册审批 + 身份绑定（#2941）。
//
// 身份绑定**不落员工表**：它是 platform.identity_link 的派生视图。当前按公众号 openid
// （employee.open_id = identity_link.external_id）关联；企微/无 openid 的绑定进「未归属绑定」。
// 写操作仍走宿主提供的 `/identity-links/:id/*`，本页不直连 platform。
//
// 审批请求体是 `{ approveStatus }`（英文枚举，spec §5 #9：中文是展示层的事、不入库）。
import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Button, Descriptions, Drawer, Form, Input, Modal, Segmented, Space, Table, Typography,
} from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { ListCard, Status } from '../lib/ui'
import type { ApproveStatus, EmployeeItem, Paged } from '../../api-types'
import type { IdentityLinkView } from '@platform/sdk'

const STATUS_LABEL: Record<ApproveStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
}
const STATUS_TONE: Record<ApproveStatus, 'warn' | 'ok' | 'danger'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'danger',
}
const PROVIDER_LABEL: Record<IdentityLinkView['provider'], string> = {
  'wechat-oa': '公众号',
  wecom: '企业微信',
}
const LINK_STATUS_LABEL: Record<IdentityLinkView['status'], string> = {
  pending: '待确认',
  active: '已绑定',
  revoked: '已解绑',
  disputed: '争议中',
}
const LINK_STATUS_TONE: Record<IdentityLinkView['status'], 'warn' | 'ok' | 'muted' | 'danger'> = {
  pending: 'warn',
  active: 'ok',
  revoked: 'muted',
  disputed: 'danger',
}
const VIA_LABEL: Record<NonNullable<IdentityLinkView['boundVia']>, string> = {
  auto: '自动',
  manual: '人工',
}

type LinkTone = 'ok' | 'warn' | 'danger' | 'muted'

/** 一次性分页拉全：员工量级不大；分页在这里只影响渲染。 */
async function fetchAllEmployees(): Promise<EmployeeItem[]> {
  const all: EmployeeItem[] = []
  for (let page = 1; page <= 100; page++) {
    const paged = await apiGet<Paged<EmployeeItem>>(`/employees?page=${page}&size=100`)
    all.push(...paged.items)
    if (all.length >= paged.total || paged.items.length === 0) break
  }
  return all
}

/** 当前唯一的稳定关联：公众号 openid。企微暂无账户桥。 */
function linksOf(employee: EmployeeItem, all: IdentityLinkView[]): IdentityLinkView[] {
  if (!employee.openId) return []
  return all.filter((l) => l.provider === 'wechat-oa' && l.externalId === employee.openId)
}

function summaryOf(rows: IdentityLinkView[]): { text: string; tone: LinkTone } {
  if (rows.length === 0) return { text: '未绑定', tone: 'muted' }
  if (rows.some((r) => r.status === 'disputed')) return { text: '争议', tone: 'danger' }
  if (rows.some((r) => r.status === 'pending')) return { text: '待确认', tone: 'warn' }
  const active = rows.filter((r) => r.status === 'active')
  if (active.length > 0) {
    const channels = [...new Set(active.map((r) => PROVIDER_LABEL[r.provider]))]
    return {
      text: `已绑定 · ${channels.join('+')}${active.length > 1 ? `（${active.length}）` : ''}`,
      tone: 'ok',
    }
  }
  return { text: '已解绑', tone: 'muted' }
}

function BindingTable(props: {
  rows: IdentityLinkView[]
  emptyText: string
  busy: number | null
  onConfirm: (row: IdentityLinkView) => void
  onRebind: (row: IdentityLinkView) => void
  onRevoke: (row: IdentityLinkView) => void
}) {
  return (
    <Table<IdentityLinkView>
      rowKey="id"
      size="small"
      dataSource={props.rows}
      pagination={false}
      locale={{ emptyText: props.emptyText }}
      columns={[
        {
          title: '渠道', dataIndex: 'provider', width: 100,
          render: (v: IdentityLinkView['provider']) => PROVIDER_LABEL[v],
        },
        { title: '外部号', dataIndex: 'externalId', width: 190 },
        { title: '账户', dataIndex: 'casdoorName', width: 140, render: (v: string | null) => v || '—' },
        { title: '手机号', dataIndex: 'phoneMasked', width: 120, render: (v: string | null) => v ?? '—' },
        {
          title: '状态', dataIndex: 'status', width: 90,
          render: (v: IdentityLinkView['status']) => (
            <Status tone={LINK_STATUS_TONE[v]}>{LINK_STATUS_LABEL[v]}</Status>
          ),
        },
        {
          title: '绑定方式', dataIndex: 'boundVia', width: 90,
          render: (v: IdentityLinkView['boundVia']) => (v === null ? '—' : VIA_LABEL[v]),
        },
        {
          title: '操作', width: 180,
          render: (_: unknown, link: IdentityLinkView) => {
            if (link.status === 'pending') {
              return (
                <>
                  <Button
                    size="small" type="primary" loading={props.busy === link.id}
                    onClick={() => props.onConfirm(link)}
                  >
                    确认
                  </Button>{' '}
                  <Button size="small" onClick={() => props.onRebind(link)}>改绑</Button>
                </>
              )
            }
            if (link.status === 'active') {
              return (
                <>
                  <Button size="small" onClick={() => props.onRebind(link)}>改绑</Button>{' '}
                  <Button
                    size="small" danger loading={props.busy === link.id}
                    onClick={() => props.onRevoke(link)}
                  >
                    解绑
                  </Button>
                </>
              )
            }
            if (link.status === 'disputed') {
              return (
                <>
                  <Button
                    size="small" type="primary" loading={props.busy === link.id}
                    onClick={() => props.onConfirm(link)}
                  >
                    恢复
                  </Button>{' '}
                  <Button size="small" onClick={() => props.onRebind(link)}>改绑</Button>
                </>
              )
            }
            return <span>—</span>
          },
        },
      ]}
    />
  )
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<EmployeeItem[]>([])
  const [links, setLinks] = useState<IdentityLinkView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [view, setView] = useState<'people' | 'unmatched'>('people')
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{ name: string; phone?: string; storeCode?: string }>()
  const [drawer, setDrawer] = useState<EmployeeItem | null>(null)
  const [rebind, setRebind] = useState<IdentityLinkView | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState<number | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    setLinkError(null)
    const [empResult, linkResult] = await Promise.allSettled([
      fetchAllEmployees(),
      apiGet<{ items: IdentityLinkView[] }>('/identity-links'),
    ])
    if (empResult.status === 'fulfilled') {
      setEmployees(empResult.value)
    } else {
      setEmployees([])
      setError(messageOf(empResult.reason))
    }
    // 绑定是增补面：宿主未注入 identityLinks 端口（503）时，员工档案仍必须可看。
    if (linkResult.status === 'fulfilled') {
      setLinks(linkResult.value.items)
    } else {
      setLinks([])
      setLinkError(messageOf(linkResult.reason))
    }
    setLoading(false)
  }, [])

  useEffect(() => { void reload() }, [reload])

  const approve = async (id: number, approveStatus: ApproveStatus) => {
    try {
      await apiSend(`/employees/${id}/approve`, 'POST', { approveStatus })
      await reload()
    } catch (e: unknown) {
      Modal.error({ title: '审批失败', content: messageOf(e) })
    }
  }

  const create = async () => {
    const v = await form.validateFields()
    try {
      await apiSend('/employees', 'POST', {
        name: v.name,
        ...(v.phone ? { phone: v.phone } : {}),
        ...(v.storeCode ? { storeCode: v.storeCode } : {}),
      })
      setCreating(false)
      form.resetFields()
      await reload()
    } catch (e: unknown) {
      Modal.error({ title: '新建失败', content: messageOf(e) })
    }
  }

  const runLinkOp = async (row: IdentityLinkView, op: () => Promise<unknown>) => {
    setBusy(row.id)
    try {
      await op()
      setRebind(null)
      await reload()
    } catch (e: unknown) {
      Modal.error({ title: '操作失败', content: messageOf(e), okText: '确定' })
    } finally {
      setBusy(null)
    }
  }

  const confirmLink = (row: IdentityLinkView) =>
    runLinkOp(row, () => apiSend(`/identity-links/${row.id}/confirm`, 'POST'))
  const revokeLink = (row: IdentityLinkView) =>
    runLinkOp(row, () => apiSend(`/identity-links/${row.id}/revoke`, 'POST'))
  const submitRebind = () => {
    if (rebind === null) return
    return runLinkOp(rebind, () =>
      apiSend(`/identity-links/${rebind.id}/rebind`, 'POST', { casdoorName: target.trim() }))
  }

  const knownOpenIds = new Set(employees.map((e) => e.openId).filter((v) => v !== ''))
  const unmatched = links.filter(
    (l) => l.provider !== 'wechat-oa' || !knownOpenIds.has(l.externalId),
  )
  const drawerLinks = drawer === null ? [] : linksOf(drawer, links)

  return (
    <ListCard>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'people' | 'unmatched')}
          options={[
            { value: 'people', label: `人员档案（${employees.length}）` },
            { value: 'unmatched', label: `未归属绑定（${unmatched.length}）` },
          ]}
        />
        {view === 'people' ? (
          <Button type="primary" onClick={() => setCreating(true)}>新建员工</Button>
        ) : null}
      </Space>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {linkError !== null ? (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="身份绑定数据暂不可用，人员档案仍可查看。"
        />
      ) : null}

      {view === 'people' ? (
        <Table<EmployeeItem>
          rowKey="id"
          size="small"
          dataSource={employees}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '还没有员工档案。员工在公众号登记并审批通过后会出现在这里。' }}
          columns={[
            { title: '姓名', dataIndex: 'name' },
            { title: '手机号', dataIndex: 'phone', width: 140 },
            { title: '门店编码', dataIndex: 'storeCode', width: 110, render: (v: string | null) => v || '—' },
            {
              title: '身份绑定', width: 210,
              render: (_: unknown, r: EmployeeItem) => {
                if (linkError !== null) return <Status tone="muted">绑定信息不可用</Status>
                const s = summaryOf(linksOf(r, links))
                return (
                  <Typography.Link onClick={() => setDrawer(r)}>
                    <Status tone={s.tone}>{s.text}</Status>
                  </Typography.Link>
                )
              },
            },
            {
              title: '审批状态', dataIndex: 'approveStatus', width: 110,
              render: (v: ApproveStatus) => (
                <Status tone={STATUS_TONE[v] ?? 'muted'}>{STATUS_LABEL[v] ?? v}</Status>
              ),
            },
            {
              title: '操作', width: 160,
              render: (_: unknown, r: EmployeeItem) =>
                r.approveStatus === 'pending' ? (
                  <>
                    <Button size="small" type="primary" onClick={() => void approve(r.id, 'approved')}>
                      通过
                    </Button>{' '}
                    <Button size="small" danger onClick={() => void approve(r.id, 'rejected')}>
                      驳回
                    </Button>
                  </>
                ) : null,
            },
          ]}
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info" showIcon
            message="按公众号 openid 关联员工；企业微信/无 openid 的绑定会出现在这里。"
          />
          <BindingTable
            rows={unmatched}
            emptyText="没有未归属绑定。"
            busy={busy}
            onConfirm={(r) => void confirmLink(r)}
            onRebind={(r) => { setTarget(''); setRebind(r) }}
            onRevoke={(r) => void revokeLink(r)}
          />
        </Space>
      )}

      <Modal
        title="新建员工"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => void create()}
        okText="确定"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="姓名" rules={[{ required: true, max: 200 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ max: 50 }]}>
            <Input />
          </Form.Item>
          {/* EmployeeBody 的字段是 storeCode（不是 storeId）——门店编码是 data.dim_branch 的自然键 */}
          <Form.Item name="storeCode" label="门店编码（可选）" rules={[{ max: 64 }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={drawer !== null}
        title={drawer ? `${drawer.name} · 身份绑定` : '身份绑定'}
        width={760}
        onClose={() => setDrawer(null)}
      >
        {drawer ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions
              size="small" column={2}
              items={[
                { key: 'name', label: '姓名', children: drawer.name },
                { key: 'phone', label: '手机号', children: drawer.phone || '—' },
                { key: 'store', label: '门店编码', children: drawer.storeCode || '—' },
                {
                  key: 'approve', label: '审批状态',
                  children: <Status tone={STATUS_TONE[drawer.approveStatus]}>{STATUS_LABEL[drawer.approveStatus]}</Status>,
                },
                { key: 'openid', label: '公众号 openid', children: drawer.openId || '—' },
              ]}
            />
            <BindingTable
              rows={drawerLinks}
              emptyText="该员工还没有身份绑定。"
              busy={busy}
              onConfirm={(r) => void confirmLink(r)}
              onRebind={(r) => { setTarget(''); setRebind(r) }}
              onRevoke={(r) => void revokeLink(r)}
            />
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={rebind === null ? '' : `改绑外部号 ${rebind.externalId}`}
        open={rebind !== null}
        onOk={() => void submitRebind()}
        onCancel={() => setRebind(null)}
        okText="确定"
        cancelText="取消"
      >
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Casdoor 账户名"
        />
      </Modal>
    </ListCard>
  )
}
