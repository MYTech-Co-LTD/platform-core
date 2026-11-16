// mobile/ApprovalDetail.tsx — 移动端审批详情与动作（`/m/oa/approvals/:caseId` / issue #2363）。
//
// 授权口径与 console 完全一致：**服务端按计划快照的当前节点判定**（本组件不做授权结论）。
// 请求直接打平台代理端点，浏览器永远拿不到引擎地址与 PAT（spec §16）。
// 内容：只读字段（提交钉住版本的契约 → RJSF readonly，缺失时降级 JSON）+ 审批历史 + 通过/驳回。
// 产品约束：驳回必须有意见——意见为空时「拒绝」禁用（服务端也强制）。
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Input } from 'antd'
import AntdForm from '@rjsf/antd'
import validator from '@rjsf/validator-ajv8'
import { currentNodeTitleOf, getApprovalDetail, submitDecision } from '../console/api'
import type { ApprovalDetailView } from '../console/api'
import { actionText, formatTime } from './format'

const BASE = '/m/oa/approvals'

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pending_approval: { text: '审批中', color: '#E08A00' },
  approved: { text: '已通过', color: '#0FA958' },
  rejected: { text: '已驳回', color: '#E5484D' },
  withdrawn: { text: '已撤回', color: '#9AA0A6' },
  submitted: { text: '已提交', color: '#9AA0A6' },
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  boxSizing: 'border-box',
  padding: '16px 16px calc(24px + env(safe-area-inset-bottom, 0px))',
  background: '#FAFBFC',
  color: '#1B1C1E',
}

const cardStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  marginBottom: 12,
  padding: '14px 16px',
  borderRadius: 12,
  border: '1px solid #EBEDF0',
  background: '#FFFFFF',
}

const labelStyle: React.CSSProperties = { fontSize: 12, color: '#9AA0A6', marginBottom: 2 }
const valueStyle: React.CSSProperties = { fontSize: 14, marginBottom: 10, wordBreak: 'break-word' }

