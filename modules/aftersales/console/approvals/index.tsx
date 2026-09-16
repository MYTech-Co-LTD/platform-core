// approvals/index.tsx — 员工登记/变更申请的审批（M3b-1 / spec §2.5）。
//
// `GET /employee-approvals` 回 `{ items }` **无 total** ⇒ 单页展示、不放分页控件
// （与 rules/employees/stores 同一条已知边界）。
//
// 与 M3a 的「员工」页签**不是一回事**：那个直接改 employee 的 approve_status；
// 这里决的是**申请**，通过后服务端按申请内容写回档案（单事务）。
import { useCallback, useState } from 'react'
import { Alert, Button, Modal, Table, Tag } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { EmployeeApprovalItem, Unpaged } from '../../api-types'

const TYPE_LABEL: Record<EmployeeApprovalItem['approveType'], string> = { register: '注册', change: '变更' }
const STATUS_LABEL: Record<EmployeeApprovalItem['status'], string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
}
const STATUS_COLOR: Record<EmployeeApprovalItem['status'], string> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
}

const FIELD_LABEL: Record<string, string> = { name: '姓名', phone: '手机号', storeIds: '门店' }

/**
 * 把申请内容摊成一行「字段: 值」。
 * register 与 change 的**显示内容都在 new_info**（change 只含实际变了的字段，spec §2.5）。
 */
function diffText(a: EmployeeApprovalItem): string {
  const parts = Object.entries(a.newInfo).map(([k, v]) => {
    const label = FIELD_LABEL[k] ?? k
    const value = Array.isArray(v) ? v.join('/') : String(v ?? '')
    return `${label}: ${value || '（空）'}`
  })
  return parts.length > 0 ? parts.join('；') : '—'
}

export default function ApprovalsPage() {
  const load = useCallback(
    async () => (await apiGet<Unpaged<EmployeeApprovalItem>>('/employee-approvals')).items,
    [],
  )
  const { items, loading, error, reload } = useList(load)
  const [busy, setBusy] = useState<number | null>(null)

  const decide = async (id: number, decision: 'approve' | 'reject') => {
    setBusy(id)
    try {
      await apiSend(`/employee-approvals/${id}/decide`, 'POST', { decision })
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '操作失败', content: messageOf(e), okText: '确定' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<EmployeeApprovalItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '申请人', dataIndex: 'openId', width: 200 },
          {
            title: '类型',
            dataIndex: 'approveType',
            width: 90,
            render: (v: EmployeeApprovalItem['approveType']) => <Tag>{TYPE_LABEL[v]}</Tag>,
          },
          { title: '内容', render: (_: unknown, a: EmployeeApprovalItem) => diffText(a) },
          {
            title: '状态',
            dataIndex: 'status',
            width: 110,
            render: (v: EmployeeApprovalItem['status']) => <Tag color={STATUS_COLOR[v]}>{STATUS_LABEL[v]}</Tag>,
          },
          {
            title: '操作',
            width: 170,
            render: (_: unknown, a: EmployeeApprovalItem) =>
              a.status === 'pending' ? (
                <>
                  <Button
                    size="small"
                    type="primary"
                    loading={busy === a.id}
                    onClick={() => void decide(a.id, 'approve')}
                  >
                    通过
                  </Button>{' '}
                  <Button size="small" danger loading={busy === a.id} onClick={() => void decide(a.id, 'reject')}>
                    驳回
                  </Button>
                </>
              ) : (
                <span>{a.decidedBy ?? '—'}</span>
              ),
          },
        ]}
      />
    </div>
  )
}
