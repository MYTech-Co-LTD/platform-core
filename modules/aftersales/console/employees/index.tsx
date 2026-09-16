// employees/index.tsx — 员工信息 + 注册审批（M3a）。
//
// `GET /employees` 回 `{ items }` **无 total**（服务端另有 `MAX_EMPLOYEES` 上限）⇒ 单页展示、
// **不放分页控件**（spec §3.1 已知边界）。
//
// 审批的请求体是 **`{ approveStatus }`**（英文枚举，spec §5 #9：中文是展示层的事、不入库）
// ——以 `routes/masterdata.ts` 的 `ApproveBody` 为准。
import { useCallback, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Table, Tag } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { ApproveStatus, EmployeeItem, Unpaged } from '../../api-types'

/** 枚举 → 展示层中文（spec §5 #9：中文不下库） */
const STATUS_LABEL: Record<ApproveStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
}

export default function EmployeesPage() {
  const load = useCallback(async () => (await apiGet<Unpaged<EmployeeItem>>('/employees')).items, [])
  const { items, loading, error, reload } = useList(load)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{ name: string; phone?: string; storeId?: number }>()

  const approve = async (id: number, approveStatus: ApproveStatus) => {
    try {
      await apiSend(`/employees/${id}/approve`, 'POST', { approveStatus })
      reload()
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
        ...(v.storeId === undefined ? {} : { storeId: v.storeId }),
      })
      setCreating(false)
      form.resetFields()
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '新建失败', content: messageOf(e) })
    }
  }

  return (
    <div>
      <Button type="primary" onClick={() => setCreating(true)} style={{ marginBottom: 12 }}>
        新建员工
      </Button>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<EmployeeItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '姓名', dataIndex: 'name' },
          { title: '手机号', dataIndex: 'phone', width: 140 },
          { title: '门店 ID', dataIndex: 'storeId', width: 100, render: (v: number | null) => v ?? '—' },
          { title: 'openid', dataIndex: 'openId', render: (v: string) => v || '—' },
          {
            title: '审批状态',
            dataIndex: 'approveStatus',
            width: 110,
            render: (v: ApproveStatus) => <Tag>{STATUS_LABEL[v] ?? v}</Tag>,
          },
          {
            title: '操作',
            width: 160,
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
          {/* InputNumber（不是 Input type=number）：后者给的是**字符串**，而 EmployeeBody
              的 storeId 是 z.number() ⇒ 字符串会被 zod 判 INVALID_BODY */}
          <Form.Item name="storeId" label="门店 ID（可选）">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
