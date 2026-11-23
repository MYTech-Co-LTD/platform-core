// goal-daily-push.test.mjs — 目标达成日报（件② #2708 / C3）的纯函数面单测。
// 只测「算数与形状」：DB/入队是 job 的运行期行为（真库验收在 C4 staging 清单里）。
import { describe, expect, it } from 'vitest'
import { LAGGERS_LIMIT, buildPayload, cstToday, eventIdFor, laggersText, summarize } from './goal-daily-push.mjs'

describe('cstToday（北京时钟，不手算 +8h）', () => {
  it('UTC 跨日时按上海取日与月', () => {
    // 2026-11-30T16:30Z = 上海 2026-12-01 00:30
    expect(cstToday(new Date('2026-11-30T16:30:00Z'))).toEqual({ today: '2026-12-01', month: '2026-12' })
    // 2026-11-23T00:10Z = 上海 08:10 同日
    expect(cstToday(new Date('2026-11-23T00:10:00Z'))).toEqual({ today: '2026-11-23', month: '2026-11' })
  })
})

describe('summarize（Σactual/Σtarget 与落后榜）', () => {
  it('达成率 = 合计口径（不是各店率的平均）；落后榜按率升序、只收 target>0、截断 5 条', () => {
    const rows = [
      { branch_num: '1', target: 100, actual: 50 },  // 50%
      { branch_num: '2', target: 100, actual: 100 }, // 100%
      { branch_num: '3', target: 0, actual: 30 },    // 新店无目标 ⇒ 不进落后榜、但 actual 计入
      { branch_num: '4', target: 200, actual: 40 },  // 20%
      { branch_num: '5', target: 100, actual: 90 },  // 90%
      { branch_num: '6', target: 100, actual: 10 },  // 10%
      { branch_num: '7', target: 100, actual: 20 },  // 20%
    ]
    const s = summarize(rows)
    expect(s.target).toBe(700)
    expect(s.actual).toBe(340)
    expect(s.rate).toBeCloseTo(340 / 700, 4)
    expect(s.laggers.map((l) => l.branchNum)).toEqual(['6', '4', '7', '1', '5'])
    expect(s.laggers).toHaveLength(LAGGERS_LIMIT)
    expect(s.laggers[0].rate).toBe(0.1)
  })

  it('target 合计为 0 ⇒ 达成率 NULL（不是 0 也不是 Infinity）', () => {
    const s = summarize([{ branch_num: '1', target: 0, actual: 5 }])
    expect(s.rate).toBeNull()
    expect(s.laggers).toEqual([])
  })

  it('null/非数行被跳过；空集 ⇒ NULL 达成率', () => {
    const s = summarize([{ branch_num: '1', target: null, actual: 'x' }])
    expect(s.target).toBe(0)
    expect(s.rate).toBeNull()
  })
})

describe('laggersText / buildPayload / eventIdFor（事件形状 ⊆ manifest 声明）', () => {
  it('落后榜文本：空集给人话，非空逐店百分比', () => {
    expect(laggersText([])).toBe('无（所有门店都有目标）')
    expect(laggersText([{ branchNum: '6', rate: 0.1 }, { branchNum: '4', rate: 0.2 }])).toBe('门店6 10.0%；门店4 20.0%')
  })

  it('payload 只含 manifest 声明的 7 个键，比率格式化成百分数字符串', () => {
    const p = buildPayload({
      goal: 'shanhai:monthly_store_sale', metric: 'sale', period: '2026-11',
      rate: 0.8532, progress: 0.75, laggers: '门店6 10.0%', link: 'https://x/app/data',
    })
    expect(Object.keys(p).sort()).toEqual(
      ['achievementRate', 'goal', 'link', 'metric', 'period', 'progressRate', 'topLaggards'],
    )
    expect(p).toMatchObject({ achievementRate: '85.3%', progressRate: '75.0%' })
  })

  it('NULL 率 → N/A（模板不解析数字，字符串恒定非空）', () => {
    const p = buildPayload({ goal: 'g', metric: 'm', period: '2026-11', rate: null, progress: null, laggers: '无', link: '' })
    expect(p.achievementRate).toBe('N/A')
    expect(p.progressRate).toBe('N/A')
  })

  it('事件 id 确定性：同 goal×metric×日 恒等（notify.event 主键幂等）', () => {
    expect(eventIdFor('shanhai:monthly_store_sale', 'sale', '2026-11-23'))
      .toBe(eventIdFor('shanhai:monthly_store_sale', 'sale', '2026-11-23'))
    expect(eventIdFor('g', 'sale', '2026-11-23')).not.toBe(eventIdFor('g', 'sale', '2026-11-24'))
  })
})
