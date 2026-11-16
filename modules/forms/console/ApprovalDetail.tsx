// console/ApprovalDetail.tsx — 应用内审批详情与动作（OA P1 Task 12 / issue #2363）。
//
// 授权口径：**服务端按计划快照的当前节点判定**（本组件不做授权结论，也不缓存）；
// 请求直接打平台代理端点，浏览器永远拿不到引擎地址与 PAT（spec §16）。
// 渲染：提交钉住版本的事项契约 → RJSF **只读**模式（历史渲染与填报同一渲染器，
// 「按当时版本解释」）；契约缺失时降级为 JSON（可见地降级，不假装有字段）。
// 拒绝必须有意见（产品约束，服务端也强制）——意见为空时拒绝按钮禁用，通过不受限。
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Descriptions, Input, Space, Spin, Tag, Typography, message } from 'antd'
import AntdForm from '@rjsf/antd'
import validator from '@rjsf/validator-ajv8'
import { useNavigate } from 'react-router-dom'
import { currentNodeTitleOf, getApprovalDetail, submitDecision } from './api'
import type { ApprovalDetailView } from './api'

const BASE = '/console/forms'

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  pending_approval: { text: '审批中', color: 'processing' },
  approved: { text: '已通过', color: 'success' },
  rejected: { text: '已驳回', color: 'error' },
  withdrawn: { text: '已撤回', color: 'default' },
  submitted: { text: '已提交', color: 'default' },
}

export default function ApprovalDetail({ caseId }: { caseId: string }) {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<ApprovalDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
      // 只读渲染：不给提交按钮（动作在本页底部，走审批端点）
      'ui:submitButtonOptions': { norender: true },
    }),
    [contract],
  )

  if (loading) return <Spin />
  if (error !== null) {
    return <Alert type="error" showIcon title="审批详情加载失败" description={error} />
  }
  if (detail === null) return null

  const sub = detail.submission
  const status = STATUS_LABEL[sub.status] ?? { text: sub.status, color: 'default' }
  const pending = sub.status === 'pending_approval'
  const currentTitle = currentNodeTitleOf(detail, '')

  const decide = async (action: 'approve' | 'reject') => {
    setSubmitting(true)
    try {
      await submitDecision(caseId, {
        action,
        ...(comment.trim().length > 0 ? { comment: comment.trim() } : {}),
      })
      message.success(action === 'approve' ? '已通过' : '已驳回')
      navigate(`${BASE}/approvals`)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button onClick={() => navigate(`${BASE}/approvals`)}>返回</Button>
        <Typography.Title level={5} style={{ margin: 0 }}>
          审批：{sub.assetId} - {sub.submittedBy}
        </Typography.Title>
        <Tag color={status.color}>{status.text}</Tag>
      </Space>

      {detail.engineError !== null && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="引擎状态暂不可用"
          description={`当前展示的是平台侧已知信息（${detail.engineError}）；审批动作可能暂不可用。`}
        />
      )}

      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="发起人">{sub.submittedBy}</Descriptions.Item>
        <Descriptions.Item label="提交时间">{new Date(sub.submittedAt).toLocaleString()}</Descriptions.Item>
        <Descriptions.Item label="当前节点">{currentTitle ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="契约版本">v{sub.version}</Descriptions.Item>
        {sub.decidedAt !== null && (
          <Descriptions.Item label="结论时间">{new Date(sub.decidedAt).toLocaleString()}</Descriptions.Item>
        )}
        {sub.decisionComment !== null && sub.decisionComment !== '' && (
          <Descriptions.Item label="结论意见">{sub.decisionComment}</Descriptions.Item>
        )}
      </Descriptions>

      <Card size="small" title="申请内容" style={{ marginBottom: 12 }}>
        {schema !== undefined ? (
          <AntdForm
            schema={schema}
            uiSchema={uiSchema}
            formData={sub.payload as Record<string, unknown>}
            validator={validator}
            readonly
            onSubmit={() => undefined}
          />
        ) : (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(sub.payload, null, 2)}</pre>
        )}
      </Card>

      {pending && (
        <Card size="small" title="审批动作">
          <Input.TextArea
            aria-label="审批意见"
            placeholder="审批意见（驳回必填）"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            style={{ marginBottom: 12 }}
          />
          <Space>
            {/* autoInsertSpace=false：antd 默认在「两字中文」按钮里插空格（拒 绝），
                会让无障碍名与产品文案不一致（也影响按名定位的测试/E2E）。 */}
            <Button type="primary" autoInsertSpace={false} loading={submitting} onClick={() => decide('approve')}>
              通过
            </Button>
            <Button
              danger
              autoInsertSpace={false}
              disabled={comment.trim().length === 0}
              loading={submitting}
              onClick={() => decide('reject')}
            >
              拒绝
            </Button>
          </Space>
        </Card>
      )}
    </div>
  )
}
