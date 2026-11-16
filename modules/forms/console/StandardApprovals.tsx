// console/StandardApprovals.tsx — 标准审批镜像列表（OA P2 Task 7 / issue #2385）。
//
// **只读**：企微审批应用是执行方与事实源；本页只展示镜像（状态/发起人/时间/可得的表单摘要）。
// 写入面在宿主回调路由（经 forms 端口）与小时级对账脚本——页面没有一个写操作。
// 标准表单字段与附件都在企微：拿不到就显示「—」，不假装有（计划 §已知边界）。
//
// 列表纪律（console-ui-conventions §3 / DESIGN.md）：卡片包 small 表格、有搜索价值的列表给搜索框、
// 空态给下一步；空态与「搜索无结果」分两种文案（静默空列表会让人以为没同步）。
import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Empty, Input, Spin, Table, Tag, Typography } from 'antd'
import { listStandardApprovals } from './api'
import type { StandardApprovalRow } from './api'

const STATUS_LABEL: Record<StandardApprovalRow['status'], { text: string; color: string }> = {
  pending: { text: '审批中', color: 'gold' },
  approved: { text: '已通过', color: 'green' },
  rejected: { text: '已驳回', color: 'red' },
  canceled: { text: '已撤回', color: 'default' },
}

function fmt(t: string | null): string {
  return t === null ? '—' : new Date(t).toLocaleString()
}

export default function StandardApprovals() {
  const [rows, setRows] = useState<StandardApprovalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    let cancelled = false
    listStandardApprovals()
      .then((list) => { if (!cancelled) setRows(list) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (k.length === 0) return rows
    return rows.filter((r) => [r.title ?? '', r.requester ?? '', r.processCode, r.providerRef]
      .some((v) => v.toLowerCase().includes(k)))
  }, [rows, keyword])

  if (loading) return <Spin />
  if (error !== null) {
    return <Alert type="error" showIcon title="标准审批镜像加载失败" description={error} />
  }

  return (
    <div>
      <Typography.Title level={5}>标准审批</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        企微原生审批的只读镜像：提交、审批与驳回都在企业微信里完成，这里只同步状态、发起人与时间。
      </Typography.Paragraph>

      <Card
        size="small"
        title={`共 ${rows.length} 条`}
        extra={(
          <Input.Search
            allowClear
            placeholder="搜标题 / 发起人 / processCode"
            style={{ width: 280 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        )}
      >
        <Table<StandardApprovalRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={filtered}
          pagination={filtered.length > 50 ? { pageSize: 50 } : false}
          scroll={{ x: 900 }}
          locale={{
            emptyText: keyword.trim().length > 0
              ? <Empty description={`没有匹配「${keyword.trim()}」的标准审批`} />
              : (
                <Empty description={
                  '还没有标准审批镜像。先在企微「审批」里提交一笔，回调或小时级对账同步后会出现在这里'
                } />
              ),
          }}
          expandable={{
            expandedRowRender: (row) => (
              row.detail === null || row.detail === undefined
                ? <Typography.Text type="secondary">该单未同步到表单摘要（平台只镜像状态、发起人与时间）</Typography.Text>
                : <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(row.detail, null, 2)}</pre>
            ),
          }}
          columns={[
            { title: '标题', dataIndex: 'title', render: (t: string | null) => t ?? '—' },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (s: StandardApprovalRow['status']) => (
                <Tag color={STATUS_LABEL[s].color}>{STATUS_LABEL[s].text}</Tag>
              ),
            },
            { title: '发起人', dataIndex: 'requester', width: 140, render: (t: string | null) => t ?? '—' },
            { title: 'processCode', dataIndex: 'processCode', width: 180, ellipsis: true },
            { title: '审批单号', dataIndex: 'providerRef', width: 180, ellipsis: true },
            { title: '发起时间', dataIndex: 'startedAt', width: 170, render: fmt },
            { title: '完成时间', dataIndex: 'finishedAt', width: 170, render: fmt },
            { title: '同步时间', dataIndex: 'syncedAt', width: 170, render: fmt },
          ]}
        />
      </Card>
    </div>
  )
}
