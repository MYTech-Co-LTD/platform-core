// console/Approvals.tsx — 「待我审批」列表（OA P1 Task 12 / issue #2363）。
//
// 响应式：桌面 antd Table，窄屏卡片列表（结构切换，不是加 class）。移动独立 /m 壳后置；
// 这里用响应式 console 页承接（手机上可直接用）。
// 数据口径：`GET /approvals/mine` 按**计划快照**过滤（引擎真实当前节点由详情接口回答）——
// 列表页不做 N 次引擎调用；点进去以引擎状态为准（spec §14.2「点击待办 → 以引擎真实状态为准」）。
// 空态两种：「无待办」 vs 「加载失败」——后者必须看得见（静默空列表会让人以为没有待办）。
import { useEffect, useState } from 'react'
import { Alert, Button, Empty, List, Spin, Table, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { listMyApprovals } from './api'
import type { MyApproval } from './api'

const BASE = '/console/forms'
const MOBILE_QUERY = '(max-width: 767px)'

/** 窄屏判定（本地实现；不跨模块引别的 console 内部文件——B1 同款分层纪律）。 */
function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = () => setIsMobile(mq.matches)
    setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return isMobile
}

export default function Approvals() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<MyApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listMyApprovals()
      .then((list) => { if (!cancelled) setRows(list) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const open = (row: MyApproval) => {
    if (row.caseId !== null) navigate(`${BASE}/approvals/${encodeURIComponent(row.caseId)}`)
  }

  if (loading) return <Spin />
  if (error !== null) {
    return <Alert type="error" showIcon title="待审批列表加载失败" description={error} />
  }

  return (
    <div>
      <Typography.Title level={5}>待我审批</Typography.Title>
      {rows.length === 0 ? (
        <Empty description="暂无待审批" />
      ) : isMobile ? (
        <List
          dataSource={rows}
          rowKey={(r) => r.submissionId}
          renderItem={(row) => (
            <List.Item
              actions={[<Button key="open" type="link" onClick={() => open(row)}>查看</Button>]}
            >
              <List.Item.Meta
                title={row.title}
                description={`${row.requester} · ${row.nodeTitle || '—'} · ${new Date(row.submittedAt).toLocaleString()}`}
              />
            </List.Item>
          )}
        />
      ) : (
        <Table<MyApproval>
          rowKey="submissionId"
          size="small"
          dataSource={rows}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: '标题', dataIndex: 'title' },
            { title: '发起人', dataIndex: 'requester', width: 140 },
            {
              title: '当前节点',
              dataIndex: 'nodeTitle',
              width: 160,
              render: (t: string) => (t ? <Tag>{t}</Tag> : '—'),
            },
            {
              title: '提交时间',
              dataIndex: 'submittedAt',
              width: 200,
              render: (t: string) => new Date(t).toLocaleString(),
            },
            {
              title: '动作',
              key: 'action',
              width: 100,
              render: (_: unknown, row) => (
                <Button type="link" disabled={row.caseId === null} onClick={() => open(row)}>
                  查看
                </Button>
              ),
            },
          ]}
        />
      )}
    </div>
  )
}
