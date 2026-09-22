// rules/index.tsx — 售后规则 CRUD（M3a）。
//
// `GET /rules` 已回 `{items,total,page,size}`（#155，与 /products 同形）⇒ **可真分页**；
// 但 console 分页重构不在 #155 ⇒ 本页仍单页展示、**不放分页控件**（不摆假页码）。
import { useCallback, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Table } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { useList } from '../lib/useList'
import type { Paged, RuleItem } from '../../api-types'

export default function RulesPage() {
  const load = useCallback(async () => (await apiGet<Paged<RuleItem>>('/rules')).items, [])
  const { items, loading, error, reload } = useList(load)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm<{ name: string; refundRatio: number; remark?: string }>()

  const create = async () => {
    const v = await form.validateFields()
    try {
      await apiSend('/rules', 'POST', {
        name: v.name,
        refundRatio: v.refundRatio,
        ...(v.remark ? { remark: v.remark } : {}),
      })
      setCreating(false)
      form.resetFields()
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '新建失败', content: messageOf(e) })
    }
  }

  const remove = async (id: number) => {
    try {
      await apiSend(`/rules/${id}`, 'DELETE')
      reload()
    } catch (e: unknown) {
      Modal.error({ title: '删除失败', content: messageOf(e) })
    }
  }

  return (
    <div>
      <Button type="primary" onClick={() => setCreating(true)} style={{ marginBottom: 12 }}>
        新建规则
      </Button>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
      <Table<RuleItem>
        rowKey="id"
        dataSource={items}
        loading={loading}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '退款比例',
            dataIndex: 'refundRatio',
            width: 120,
            // 服务端出口是 toRatioOrNull ⇒ 可能是 null（类型如实标了）
            render: (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`),
          },
          { title: '说明', dataIndex: 'remark', render: (v: string | null) => v ?? '—' },
          {
            title: '操作',
            width: 100,
            render: (_: unknown, r: RuleItem) => (
              <Popconfirm
                title={`删除规则「${r.name}」？`}
                onConfirm={() => void remove(r.id)}
                okText="确定"
                cancelText="取消"
              >
                <Button danger size="small">
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Modal
        title="新建规则"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => void create()}
        okText="确定"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, max: 200 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="refundRatio" label="退款比例（0–1）" rules={[{ required: true }]}>
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="说明">
            <Input.TextArea rows={2} maxLength={2000} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
