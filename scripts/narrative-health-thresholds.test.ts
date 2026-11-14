// narrative-health-thresholds.test.ts — 叙事质量阈值的**单一事实源**护栏（R5）。
//
// 数据面探针跑在无 node 的宿主上（Python），阈值只能抄一份；这里在 CI 机械比对：
// Python 常量与 `modules/data/domain/narrative-runs.ts` 的 `NARRATIVE_SLO` 必须逐值一致，
// 漂移即红——避免「面板显示 20%，告警按 30% 判」这种静默分叉。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NARRATIVE_SLO } from '../modules/data/domain/narrative-runs'

const PY = readFileSync(new URL('./narrative-health-probe.py', import.meta.url), 'utf8')

const pyNumber = (name: string): number | null => {
  const m = new RegExp(`^${name}\\s*=\\s*([0-9][0-9_.]*)`, 'm').exec(PY)
  return m === null ? null : Number(m[1]!.replaceAll('_', ''))
}

describe('叙事质量阈值：Python 探针 == TS 正典', () => {
  it('fallback 率 / p95 / 越界率逐值一致', () => {
    expect(pyNumber('SLO_FALLBACK_RATE')).toBe(NARRATIVE_SLO.fallbackRate)
    expect(pyNumber('SLO_P95_MS')).toBe(NARRATIVE_SLO.p95Ms)
    expect(pyNumber('SLO_NUMBER_CHECK_RATE')).toBe(NARRATIVE_SLO.numberCheckRate)
  })
})
