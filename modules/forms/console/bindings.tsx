// console/bindings.tsx — 标准审批绑定管理面（OA P2 Task 6 / issue #2385）。
//
// 一个独立 console 条目（/console/forms-bindings，scope=forms:global-manage platformOnly）：
// 列表 / 新建 / 版本 / 发布。绑定 = 「平台代理到企微原生审批模板」的快照：
//   { provider:'wecom_native', processCode, deepLink, name, verifiedChain[], verifiedAt }
// 字段与附件都在企微，平台不存表单值；发布是平台管理员 gate（服务端另有 403 双保险）。
// 与 /console/forms 平级而非子路径——避免既有「表单」菜单条目被收成分组标题（见 manifest 注）。
import { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Descriptions, Empty, Form, Input, Space, Table, Tag, Typography,
} from 'antd'
import { useOutletContext } from 'react-router-dom'
import { ApiError, apiGet, apiSend } from './api'

interface ConsoleContext {
  session: { scopes: string[] }
}

interface BindingBodyView {
  provider?: string
  processCode?: string
  name?: string
  deepLink?: string
  verifiedChain?: unknown
  verifiedAt?: string
}

interface BindingVersion {
  version: number
  status: string
  body: unknown
  publishedAt?: string | null
}

interface BindingSummary {
  assetId: string
  headVersion: number | null
  draftCount: number
  publishedCount: number
  retiredCount: number
  updatedAt: string
  versions: BindingVersion[]
}

const RFC3339_HINT = '2026-11-16T10:00:00Z'

/** 展示用绑定 body：head 有就用 head，否则取最新版本（草稿期也要能看）。 */
function bindingBodyOf(row: BindingSummary): BindingBodyView {
  const source = row.versions.find((v) => v.version === row.headVersion) ?? row.versions[0]
  return (source?.body ?? {}) as BindingBodyView
}

