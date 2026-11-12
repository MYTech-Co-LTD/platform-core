// console/candidates/index.tsx — 「候选池」页签（data:manage；Wave 2.3 补齐 spec 说的「console 可浏览」）。
//
// 定位：自动推导（画像 → 规则筛）产出的候选只进池、不自动上台。本页让人**先看得见再决策**：
// 浏览 / 过滤 / 采用（→ 私有测度）/ 拒绝。判定全在服务端（路由 + 域层 CAS），本页只做展示与转发，
// 不复制任何校验逻辑：409 / 400 的 code 原样回显，别在本页猜「为什么不行」。
//
// 页签只在持 data:manage 时出现（入口按 session.scopes 过滤；API 门卫仍是真闸）。
import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Button, Card, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message,
} from 'antd'
import { apiGet, apiSend, ApiError } from '../lib/api'

type CandidateStatus = 'pending' | 'created' | 'promoted' | 'rejected' | 'expired'
type CandidateOrigin = 'profile' | 'demand'

interface Candidate {
  id: number
  org: string
  relation: string
  expr: { agg: string; column: string; dims?: string[] }
  rationale: string
  confidence: number
  origin: CandidateOrigin
  status: CandidateStatus
  created_at: string
}

const STATUS_LABEL: Record<CandidateStatus, string> = {
  pending: '待处理', created: '已采用', promoted: '已升级', rejected: '已拒绝', expired: '已过期',
}
const STATUS_COLOR: Record<CandidateStatus, string> = {
  pending: 'processing', created: 'success', promoted: 'success', rejected: 'default', expired: 'warning',
}
const ORIGIN_LABEL: Record<CandidateOrigin, string> = { profile: '画像推导', demand: '需求对话' }

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail === undefined ? e.code : `${e.code}：${e.detail}`
  return e instanceof Error ? e.message : String(e)
}

/** 算式的人读形态：`avg(fct_x.amount)` + 维度。 */
function exprText(c: Candidate): string {
  const base = `${c.expr.agg}(${c.expr.column})`
  const dims = c.expr.dims ?? []
  return dims.length === 0 ? base : `${base} 按 ${dims.join('、')}`
}

