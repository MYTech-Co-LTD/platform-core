// value-metrics.ts —— W6 Task 5：三个价值指标（纯函数）。
//
// 定义先于采集：三个数各自「怎么算」写死在这里，采集面只负责喂输入。**缺数一律 null**，
// 面板显示「未接入」——把没有的数据画成 0 是这套体系里最贵的谎（和 `incidentsTracked` 同一条纪律）。
//
//   · 可辩护答案时长：会话首问 → 首次带证据包查询成功的**中位**耗时（秒）；样本 < 20 视为不足
//   · 接受率：已裁决的已验问答 / 全部已验问答
//   · 口径事故数：近 90 天 metric_audit 计数（W5 的 healthOf 已算，这里只做展示口径）
export const MIN_SAMPLES_FOR_ANSWER_TIME = 20

export interface ValueMetrics {
  /** 中位耗时（秒）；null = 未接入或样本不足 */
  defensibleAnswerSeconds: number | null
  answerTimeSamples: number
  answerTimeState: 'ok' | 'insufficient' | 'not_connected'
  /** 0–100 的百分比；null = 没有已验问答 */
  acceptancePct: number | null
  decided: number
  verifiedTotal: number
  /** 近 90 天口径事故数；null = 未接入（不是 0） */
  incidents: number | null
}

export interface ValueMetricsInput {
  /** 每个会话的耗时（毫秒）；undefined = 该块未接入 */
  answerDurationsMs?: readonly number[] | null
  decided: number
  verifiedTotal: number
  incidents: number | null
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function valueMetricsOf(input: ValueMetricsInput): ValueMetrics {
  const durations = input.answerDurationsMs ?? null
  const samples = durations === null ? 0 : durations.filter((n) => Number.isFinite(n) && n >= 0).length
  let seconds: number | null = null
  let state: ValueMetrics['answerTimeState'] = 'not_connected'
  if (durations !== null) {
    if (samples < MIN_SAMPLES_FOR_ANSWER_TIME) {
      state = 'insufficient'
    } else {
      const valid = durations.filter((n) => Number.isFinite(n) && n >= 0)
      seconds = Math.round((median(valid) / 1000) * 10) / 10
      state = 'ok'
    }
  }
  const verifiedTotal = Number.isFinite(input.verifiedTotal) ? Math.max(0, Math.trunc(input.verifiedTotal)) : 0
  const decided = Number.isFinite(input.decided) ? Math.max(0, Math.trunc(input.decided)) : 0
  return {
    defensibleAnswerSeconds: seconds,
    answerTimeSamples: samples,
    answerTimeState: state,
    acceptancePct: verifiedTotal === 0 ? null : Math.round((Math.min(decided, verifiedTotal) / verifiedTotal) * 1000) / 10,
    decided: Math.min(decided, verifiedTotal),
    verifiedTotal,
    incidents: input.incidents === null || !Number.isFinite(input.incidents) ? null : input.incidents,
  }
}