export default function WecomBindingsPage() {
  const { session } = useOutletContext<ConsoleContext>()
  const canPublish = session.scopes.includes('forms:global-manage')

  const [rows, setRows] = useState<BindingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [form] = Form.useForm<{
    assetId: string
    processCode: string
    name: string
    deepLink: string
    verifiedChain: string
    verifiedAt: string
  }>()
  const [creating, setCreating] = useState(false)

  const load = () =>
    apiGet<{ bindings: BindingSummary[] }>('/api/modules/forms/approval-bindings')
      .then((body) => setRows(body.bindings))
      .catch((e) => {
        setRows([])
        setError((e as ApiError).message)
      })
      .finally(() => setLoading(false))

  useEffect(() => {
    void load()
  }, [])

  const describeError = (e: unknown): string => {
    const err = e as ApiError
    return err.detail ? `${err.code}：${err.detail}` : err.message
  }

  const create = async (values: {
    assetId: string
    processCode: string
    name: string
    deepLink: string
    verifiedChain: string
    verifiedAt: string
  }) => {
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const body = {
        provider: 'wecom_native',
        processCode: values.processCode.trim(),
        name: values.name.trim(),
        deepLink: values.deepLink.trim(),
        verifiedChain: values.verifiedChain.split('\n').map((s) => s.trim()).filter((s) => s.length > 0),
        verifiedAt: values.verifiedAt.trim(),
      }
      const out = await apiSend<{ assetId: string; version: number }>(
        'POST', '/api/modules/forms/approval-bindings', { assetId: values.assetId.trim(), body },
      )
      setNotice(`已创建草稿：${out.assetId} v${out.version}——验证证据齐了再点「发布」`)
      form.resetFields()
      await load()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setCreating(false)
    }
  }

  const publishDraft = async (row: BindingSummary) => {
    const draft = row.versions.find((v) => v.status === 'draft')
    if (draft === undefined) {
      setError(`${row.assetId} 没有可发布的草稿`)
      return
    }
    setError(null)
    setNotice(null)
    try {
      await apiSend(
        'POST',
        `/api/modules/forms/approval-bindings/${encodeURIComponent(row.assetId)}/versions/${draft.version}/publish`,
      )
      setNotice(`已发布 ${row.assetId} v${draft.version}`)
      await load()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const dropDraft = async (row: BindingSummary, version: number) => {
    setError(null)
    setNotice(null)
    try {
      await apiSend(
        'DELETE',
        `/api/modules/forms/approval-bindings/${encodeURIComponent(row.assetId)}/versions/${version}`,
      )
      await load()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <div>
      <Typography.Title level={5}>标准审批绑定</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        绑定到企微原生审批模板（processCode + 深链）。表单与附件都在企微，平台只镜像状态；未验证过的绑定不能发布。
      </Typography.Paragraph>

      {error !== null && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      {notice !== null && <Alert type="success" showIcon style={{ marginBottom: 12 }} message={notice} />}

      <Card size="small" title="新建绑定（草稿）" style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
          onFinish={create}
          initialValues={{ provider: 'wecom_native', verifiedAt: new Date().toISOString() }}
        >
          <Space size="middle" wrap align="start">
            <Form.Item name="assetId" label="资产 ID" rules={[{ required: true, message: '形如 expense' }]}>
              <Input placeholder="expense" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '人话名称，agent 选模板用' }]}>
              <Input placeholder="差旅报销（企微标准审批）" style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="processCode" label="processCode" rules={[{ required: true, message: '企微模板编号' }]}>
              <Input placeholder="T1 取证拿到的 process_code" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="deepLink" label="深链（https）" rules={[{ required: true, message: 'https 深链' }]}>
              <Input placeholder="https://open.work.weixin.qq.com/..." style={{ width: 320 }} />
            </Form.Item>
          </Space>
          <Space size="middle" wrap align="start">
            <Form.Item
              name="verifiedChain"
              label="验证证据链（每行一条）"
              rules={[{ required: true, message: '至少一条验证记录' }]}
            >
              <Input.TextArea rows={3} style={{ width: 420 }} placeholder={'2026-11-16 真机提交 SP-01 → 回调到达\n2026-11-16 审批通过 → 状态 approved'} />
            </Form.Item>
            <Form.Item name="verifiedAt" label={`最近验证时间（RFC3339，如 ${RFC3339_HINT}）`} rules={[{ required: true }]}>
              <Input style={{ width: 260 }} />
            </Form.Item>
          </Space>
          <Button type="primary" htmlType="submit" loading={creating}>创建草稿</Button>
        </Form>
      </Card>

      <Table<BindingSummary>
        rowKey="assetId"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: <Empty description="还没有绑定" /> }}
        expandable={{
          expandedRowRender: (row) => (
            <Table<BindingVersion>
              rowKey="version"
              size="small"
              pagination={false}
              dataSource={row.versions}
              columns={[
                { title: '版本', dataIndex: 'version', width: 70, render: (v: number) => `v${v}` },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 90,
                  render: (s: string) => <Tag color={s === 'published' ? 'green' : s === 'retired' ? 'default' : 'gold'}>{s}</Tag>,
                },
                {
                  title: '操作',
                  key: 'action',
                  render: (_, v) => (
                    <Space size={4}>
                      {canPublish && v.status === 'draft' && (
                        <Button type="link" size="small" onClick={() => publishDraft(row)}>发布</Button>
                      )}
                      {v.status === 'draft' && (
                        <Button type="link" size="small" danger onClick={() => dropDraft(row, v.version)}>删除草稿</Button>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          { title: '资产', dataIndex: 'assetId' },
          {
            title: '名称',
            key: 'name',
            render: (_, row) => bindingBodyOf(row).name ?? '—',
          },
          {
            title: 'processCode',
            key: 'processCode',
            render: (_, row) => bindingBodyOf(row).processCode ?? '—',
          },
          {
            title: '当前版本',
            dataIndex: 'headVersion',
            width: 100,
            render: (v: number | null) => (v === null ? '未发布' : `v${v}`),
          },
          { title: '草稿', dataIndex: 'draftCount', width: 70 },
          {
            title: '验证时间',
            key: 'verifiedAt',
            width: 210,
            render: (_, row) => bindingBodyOf(row).verifiedAt ?? '—',
          },
          {
            title: '操作',
            key: 'action',
            width: 120,
            render: (_, row) => (
              <Space size={4}>
                {canPublish && row.draftCount > 0 && (
                  <Button type="link" size="small" onClick={() => publishDraft(row)}>发布草稿</Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Descriptions size="small" column={1} style={{ marginTop: 16 }}>
        <Descriptions.Item label="说明">
          发布要求：processCode / deepLink（https）/ name / verifiedChain（非空）/ verifiedAt（RFC3339）全齐；
          发布后事项模板（mode=approval + provider=wecom_native）才能引用它。
        </Descriptions.Item>
      </Descriptions>
    </div>
  )
}