export default function CandidatesPage() {
  const [rows, setRows] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [status, setStatus] = useState<CandidateStatus | ''>('pending')
  const [origin, setOrigin] = useState<CandidateOrigin | ''>('')
  const [adopting, setAdopting] = useState<Candidate | null>(null)
  const [metricId, setMetricId] = useState('')
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(null)
    try {
      const qs = new URLSearchParams({ limit: '200' })
      if (status !== '') qs.set('status', status)
      if (origin !== '') qs.set('origin', origin)
      const body = (await apiGet(`/metrics/candidates?${qs.toString()}`)) as { candidates?: Candidate[] }
      setRows(Array.isArray(body.candidates) ? body.candidates : [])
    } catch (e) {
      setLoadErr(errText(e))
    } finally {
      setLoading(false)
    }
  }, [status, origin])

  useEffect(() => { void load() }, [load])

  const reject = async (c: Candidate) => {
    try {
      await apiSend(`/metrics/candidates/${c.id}/reject`, 'POST')
      message.success('已拒绝')
      await load()
    } catch (e) {
      message.error(errText(e))
    }
  }

  const openAdopt = (c: Candidate) => {
    setAdopting(c)
    // 预填一个合规 id 骨架（`<源>:<域>:<指标>`），人可改——标识符是人的决定，不替人拍。
    setMetricId('')
    setTitle('')
  }

  const adopt = async () => {
    if (adopting === null) return
    setSaving(true)
    try {
      await apiSend(`/metrics/candidates/${adopting.id}/adopt`, 'POST', {
        id: metricId.trim(),
        ...(title.trim() === '' ? {} : { title: title.trim() }),
      })
      message.success('已采用为私有测度')
      setAdopting(null)
      await load()
    } catch (e) {
      // 服务端会点名原因（ID_RESERVED_BY_L1 / COLUMN_NOT_NUMERIC / DIM_MASKED / METRIC_EXISTS…）
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="候选池"
      extra={(
        <Space wrap>
          <Select
            size="small"
            style={{ width: 110 }}
            value={status}
            onChange={(v) => setStatus(v)}
            options={[
              { value: '', label: '全部状态' },
              ...(Object.keys(STATUS_LABEL) as CandidateStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
            ]}
          />
          <Select
            size="small"
            style={{ width: 110 }}
            value={origin}
            onChange={(v) => setOrigin(v)}
            options={[
              { value: '', label: '全部来源' },
              ...(Object.keys(ORIGIN_LABEL) as CandidateOrigin[]).map((o) => ({ value: o, label: ORIGIN_LABEL[o] })),
            ]}
          />
          <Button size="small" loading={loading} onClick={() => void load()}>刷新</Button>
        </Space>
      )}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        自动推导产出的候选<strong>只进池、不自动上台</strong>。采用后会成为本租户的私有测度（草案口径），
        拒绝是终态，不会在后续生成里复活（人工决策优先于自动规则）。
      </Typography.Paragraph>
      {loadErr !== null && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={loadErr} />}
      <Table<Candidate>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 860 }}
        columns={[
          { title: '关系', dataIndex: 'relation', width: 220, ellipsis: true },
          { title: '算式', render: (_: unknown, r) => exprText(r), ellipsis: true },
          {
            title: '置信度', dataIndex: 'confidence', width: 90,
            render: (v: number) => v.toFixed(2),
          },
          {
            title: '来源', dataIndex: 'origin', width: 100,
            render: (o: CandidateOrigin) => <Tag>{ORIGIN_LABEL[o]}</Tag>,
          },
          {
            title: '状态', dataIndex: 'status', width: 90,
            render: (s: CandidateStatus) => <Tag color={STATUS_COLOR[s]}>{STATUS_LABEL[s]}</Tag>,
          },
          { title: '依据', dataIndex: 'rationale', ellipsis: true },
          {
            title: '操作', width: 140, fixed: 'right',
            render: (_: unknown, r) => (r.status === 'pending'
              ? (
                <Space size={4}>
                  <Button size="small" type="primary" onClick={() => openAdopt(r)}>采用</Button>
                  <Popconfirm title="拒绝这条候选？" description="拒绝是终态，后续自动生成不会复活它。" onConfirm={() => void reject(r)}>
                    <Button size="small" danger>拒绝</Button>
                  </Popconfirm>
                </Space>
              )
              : <Typography.Text type="secondary">—</Typography.Text>),
          },
        ]}
        locale={{
          emptyText: (
            <div style={{ padding: '32px 0' }}>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                这个筛选下没有候选。候选由「画像 → 规则筛」定时生成（每日一次），
                也可以由管理员手动触发一次生成。
              </Typography.Paragraph>
            </div>
          ),
        }}
      />

      <Modal
        title={adopting === null ? '采用候选' : `采用：${exprText(adopting)}`}
        open={adopting !== null}
        confirmLoading={saving}
        okButtonProps={{ disabled: metricId.trim() === '' }}
        onOk={() => void adopt()}
        onCancel={() => setAdopting(null)}
        destroyOnHidden
      >
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Input
            placeholder="指标 id（<源>:<域>:<指标>，如 lemeng:retail:avg_order_value）"
            value={metricId}
            onChange={(e) => setMetricId(e.target.value)}
          />
          <Input
            placeholder="标题（可空，缺省用「关系 聚合(列)」）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Typography.Text type="secondary">
            采用后成为本租户私有测度（草案口径），可在「指标」页继续编辑；id 不能与平台 L1 撞名。
          </Typography.Text>
        </Space>
      </Modal>
    </Card>
  )
}