export default function MobileApprovalDetail({ caseId }: { caseId: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<ApprovalDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 动作失败就地显示（不引 antd message 的全局 portal：移动端少一层异步渲染，
  // 也让失败原因留在动作卡里，而不是飘走后消失）。
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getApprovalDetail(caseId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [caseId])

  const contract = detail?.contract as { schema?: unknown; uiSchema?: Record<string, unknown> } | null
  const schema = contract?.schema as object | undefined
  const uiSchema = useMemo<Record<string, unknown>>(
    () => ({
      ...(contract?.uiSchema ?? {}),
      // 只读渲染：动作在本页底部，走审批端点（与 console 同一姿势）
      'ui:submitButtonOptions': { norender: true },
    }),
    [contract],
  )

  if (loading) {
    return <div style={pageStyle}><p style={{ color: '#9AA0A6', fontSize: 13 }}>加载中…</p></div>
  }
  if (error !== null) {
    return (
      <div style={pageStyle}>
        <Link to={BASE} style={{ fontSize: 13 }}>返回</Link>
        <Alert style={{ marginTop: 12 }} type="error" showIcon title="审批详情加载失败" description={error} />
      </div>
    )
  }
  if (detail === null) return null

  const sub = detail.submission
  const status = STATUS_LABEL[sub.status] ?? { text: sub.status, color: '#9AA0A6' }
  const pending = sub.status === 'pending_approval'
  const currentTitle = currentNodeTitleOf(detail, '')
  const decisions = detail.case?.nodeDecisions ?? []
  const planNodes = (sub.plan as { nodes?: Array<{ key?: unknown; title?: unknown }> } | null)?.nodes
  const nodeTitle = (key: string | undefined): string => {
    if (key === undefined) return '—'
    const hit = Array.isArray(planNodes) ? planNodes.find((n) => n?.key === key) : undefined
    return typeof hit?.title === 'string' ? hit.title : key
  }

  const decide = async (action: 'approve' | 'reject') => {
    setSubmitting(true)
    setActionError(null)
    try {
      await submitDecision(caseId, {
        action,
        ...(comment.trim().length > 0 ? { comment: comment.trim() } : {}),
      })
      navigate(BASE)
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Link to={BASE} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>返回</Link>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.35, wordBreak: 'break-word' }}>
          审批：{sub.assetId} - {sub.submittedBy}
        </h3>
      </div>

      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: status.color, flex: 'none' }} />
        <span style={{ fontSize: 14 }}>{status.text}</span>
      </div>

      {detail.engineError !== null && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="引擎状态暂不可用"
          description={`当前展示的是平台侧已知信息（${detail.engineError}）；审批动作可能暂不可用。`}
        />
      )}

      <div style={cardStyle}>
        <div style={labelStyle}>发起人</div>
        <div style={valueStyle}>{sub.submittedBy}</div>
        <div style={labelStyle}>提交时间</div>
        <div style={valueStyle}>{formatTime(sub.submittedAt)}</div>
        <div style={labelStyle}>当前节点</div>
        <div style={valueStyle}>{currentTitle ?? '—'}</div>
        <div style={labelStyle}>契约版本</div>
        <div style={{ ...valueStyle, marginBottom: 0 }}>v{sub.version}</div>
        {sub.decidedAt !== null && (
          <>
            <div style={{ ...labelStyle, marginTop: 10 }}>结论时间</div>
            <div style={valueStyle}>{formatTime(sub.decidedAt)}</div>
          </>
        )}
        {sub.decisionComment !== null && sub.decisionComment !== '' && (
          <>
            <div style={labelStyle}>结论意见</div>
            <div style={{ ...valueStyle, marginBottom: 0 }}>{sub.decisionComment}</div>
          </>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>申请内容</div>
        {schema !== undefined ? (
          // RJSF 在窄屏可能压出横向滚动——限制在卡片内滚，不撑破整页（390px 验收判据）
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <AntdForm
              schema={schema}
              uiSchema={uiSchema}
              formData={sub.payload as Record<string, unknown>}
              validator={validator}
              readonly
              onSubmit={() => undefined}
            />
          </div>
        ) : (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
            {JSON.stringify(sub.payload, null, 2)}
          </pre>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>审批历史</div>
        {decisions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: '#9AA0A6' }}>暂无审批记录</p>
        ) : (
          decisions.map((d, i) => (
            <div
              key={`${d.nodeKey ?? ''}-${d.approver ?? ''}-${i}`}
              style={{ paddingBottom: 10, marginBottom: 10, borderBottom: i === decisions.length - 1 ? 'none' : '1px solid #F2F3F5' }}
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {nodeTitle(d.nodeKey)} · {d.approver ?? '—'} · {actionText(d.action)}
              </div>
              {d.comment !== null && d.comment !== undefined && d.comment !== '' && (
                <div style={{ marginTop: 4, fontSize: 13, color: '#6B7280', wordBreak: 'break-word' }}>{d.comment}</div>
              )}
              {d.at !== undefined && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#9AA0A6' }}>{formatTime(d.at)}</div>
              )}
            </div>
          ))
        )}
      </div>

      {pending && (
        <div style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>审批动作</div>
          <Input.TextArea
            aria-label="审批意见"
            placeholder="审批意见（驳回必填）"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            style={{ marginBottom: 12 }}
          />
          {actionError !== null && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              title="审批动作未完成"
              description={actionError}
            />
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            {/* autoInsertSpace=false：antd 默认在「两字中文」按钮里插空格（拒 绝） */}
            <Button
              type="primary"
              autoInsertSpace={false}
              block
              loading={submitting}
              onClick={() => decide('approve')}
            >
              通过
            </Button>
            <Button
              danger
              autoInsertSpace={false}
              block
              disabled={comment.trim().length === 0}
              loading={submitting}
              onClick={() => decide('reject')}
            >
              拒绝
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
