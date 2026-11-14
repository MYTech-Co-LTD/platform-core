// QueryQuality.tsx — 「查询性能（近 7 天）」运维面板（R4 p95 基线）。
//
// 数据只来自 `GET /reports/query-stats`（服务端读 `query_audit` 聚合 + 阈值判定）；前端不改口径。
// 面板是**增补面**：回包不完整/失败只显示人话，不拖垮报表清单。
import { useEffect, useState } from 'react'
import { Alert, Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'

interface Stats {
  days: number
  total: number
  sampled: number
  p95Ms: number | null
  slow: number
  slowRate: number | null
  breaches: string[]
  slo: { p95Ms: number; slowRate: number }
  byMetric: Array<{ metricId: string; total: number; slow: number; p95Ms: number | null }>
}

const pct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(1)}%`)
const ms = (v: number | null): string => (v === null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`)

const BREACH_LABEL: Record<string, string> = {
  p95: '查询 p95 超过阈值',
  slow_rate: '慢查询占比超过阈值',
}

function isStats(v: unknown): v is Stats {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Partial<Stats>
  return typeof s.total === 'number'
    && Array.isArray(s.breaches)
    && typeof s.slo === 'object' && s.slo !== null
    && Array.isArray(s.byMetric)
}

export function QueryQuality() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiGet('/reports/query-stats?days=7')
      .then((b) => {
        if (!alive) return
        if (!isStats(b)) { setError('返回数据不完整'); return }
        setStats(b)
      })
      .catch((e) => { if (alive) setError(messageOf(e)) })
    return () => { alive = false }
  }, [])

  if (error !== null) {
    return <Alert type="warning" showIcon message={`查询性能统计暂不可用：${error}`} />
  }
  if (stats === null) return <Card size="small" loading title="查询性能（近 7 天）" />

  const healthy = stats.breaches.length === 0
  return (
    <Card
      size="small"
      data-testid="query-quality"
      title="查询性能（近 7 天）"
      extra={<Tag color={healthy ? 'green' : 'red'}>{healthy ? '健康' : '需关注'}</Tag>}
    >
      {stats.total === 0 ? (
        <Typography.Text type="secondary">近 7 天没有查询记录</Typography.Text>
      ) : (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={12} sm={8}>
              <Statistic title="查询次数" value={stats.total} />
            </Col>
            <Col xs={12} sm={8}>
              <Statistic
                title="p95 耗时" value={ms(stats.p95Ms)}
                valueStyle={stats.breaches.includes('p95') ? { color: '#cf1322' } : undefined}
              />
            </Col>
            <Col xs={12} sm={8}>
              <Statistic
                title="慢查询" value={stats.slow} suffix={stats.slowRate === null ? undefined : pct(stats.slowRate)}
                valueStyle={stats.breaches.includes('slow_rate') ? { color: '#cf1322' } : undefined}
              />
            </Col>
          </Row>
          <Space size={12} wrap style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              阈值：p95 ≤{ms(stats.slo.p95Ms)} · 慢查询占比 ≤{pct(stats.slo.slowRate)}
            </Typography.Text>
            {stats.sampled < stats.total && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                （{stats.total - stats.sampled} 条旧记录无耗时样本）
              </Typography.Text>
            )}
          </Space>
          {stats.byMetric.length > 0 && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
              最慢指标：
              {stats.byMetric.slice(0, 3)
                .map((m) => `${m.metricId}（${ms(m.p95Ms)}，${m.total} 次）`)
                .join('、')}
            </Typography.Paragraph>
          )}
          {!healthy && (
            <Alert
              style={{ marginTop: 8 }}
              type="warning" showIcon
              message={stats.breaches.map((b) => BREACH_LABEL[b] ?? b).join('；')}
            />
          )}
        </>
      )}
    </Card>
  )
}
