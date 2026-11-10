// AiTextPanel.tsx — `ai_text` 面板：观看时按当前期间/门店**服务端流式生成**分析文本。
//
// 计划 2026-10-26 Task 9（设计 §4/§10）。与静态 `text` 的分工：
//  · `text` 的正文在 spec 里（`content`），本组件**不读** spec 文案；
//  · `ai_text` 的正文在**观看时**由 `POST /reports/:id/narrative/stream` 现算——数字只来自
//    报表事实包（服务端 `buildFacts` → `runQuery`），前端不拼、不改、不补数字。
//
// SSE 契约（`domain/narrative.ts` 的 `NarrativeEvent`）：
//  · `phase`  facts/thinking/writing + 人话 label —— 首正文约 3.2s，**不能空白等**；
//  · `delta`  增量正文（追加）；
//  · `replace` 已流出的内容作废（数字校验越界 / 模型失败）——**整段替换**，不是追加；
//  · `done`   终稿 + fallback/dataAsOf/cached（回退模板与缓存命中都要如实上屏）；
//  · `error`  流已开（200 已发）后只剩事件能收敛状态。
//
// 两个前端侧的工程决定：
//  ① **500ms 防抖**：期间档位 / RangePicker / 门店下拉都可能连点，切换一次就是一次真实生成
//     （带模型成本）；防抖把连点收敛成最后一次，且**每次新请求先中断旧流**——否则旧流的
//     delta 会继续追进新请求的正文（串字）。
//  ② **模块级 `streamPost`**（`../lib/api`）：前缀与失败体翻译与其余端点同一套；失败时抛
//     `ApiError`，这里只上屏一句人话（状态码细节不暴露给观看面）。
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, Space, Spin, Tag, Typography } from 'antd'
import { streamPost } from '../lib/api'
import type { PeriodSpec } from '../../domain/report-spec'

type Phase = 'facts' | 'thinking' | 'writing' | 'done'

/** SSE 事件（形状照 `domain/narrative.ts` 的 `NarrativeEvent`；`done` 的 label 等字段用不上就不声明）。 */
type Ev =
  | { type: 'phase'; phase: Phase; label: string }
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string; reason: string }
  | { type: 'done'; text: string; fallback: boolean; dataAsOf: string | null; generatedAt: string; cached: boolean }
  | { type: 'error'; reason: string }

type Props = {
  reportId: string
  /** 面板在 spec 里的下标（服务端按它定位 `ai_text` 面板与事实包主体）。 */
  panelIndex: number
  focus: 'overview' | 'root_cause' | 'daily_review'
  /** 当前生效期间；`null` = 规格未声明期间（写侧 `AI_TEXT_REQUIRES_PERIOD` 已拦，这里只是兜底）。 */
  period: PeriodSpec | null
  /** 当前门店（筛选栏覆盖优先，其次规格默认）；缺席 = 不按门店切片。 */
  branchNum?: string
  /** 钉住的历史版本（独立页 `?v=N`）；缺席 = 最新发布快照。 */
  version?: number
}

/** 把 SSE 原始块拆成事件（`data: <json>` 行；注释/心跳行忽略）。 */
function parseChunk(chunk: string): Ev | null {
  const line = chunk.split('\n').find((l) => l.startsWith('data: '))
  if (line === undefined) return null
  return JSON.parse(line.slice(6)) as Ev
}

/**
 * 可读分段：优先按空行（模型自然段）。确定性模板只有单换行，且每段以
 * 「结论/对比/成本…」打头——按标签断段，否则整段会挤成一坨。
 */
const SECTION_START = /^(结论|对比|天气|成本|MTD|驱动|根因|建议|行动|异常|现象)[：:]/
function sectionsOf(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  const flush = (): void => {
    if (cur.length > 0) {
      out.push(cur.join('\n'))
      cur = []
    }
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush()
      continue
    }
    if (SECTION_START.test(line.trim()) && cur.length > 0) flush()
    cur.push(line)
  }
  flush()
  return out
}

/** 极简富文本：模型只被允许用 `**粗体**`，不为此引入整个 Markdown 渲染器。 */
function renderInline(s: string): ReactNode {
  const parts = s.split('**')
  if (parts.length === 1) return s
  return parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))
}

/** 期间标签：11-08 这类裸日期要带上「单日/本月」语义，避免读者猜。 */
function periodLabelOf(period: PeriodSpec | null): string {
  if (period === null) return '未声明期间'
  if (period.mode === 'day') return period.day === undefined ? '单日' : `单日 · ${period.day}`
  if (period.mode === 'month') return period.month === undefined ? '本月' : `本月 · ${period.month}`
  if (period.mode === 'last_7_days') return '近 7 天'
  return `${period.from ?? ''} ~ ${period.to ?? ''}`
}

