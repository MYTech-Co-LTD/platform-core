// console/candidates/index.tsx — 「候选池」页签（data:manage；Wave 2.3 补齐 spec 的「console 可浏览」）。
//
// **单页双层**（2026-11-12 与用户定案）：不做按角色的多页面。同一页两种读法——
//   ① 默认层（业务读）：一张卡一句人话 + 两个动作「加进我的指标 / 不要」；
//   ② 展开层（专业读）：关系 / 算式 / 维度 / 置信度 / 证据 JSON，收在 `<TechDetails>` 里。
// 判定全部委托服务端（路由 + 域层 CAS），本页不复制校验；错误走 `humanError()`：
// 主句是人话，原码与 detail 收在技术细节里。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Modal, Select, Space, Tag, Typography, message } from 'antd'
import { apiGet, apiSend } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'
import { TechDetails } from '../components/TechDetails'
import { Explain } from '../components/Explain'

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
  pending: '待处理', created: '已加入', promoted: '已升级', rejected: '已忽略', expired: '已过期',
}
const STATUS_COLOR: Record<CandidateStatus, string> = {
  pending: 'processing', created: 'success', promoted: 'success', rejected: 'default', expired: 'warning',
}
const ORIGIN_LABEL: Record<CandidateOrigin, string> = { profile: '系统自动发现', demand: '来自需求对话' }
/** 聚合函数的业务说法（默认层不出现 sum/avg 这类词）。 */
const AGG_LABEL: Record<string, string> = {
  sum: '合计', avg: '平均', min: '最小值', max: '最大值', count: '条数', count_distinct: '去重条数',
}
const aggLabel = (agg: string): string => AGG_LABEL[agg] ?? agg

/** 关系的最后一段（默认层不显示 `staging.` 这类库前缀）。 */
const relLabel = (relation: string): string => relation.split('.').filter(Boolean).pop() ?? relation
/** 建议指标名：`<域>:<表>:<列>_<聚合>`，三段小写蛇形（与平台的指标命名规则同形）。 */
function suggestId(c: Candidate): string {
  const seg = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x'
  return `custom:${seg(relLabel(c.relation))}:${seg(c.expr.column)}_${seg(c.expr.agg)}`
}

export default function CandidatesPage() {
  const [rows, setRows] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<HumanError | null>(null)
  const [status, setStatus] = useState<CandidateStatus | ''>('pending')
  const [origin, setOrigin] = useState<CandidateOrigin | ''>('')
  const [adopting, setAdopting] = useState<Candidate | null>(null)
  const [metricId, setMetricId] = useState('')
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({ limit: '200' })
      if (status !== '') qs.set('status', status)
      if (origin !== '') qs.set('origin', origin)
      const body = (await apiGet(`/metrics/candidates?${qs.toString()}`)) as { candidates?: Candidate[] }
      setRows(Array.isArray(body.candidates) ? body.candidates : [])
    } catch (e) {
      setErr(humanError(e))
    } finally {
      setLoading(false)
    }
  }, [status, origin])

  useEffect(() => { void load() }, [load])

  const reject = async (c: Candidate) => {
    setErr(null)
    try {
      await apiSend(`/metrics/candidates/${c.id}/reject`, 'POST')
      message.success('已忽略，以后不会再把这条推给你')
      await load()
    } catch (e) {
      setErr(humanError(e))
    }
  }

  const openAdopt = (c: Candidate) => {
    setAdopting(c)
    setMetricId(suggestId(c))
    setTitle(`${relLabel(c.relation)} ${c.expr.column} ${aggLabel(c.expr.agg)}`)
  }

  const adopt = async () => {
    if (adopting === null) return
    setSaving(true)
    setErr(null)
    try {
      await apiSend(`/metrics/candidates/${adopting.id}/adopt`, 'POST', {
        id: metricId.trim(),
        ...(title.trim() === '' ? {} : { title: title.trim() }),
      })
      message.success('已加入「我的指标」，可以继续去指标页完善')
      setAdopting(null)
      await load()
    } catch (e) {
      setErr(humanError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="可能的指标"
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
            style={{ width: 130 }}
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
        系统每天从已接入的数据里找「可能是你想要的指标」，<strong>不会自动上线</strong>。
        觉得有用就点「加进我的指标」，没用就点「不要」——忽略过的不会再推给你。
      </Typography.Paragraph>

      {err !== null && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={err.text}
          description={(
            <TechDetails title="技术细节">
              <div>错误码：{err.code}</div>
              {err.detail !== undefined && <div>定位信息：{err.detail}</div>}
            </TechDetails>
          )}
        />
      )}

      {!loading && rows.length === 0
        ? (
          <Empty
            description={(
              <span>
                这个筛选下没有候选。系统每天自动找一次；如果你刚接入新数据源，等下一轮即可。
              </span>
            )}
          />
        )
        : rows.map((r) => (
          <Card key={r.id} size="small" style={{ marginBottom: 10 }}>
            <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
              <div style={{ minWidth: 260, flex: 1 }}>
                <Space size={6} wrap>
                  <Typography.Text strong style={{ fontSize: 15 }}>
                    {relLabel(r.relation)} 的 {r.expr.column}（{aggLabel(r.expr.agg)}
                    {(r.expr.dims ?? []).length > 0 ? `，按 ${(r.expr.dims ?? []).join('、')} 拆分` : ''}）
                  </Typography.Text>
                  <Tag color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Tag>
                  <Tag>{ORIGIN_LABEL[r.origin]}</Tag>
                </Space>
                <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 13 }}>
                  {r.rationale}
                </Typography.Paragraph>
                <TechDetails>
                  <div>关系：{r.relation}</div>
                  <div>算式：{r.expr.agg}({r.expr.column}){(r.expr.dims ?? []).length > 0 ? `，维度 ${(r.expr.dims ?? []).join(', ')}` : ''}</div>
                  <div><Explain term="confidence" />：{r.confidence.toFixed(2)}　来源：{r.origin}　候选 id：{r.id}</div>
                  <div>产生时间：{r.created_at}</div>
                </TechDetails>
              </div>
              {r.status === 'pending' && (
                <Space>
                  <Button type="primary" onClick={() => openAdopt(r)}>加进我的指标</Button>
                  <Button onClick={() => void reject(r)}>不要</Button>
                </Space>
              )}
            </Space>
          </Card>
        ))}
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
        想批量处理？这里一屏最多 200 条，按「待处理」筛选后逐条点即可；全部处理完页面会变空。
      </Typography.Paragraph>

      <Modal
        title="加进我的指标"
        open={adopting !== null}
        confirmLoading={saving}
        okText="加进我的指标"
        okButtonProps={{ disabled: metricId.trim() === '' }}
        onOk={() => void adopt()}
        onCancel={() => setAdopting(null)}
        destroyOnHidden
      >
        <Space orientation="vertical" size={10} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>指标名称</Typography.Text>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              指标标识（系统已按命名规则填好，一般不用改）
            </Typography.Text>
            <Input value={metricId} onChange={(e) => setMetricId(e.target.value)} />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            加入后是「草稿」状态：在「指标」页再确认一次才会生效。标识不能与平台已有指标重名。
          </Typography.Text>
        </Space>
      </Modal>
    </Card>
  )
}
