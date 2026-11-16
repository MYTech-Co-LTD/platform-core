// mobile/Approvals.tsx — 移动端「待我审批」列表（OA P1 移动入口 / issue #2363）。
//
// 位置：`/m/oa/approvals`，在 `/m` 移动壳下（**不是 console**）——console 在 390px 会被
// `MobileConfigNotice` 拦成「配置请在电脑端完成」，审批人用手机默认路径打不开。
// 数据与业务逻辑全部复用 `../console/api`（同一组代理端点），本文件只做移动端呈现：
// 卡片列表（标题 / 发起人 / 当前节点 / 时间），整张卡可点进详情。
// 空态两种：「无待办」 vs 「加载失败」——后者必须看得见（静默空列表会让人以为没有待办）。
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert } from 'antd'
import { listMyApprovals } from '../console/api'
import type { MyApproval } from '../console/api'
import { formatTime } from './format'

const BASE = '/m/oa/approvals'

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  boxSizing: 'border-box',
  padding: '16px 16px calc(24px + env(safe-area-inset-bottom, 0px))',
  background: '#FAFBFC',
  color: '#1B1C1E',
}

const cardStyle: React.CSSProperties = {
  display: 'block',
  boxSizing: 'border-box',
  width: '100%',
  marginBottom: 12,
  padding: '14px 16px',
  borderRadius: 12,
  border: '1px solid #EBEDF0',
  background: '#FFFFFF',
  color: 'inherit',
  textDecoration: 'none',
}

export default function MobileApprovals() {
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

  return (
    <div style={pageStyle}>
      <h3 style={{ margin: '4px 0 14px', fontSize: 20, fontWeight: 600 }}>待我审批</h3>

      {loading && <p style={{ color: '#9AA0A6', fontSize: 13 }}>加载中…</p>}

      {!loading && error !== null && (
        <Alert type="error" showIcon title="待审批列表加载失败" description={error} />
      )}

      {!loading && error === null && rows.length === 0 && (
        <p style={{ color: '#9AA0A6', textAlign: 'center', padding: '48px 16px', fontSize: 14 }}>
          暂无待审批
        </p>
      )}

      {!loading && error === null && rows.map((row) => {
        const body = (
          <>
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>
              {row.title}
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: '#6B7280', wordBreak: 'break-word' }}>
              发起人：{row.requester || '—'}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#9AA0A6' }}>
              {row.nodeTitle || '—'} · {formatTime(row.submittedAt)}
            </div>
          </>
        )
        // caseId 缺失 = 没有引擎 case 可打开（正常路径不会出现）；渲染成不可点的卡而不是空链接。
        return row.caseId === null ? (
          <div key={row.submissionId} style={cardStyle}>{body}</div>
        ) : (
          <Link key={row.submissionId} style={cardStyle} to={`${BASE}/${encodeURIComponent(row.caseId)}`}>
            {body}
          </Link>
        )
      })}
    </div>
  )
}
