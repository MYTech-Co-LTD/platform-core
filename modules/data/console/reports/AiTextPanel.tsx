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
import { Alert, Typography } from 'antd'
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
  focus: 'overview'
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

  return (
    <div data-testid="ai-text">
      <Typography.Text type="secondary">
        {phase === 'done' ? (fallback ? '数据摘要' : 'AI 分析') : label}
      </Typography.Text>
      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 8, marginBottom: 0 }}>
        {text}
        {phase !== 'done' && text !== '' ? '▍' : ''}
      </Typography.Paragraph>
      {phase === 'done' && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            数据截至 {dataAsOf ?? '新鲜度未知'}{cached ? ' · 已缓存' : ''}
          </Typography.Text>
        </div>
      )}
    </div>
  )
}
