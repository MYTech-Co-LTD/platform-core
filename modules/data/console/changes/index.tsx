// console/changes/index.tsx — 「待核对」（Wave 5 P0）：agent 的提案单，人只做采纳/驳回。
//
// 单页双层（与 candidates 同款纪律）：默认层人话——改什么 / 数是多少 / 与参照差多少；
// 原始声明与快照收进 `<TechDetails>`。判定全部委托服务端（Task 5 的三个端点），
// 本页不复制校验；错误走 `humanError()`：主句是人话，原码收在技术细节里。
// 决策端点**只认会话**（PAT 打 adopt/reject 一律 403 DECISION_REQUIRES_SESSION，
// 结构性禁止 agent 自审）——所以这页必须是人在浏览器里点，没有其他入口。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Modal, Space, Tag, Typography, message } from 'antd'
import { apiGet, apiSend } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'
import { TechDetails } from '../components/TechDetails'

type Row = {
  id: number; metricId: string; kind: 'create' | 'update' | 'meta' | 'delete'
  status: string; payload: Record<string, unknown>
  preview: { window?: { from: string; to: string }; value?: number | null; rows?: number
    baseline?: { id: string; value: number | null; deltaPct: number | null } | null
    error?: string } | null
  submittedBy: string; submittedAt: string
}
const KIND_LABEL: Record<Row['kind'], string> = { create: '新建指标', update: '修改口径', meta: '改标注', delete: '删除指标' }

export default function ChangesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<HumanError | null>(null)
  const [rejecting, setRejecting] = useState<Row | null>(null)
  const [reason, setReason] = useState('')
  /** 补跑试算的在飞标记（行 id）：按钮 loading 即禁点，防同一单并发重跑。 */
  const [previewing, setPreviewing] = useState<number | null>(null)
  const [messageApi, ctx] = message.useMessage()

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const body = await apiGet('/metric-changes?status=pending') as { changes?: Row[] }
      setRows(Array.isArray(body.changes) ? body.changes : [])
    } catch (e) {
      setErr(humanError(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const adopt = async (r: Row) => {
    setErr(null)
    try {
      await apiSend(`/metric-changes/${r.id}/adopt`, 'POST')
      messageApi.success('已采纳并生效')
      await load()
    } catch (e) {
      setErr(humanError(e))
    }
  }
  const reject = async () => {
    if (rejecting === null || reason.trim() === '') return
    setErr(null)
    try {
      await apiSend(`/metric-changes/${rejecting.id}/reject`, 'POST', { reason: reason.trim() })
      messageApi.success('已驳回，agent 会看到原因')
      setRejecting(null)
      setReason('')
      await load()
    } catch (e) {
      setErr(humanError(e))
    }
  }
  // 补跑试算（draft / preview_failed 行）：走既有重跑端点；失败走 humanError（PREVIEW_UNAVAILABLE
  // 等码已在 lib/explain 的表里），成功靠 load() 拉最新状态。
  const runPreview = async (r: Row) => {
    setErr(null)
    setPreviewing(r.id)
    try {
      await apiSend(`/metric-changes/${r.id}/preview`, 'POST')
      await load()
    } catch (e) {
      setErr(humanError(e))
    } finally {
      setPreviewing(null)
    }
  }

  return (
    <Card title="待核对" extra={<Button size="small" loading={loading} onClick={() => void load()}>刷新</Button>}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        这些是 agent 提交的指标变更。<strong>没看到数就不该采纳</strong>——先看试算值与参照值的差异，
        对得上点「采纳」，对不上点「驳回」并写清哪里不对。
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
      {rows.length === 0
        ? <Empty description="没有待核对的变更。agent 提交后会出现在这里。" />
        : rows.map((r) => (
          <Card key={r.id} size="small" style={{ marginBottom: 10 }}>
            <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
              <div style={{ minWidth: 280, flex: 1 }}>
                <Space size={6} wrap>
                  <Typography.Text strong style={{ fontSize: 15 }}>{r.metricId}</Typography.Text>
                  <Tag>{KIND_LABEL[r.kind]}</Tag>
                  {r.status === 'preview_failed' && <Tag color="warning">试算失败</Tag>}
                  <Typography.Text type="secondary">{r.submittedBy} · {r.submittedAt.slice(0, 16).replace('T', ' ')}</Typography.Text>
                </Space>
                <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 13 }}>
                  {r.status === 'draft'
                    ? '试算还没跑完'
                    : r.preview?.error !== undefined
                      ? `试算没跑成：${r.preview.error}（不可采纳）`
                      : r.preview?.baseline != null && r.preview.baseline.deltaPct !== null
                        ? `试算 ${r.preview.value?.toLocaleString?.() ?? r.preview.value}（${r.preview.rows ?? 0} 行），`
                          + `参照 ${r.preview.baseline.id} ${r.preview.baseline.value?.toLocaleString?.() ?? r.preview.baseline.value}，`
                          + `差 ${r.preview.baseline.deltaPct > 0 ? '+' : ''}${r.preview.baseline.deltaPct}%`
                        : `试算 ${r.preview?.value?.toLocaleString?.() ?? r.preview?.value ?? '—'}（${r.preview?.rows ?? 0} 行）`}
                </Typography.Paragraph>
                <TechDetails>
                  <div>窗口：{r.preview?.window ? `${r.preview.window.from} ~ ${r.preview.window.to}` : '—'}</div>
                  <div>原始声明：{JSON.stringify(r.payload)}</div>
                  <div>快照：{JSON.stringify(r.preview)}</div>
                </TechDetails>
              </div>
              <Space>
                {/* 补跑试算：只有还没跑成（draft / preview_failed）的行需要；preview_ready 行数已在场 */}
                {(r.status === 'draft' || r.status === 'preview_failed') && (
                  <Button size="small" loading={previewing === r.id} onClick={() => void runPreview(r)}>跑试算</Button>
                )}
                <Button type="primary" disabled={r.status !== 'preview_ready'} onClick={() => void adopt(r)}>采纳</Button>
                {/* 驳回对全部未决态开放（domain rejectChange 收 draft/preview_ready/preview_failed）——
                    「没试算完就看出不对」是合法驳回路径，不该逼人先跑完试算才能拒 */}
                <Button onClick={() => setRejecting(r)}>驳回</Button>
              </Space>
            </Space>
          </Card>
        ))}
      <Modal title="驳回这条变更" open={rejecting !== null} okText="驳回" okButtonProps={{ danger: true, disabled: reason.trim() === '' }}
             onOk={() => void reject()} onCancel={() => setRejecting(null)} destroyOnHidden>
        <Input.TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                        placeholder="哪里不对？（agent 会按这个改，必填）" />
      </Modal>
      {ctx}
    </Card>
  )
}
