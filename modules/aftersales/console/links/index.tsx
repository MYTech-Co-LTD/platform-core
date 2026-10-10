// console/links/index.tsx — 身份绑定管理页（账户统一 Task 8）。
//
// `GET /identity-links` 回 `{ items }` **无 total** ⇒ 单页展示、不放分页控件
// （与 approvals/rules/employees/stores 同一条已知边界）。
//
// ⚠️ 手机号列直接渲染服务端 `phoneMasked`（宿主边界已按「前3后2中间****」掩码）——前端
// **不再**二次掩码：掩一次就够，叠一次只会把「138****11」变成更短的怪串，两层规则还会漂移。
// 外部号（openid/企微号）不是手机号，不掩。
// 操作面（设计稿 §2 人工修正）：pending→确认/改绑；active→改绑/解绑；disputed→恢复（confirm
// 缺省目标=行上账户）/改绑；revoked 终态无操作。audit 执行人由服务端取会话，前端不传。
import { useCallback, useState } from 'react'
import { Alert, Button, Input, Modal, Table, Tag } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { IdentityLinkView } from '@platform/sdk'

const PROVIDER_LABEL: Record<IdentityLinkView['provider'], string> = { 'wechat-oa': '公众号', wecom: '企业微信' }
const STATUS_LABEL: Record<IdentityLinkView['status'], string> = {
  pending: '待确认',
  active: '已绑定',
  revoked: '已解绑',
  disputed: '争议中',
}
const STATUS_COLOR: Record<IdentityLinkView['status'], string> = {
  pending: 'orange',
  active: 'green',
  revoked: 'default',
  disputed: 'red',
}
const VIA_LABEL: Record<NonNullable<IdentityLinkView['boundVia']>, string> = { auto: '自动', manual: '人工' }

export default function LinksPage() {
  const load = useCallback(
    async () => (await apiGet<{ items: IdentityLinkView[] }>('/identity-links')).items,
    [],
  )
  const { items, loading, error, reload } = useList(load)
  const [busy, setBusy] = useState<number | null>(null)
  const [rebind, setRebind] = useState<IdentityLinkView | null>(null)
  const [target, setTarget] = useState('')

  const openRebind = (row: IdentityLinkView) => {
    setTarget('')
    setRebind(row)
  }

  const runOp = async (row: IdentityLinkView, op: () => Promise<unknown>) => {
    setBusy(row.id)
    try {
      await op()
      setRebind(null)
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '操作失败', content: messageOf(e), okText: '确定' })
    } finally {
      setBusy(null)
    }
  }

  const confirmRow = (row: IdentityLinkView) =>
    runOp(row, () => apiSend(`/identity-links/${row.id}/confirm`, 'POST'))
  const revokeRow = (row: IdentityLinkView) =>
    runOp(row, () => apiSend(`/identity-links/${row.id}/revoke`, 'POST'))
  const submitRebind = () => {
    if (rebind === null) return
    return runOp(rebind, () => apiSend(`/identity-links/${rebind.id}/rebind`, 'POST', { casdoorName: target.trim() }))
  }

  return (
    <div>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<IdentityLinkView>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          {
            title: '渠道',
            dataIndex: 'provider',
            width: 100,
            render: (v: IdentityLinkView['provider']) => <Tag>{PROVIDER_LABEL[v]}</Tag>,
          },
          { title: '外部号', dataIndex: 'externalId', width: 200 },
          { title: '账户', dataIndex: 'casdoorName', width: 140 },
          // 服务端掩码值原样展示；未采集手机号 ⇒ —
          { title: '手机号', dataIndex: 'phoneMasked', width: 120, render: (v: string | null) => v ?? '—' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v: IdentityLinkView['status']) => <Tag color={STATUS_COLOR[v]}>{STATUS_LABEL[v]}</Tag>,
          },
          {
            title: '绑定方式',
            dataIndex: 'boundVia',
            width: 90,
            render: (v: IdentityLinkView['boundVia']) => (v === null ? '—' : VIA_LABEL[v]),
          },
          {
            title: '操作',
            width: 190,
            render: (_: unknown, a: IdentityLinkView) => {
              if (a.status === 'pending') {
                return (
                  <>
                    <Button size="small" type="primary" loading={busy === a.id} onClick={() => void confirmRow(a)}>
                      确认
                    </Button>{' '}
                    <Button size="small" onClick={() => openRebind(a)}>
                      改绑
                    </Button>
                  </>
                )
              }
              if (a.status === 'active') {
                return (
                  <>
                    <Button size="small" onClick={() => openRebind(a)}>
                      改绑
                    </Button>{' '}
                    <Button size="small" danger loading={busy === a.id} onClick={() => void revokeRow(a)}>
                      解绑
                    </Button>
                  </>
                )
              }
              if (a.status === 'disputed') {
                return (
                  <>
                    <Button size="small" type="primary" loading={busy === a.id} onClick={() => void confirmRow(a)}>
                      恢复
                    </Button>{' '}
                    <Button size="small" onClick={() => openRebind(a)}>
                      改绑
                    </Button>
                  </>
                )
              }
              return <span>—</span>
            },
          },
        ]}
      />
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
    </div>
  )
}
