// console/FormsList.tsx — 表单列表页（#718）+ AI 起草入口与发布门（#724）。
//
// 本页承担 ADR §13 的运营形态：控制台**只列表 + 开关**，表单由 AI 起草；
// 但**发布是人唯一的 gate**（§14.1）——所以这里只有「生成草稿」（forms:manage）与
// 「发布」（forms:publish）两个动作，没有表单编辑器（要改就让 AI 再起草）。
import { useEffect, useState } from 'react'
import { Alert, Button, Card, Input, Space, Table, Typography } from 'antd'
import { useNavigate, useOutletContext } from 'react-router-dom'
import { ApiError, apiGet, apiSend } from './api'
import type { DefSummary } from './api'

interface ConsoleContext {
  session: { scopes: string[] }
}

export default function FormsList() {
  const navigate = useNavigate()
  const { session } = useOutletContext<ConsoleContext>()
  const canFill = session.scopes.includes('forms:fill')
  const canManage = session.scopes.includes('forms:manage')
  const canPublish = session.scopes.includes('forms:publish')

  const [defs, setDefs] = useState<DefSummary[]>([])
  const [loading, setLoading] = useState(true)

  // AI 起草
  const [desc, setDesc] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [genDone, setGenDone] = useState<string | null>(null)

  const load = () =>
    apiGet<{ defs: DefSummary[] }>('/api/modules/forms/defs')
      .then((body) => setDefs(body.defs))
      .catch(() => setDefs([]))
      .finally(() => setLoading(false))

  useEffect(() => {
    void load()
  }, [])

  const generate = async () => {
    setGenerating(true)
    setGenError(null)
    setGenDone(null)
    try {
      const out = await apiSend<{ assetId: string; version: number; repairUsed: boolean }>(
        'POST',
        '/api/modules/forms/generate',
        { description: desc },
      )
      setGenDone(
        `已生成草稿：${out.assetId}（v${out.version}${out.repairUsed ? '，经一次修正' : ''}）——` +
          '校验通过后点「发布」才可填报',
      )
      setDesc('')
      await load()
    } catch (e) {
      const err = e as ApiError
      setGenError(err.detail ? `${err.code}：${err.detail}` : err.message)
    } finally {
      setGenerating(false)
    }
  }

  /** 发布该表单**最新的 draft**（版本号由服务端数据决定，不由人填）。 */
  const publish = async (assetId: string) => {
    setGenError(null)
    try {
      const detail = await apiGet<{ versions: { version: number; status: string }[] }>(
        `/api/modules/forms/defs/${encodeURIComponent(assetId)}`,
      )
      const draft = detail.versions.find((v) => v.status === 'draft')
      if (draft === undefined) {
        setGenError(`${assetId} 没有可发布的草稿`)
        return
      }
      await apiSend('POST', `/api/modules/forms/defs/${encodeURIComponent(assetId)}/versions/${draft.version}/publish`)
      await load()
    } catch (e) {
      const err = e as ApiError
      setGenError(err.detail ? `${err.code}：${err.detail}` : err.message)
    }
  }

  return (
    <div>
      <Typography.Title level={5}>表单</Typography.Title>

      {canManage && (
        <Card size="small" title="AI 起草" style={{ marginBottom: 16 }}>
          <Input.TextArea
            rows={3}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="用一句话描述要采集什么（字段、取值范围、必填、条件显隐…），例如：门店巡检登记，含巡检人、问题级别、补充说明；选「严重」时必须填处理时限"
            maxLength={2000}
            disabled={generating}
          />
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" onClick={generate} loading={generating} disabled={desc.trim().length === 0}>
              生成草稿
            </Button>
            <Typography.Text type="secondary">生成的是草稿，需点「发布」后才可填报</Typography.Text>
          </Space>
          {genDone !== null && <Alert type="success" showIcon style={{ marginTop: 8 }} message={genDone} />}
          {genError !== null && <Alert type="error" showIcon style={{ marginTop: 8 }} message={genError} />}
        </Card>
      )}

      <Table<DefSummary>
        rowKey="assetId"
        size="small"
        loading={loading}
        dataSource={defs}
        pagination={false}
        columns={[
          { title: '表单', dataIndex: 'assetId' },
          {
            title: '当前版本',
            dataIndex: 'headVersion',
            render: (v: number | null) => (v === null ? '未发布' : `v${v}`),
          },
          { title: '草稿', dataIndex: 'draftCount', width: 70 },
          { title: '已发布', dataIndex: 'publishedCount', width: 80 },
          { title: '已退役', dataIndex: 'retiredCount', width: 80 },
          {
            title: '操作',
            key: 'action',
            width: 130,
            render: (_, record) => (
              <Space size={4}>
                {canPublish && record.headVersion === null && record.draftCount > 0 && (
                  <Button type="link" size="small" onClick={() => publish(record.assetId)}>
                    发布
                  </Button>
                )}
                {canFill && record.headVersion !== null && (
                  <Button type="link" size="small" onClick={() => navigate(`/console/forms/fill/${record.assetId}`)}>
                    填报
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </div>
  )
}