export default function AiTextPanel({ reportId, panelIndex, focus, period, branchNum, version }: Props) {
  const [phase, setPhase] = useState<Phase>('facts')
  const [label, setLabel] = useState('正在核对指标…')
  const [text, setText] = useState('')
  const [fallback, setFallback] = useState(false)
  const [dataAsOf, setDataAsOf] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `period` 是对象：用序列化值做依赖，父级重渲染（兄弟面板结果到达）不会把生成重跑一遍。
  const periodKey = JSON.stringify(period)

  useEffect(() => {
    if (period === null) {
      setError('报表未声明期间')
      return
    }
    const ac = new AbortController()
    // 防抖窗口内再切期间/门店 ⇒ 清掉上一发，只有最后一次真的发请求。
    const timer = setTimeout(async () => {
      setPhase('facts')
      setLabel('正在核对指标…')
      setText('')
      setFallback(false)
      setDataAsOf(null)
      setCached(false)
      setError(null)
      try {
        const res = await streamPost(
          `/reports/${reportId}/narrative/stream`,
          {
            panelIndex,
            period,
            ...(branchNum !== undefined ? { branchNum } : {}),
            ...(version !== undefined ? { version } : {}),
          },
          ac.signal,
        )
        if (res.body === null) throw new Error('no stream body')
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        // 逐块读：`stream: true` 处理跨块的 UTF-8 半字符；`buf` 留住未收尾的半截事件。
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const chunks = buf.split('\n\n')
          buf = chunks.pop() ?? ''
          for (const chunk of chunks) {
            const ev = parseChunk(chunk)
            if (ev === null) continue
            if (ev.type === 'phase') {
              setPhase(ev.phase)
              setLabel(ev.label)
            } else if (ev.type === 'delta') {
              setText((t) => t + ev.text)
            } else if (ev.type === 'replace') {
              // 数字校验越界/模型失败：**整段替换**（旧 delta 已作废，不能再追加）。
              setText(ev.text)
              setFallback(true)
            } else if (ev.type === 'done') {
              setText(ev.text)
              setFallback(ev.fallback)
              setDataAsOf(ev.dataAsOf)
              setCached(ev.cached)
              setPhase('done')
            } else if (ev.type === 'error') {
              setError('AI 分析暂不可用')
            }
          }
        }
      } catch {
        // 主动 abort（切期间/卸载）不是错误；其余一律人话，不把上游细节上屏。
        if (!ac.signal.aborted) setError('AI 分析暂不可用')
      }
    }, 500)
    return () => {
      clearTimeout(timer)
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- period 的对象身份不稳定，按序列化值判等
  }, [reportId, panelIndex, focus, periodKey, branchNum, version])

  if (error !== null) return <Alert type="warning" showIcon message={error} />

  const periodLabel = periodLabelOf(period)
  const blocks = sectionsOf(text)

  return (
    <div data-testid="ai-text">
      <Space size={8} wrap>
        <Spin size="small" spinning={phase !== 'done'} />
        <Typography.Text type="secondary">
          {phase === 'done' ? (fallback ? '数据摘要' : 'AI 分析') : label}
        </Typography.Text>
        <Tag color="blue">{periodLabel}</Tag>
      </Space>
      <div style={{ marginTop: 10 }}>
        {blocks.length === 0 && phase !== 'done' ? (
          <Typography.Text type="secondary">模型正在分析，通常需要 20–40 秒…</Typography.Text>
        ) : (
          blocks.map((block, i) => (
            <Typography.Paragraph
              key={i}
              style={{
                lineHeight: 1.8, marginBottom: 12,
                ...(i === 0 ? { background: '#fafafa', padding: '8px 12px', borderLeft: '3px solid #1677ff' } : {}),
              }}
            >
              {block.split('\n').map((line, li) => {
                const t = line.trim()
                if (t.startsWith('- ')) {
                  return <div key={li} style={{ paddingLeft: 10, marginTop: 4 }}>• {renderInline(t.slice(2))}</div>
                }
                // 每行独立成 div + 行距：模板回退只有单换行，靠 <br> 会挤成一坨。
                return <div key={li} style={{ marginTop: li === 0 ? 0 : 6 }}>{renderInline(t)}</div>
              })}
              {phase !== 'done' && i === blocks.length - 1 ? '▍' : ''}
            </Typography.Paragraph>
          ))
        )}
      </div>
      {phase === 'done' && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数据截止 {dataAsOf ?? '未知'}{cached ? ' · 已缓存' : ''}
          </Typography.Text>
        </div>
      )}
    </div>
  )
}
