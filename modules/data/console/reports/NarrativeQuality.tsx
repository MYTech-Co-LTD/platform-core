// NarrativeQuality.tsx — 「AI 叙事质量」运维面板（R5 信任闭环的可见面）。
//
// 数据只来自 `GET /reports/narrative-stats`（服务端聚合 + 阈值判定）；前端**不改口径**：
// 回退率 = fallback/(ok+fallback)，越界率只对生成样本计，p95 是墙钟时长——与告警 job 同源。
//
// 阈值（`slo`）由服务端随响应下发：前端只负责把「越线」画出来，不再各写一套数字。
import { useEffect, useState } from 'react'
import { Alert, Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd'
import { apiGet, messageOf } from '../lib/api'

interface Stats {
  days: number
  total: number
  byOutcome: { ok: number; fallback: number; cached: number; error: number }
  fallbackRate: number | null
  numberCheckCount: number
  numberCheckRate: number | null
  cacheHitRate: number | null
  p95Ms: number | null
  /** facts 构建 p95（R4 分项基线）；旧版本回包可能没有。 */
  factsP95Ms?: number | null
  breaches: string[]
  slo: { fallbackRate: number; p95Ms: number; numberCheckRate: number }
}

const pct = (v: number | null): string => (v === null ? '-' : `${(v * 100).toFixed(1)}%`)
const ms = (v: number | null): string => (v === null ? '-' : `${(v / 1000).toFixed(1)}s`)

/**
 * 回包形状闸：服务异常/旧版本回包缺字段时**不崩整页**（面板是增补面，不能拖垮报表清单）。
 * 认不出形状 ⇒ 走「暂不可用」分支，而不是把 undefined 当 0 画出来。
 */
function isStats(v: unknown): v is Stats {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Partial<Stats>
  return typeof s.total === 'number'
    && typeof s.byOutcome === 'object' && s.byOutcome !== null
    && typeof s.byOutcome.ok === 'number'
    && typeof s.byOutcome.fallback === 'number'
    && typeof s.byOutcome.cached === 'number'
    && typeof s.byOutcome.error === 'number'
    && Array.isArray(s.breaches)
    && typeof s.slo === 'object' && s.slo !== null
}

const BREACH_LABEL: Record<string, string> = {
  fallback_rate: '回退率超过阈值',
  p95: '生成时长 p95 超过阈值',
  number_check: '数字校验越界率超过阈值',
}

export function NarrativeQuality() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiGet('/reports/narrative-stats?days=7')
      .then((b) => {
        if (!alive) return
        if (!isStats(b)) { setError('返回数据不完整'); return }
        setStats(b)
      })
      .catch((e) => { if (alive) setError(messageOf(e)) })
    return () => { alive = false }
  }, [])

  if (error !== null) {
    return <Alert type="warning" showIcon message={`AI 叙事质量统计暂不可用：${error}`} />
  }
  if (stats === null) return <Card size="small" loading title="AI 叙事质量（近 7 天）" />

  const generated = stats.byOutcome.ok + stats.byOutcome.fallback
  const healthy = stats.breaches.length === 0

  return (
    <Card
      size="small"
      data-testid="narrative-quality"
      title="AI 叙事质量（近 7 天）"
      extra={<Tag color={healthy ? 'green' : 'red'}>{healthy ? '健康' : '需关注'}</Tag>}
    >
      {stats.total === 0 ? (
        <Typography.Text type="secondary">近 7 天没有叙事生成记录</Typography.Text>
      ) : (
        <>
          <Row gutter={[12, 12]}>
            <Col xs={12} sm={6}>
              <Statistic title="生成次数" value={generated} />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="回退率" value={pct(stats.fallbackRate)}
                valueStyle={stats.breaches.includes('fallback_rate') ? { color: '#cf1322' } : undefined}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="数字越界" value={stats.numberCheckCount}
                suffix={stats.numberCheckRate === null ? undefined : pct(stats.numberCheckRate)}
                valueStyle={stats.breaches.includes('number_check') ? { color: '#cf1322' } : undefined}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="生成 p95" value={ms(stats.p95Ms)}
                valueStyle={stats.breaches.includes('p95') ? { color: '#cf1322' } : undefined}
              />
            </Col>
          </Row>
          <Space size={12} wrap style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              缓存命中 {pct(stats.cacheHitRate)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="facts-p95">
              facts 构建 p95 {ms(stats.factsP95Ms ?? null)}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              总尝试 {stats.total}（含缓存/失败）
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              阈值：回退 ≤{pct(stats.slo.fallbackRate)} · p95 ≤{ms(stats.slo.p95Ms)} · 越界 ≤{pct(stats.slo.numberCheckRate)}
            </Typography.Text>
          </Space>
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
