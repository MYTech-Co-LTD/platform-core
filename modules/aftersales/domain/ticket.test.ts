import { describe, expect, it } from 'vitest'
import {
  AmountValidationError,
  MAX_FIXED_AMOUNT_MINOR,
  assertValidFixedAmount,
  assertValidRatio,
  computeAmountMinor,
  isProcessable,
  resolveProcess,
  toMinor,
  toRatioOrNull,
} from './ticket'
import type { TicketStatus } from './ticket'

describe('computeAmountMinor —— spec §2.4 金额公式', () => {
  const base = { basicQuantity: 100, basicUnitPriceMinor: 500, refundRatio: 0.1 }

  it('刚好等于免赔门槛 ⇒ 0', () => {
    expect(computeAmountMinor({ ...base, damageQuantity: 10 })).toBe(0)
  })

  it('低于门槛（门槛内）⇒ 0，不出现负数', () => {
    expect(computeAmountMinor({ ...base, damageQuantity: 3 })).toBe(0)
    expect(computeAmountMinor({ ...base, damageQuantity: 0 })).toBe(0)
  })

  it('超出门槛的部分才赔：(30 − 100×0.1) × 500 分 = 10000 分', () => {
    expect(computeAmountMinor({ ...base, damageQuantity: 30 })).toBe(10_000)
  })

  it('比例为 0 ⇒ 全额赔：3 × 250 = 750 分', () => {
    expect(
      computeAmountMinor({ damageQuantity: 3, basicQuantity: 100, basicUnitPriceMinor: 250, refundRatio: 0 }),
    ).toBe(750)
  })

  it('小数门槛算出的分位按四舍五入进位：(1 − 1×0.5) × 1 分 = 0.5 分 ⇒ 1 分', () => {
    expect(
      computeAmountMinor({ damageQuantity: 1, basicQuantity: 1, basicUnitPriceMinor: 1, refundRatio: 0.5 }),
    ).toBe(1)
  })

  it('比例是【小数】不是百分数：0.1 的门槛是 10 件，不是 0.1 件', () => {
    // 若被误当百分数（ratio=10）门槛会变成 1000 件、结果恒 0。用正值钉住正确解释。
    // (100 − 100×0.1) × 500 = 45_000。计划原写 9_000 与 Global Constraints #9 公式冲突，经协调者裁决订正。
    expect(computeAmountMinor({ ...base, damageQuantity: 100 })).toBe(45_000)
  })
})

describe('resolveProcess —— 三态状态机 + 金额类型（spec §2.4）', () => {
  const ticket = { damageQuantity: 30, basicQuantity: 100, basicUnitPriceMinor: 500 }

  it('ratio 路 ⇒ completed、按公式算钱、落比例', () => {
    expect(resolveProcess(ticket, { amountType: 'ratio', refundRatio: 0.1 })).toEqual({
      status: 'completed',
      amountType: 'ratio',
      amountMinor: 10_000,
      refundRatio: 0.1,
    })
  })

  it('fixed 路 ⇒ completed、【采信操作员输入】而不是重算', () => {
    // 这条钉的是 §0.3「前端金额不采信」的【明写例外】：固定额是业务输入而非计算值。
    // 如果哪天有人"顺手"让 fixed 也走公式，这条必须红。
    expect(resolveProcess(ticket, { amountType: 'fixed', amountMinor: 12_345 })).toEqual({
      status: 'completed',
      amountType: 'fixed',
      amountMinor: 12_345,
      refundRatio: null,
    })
  })

  it('reject 路 ⇒ cancelled、金额强制 0（即便这张工单本来算得出钱）', () => {
    expect(resolveProcess(ticket, { amountType: 'reject' })).toEqual({
      status: 'cancelled',
      amountType: 'reject',
      amountMinor: 0,
      refundRatio: null,
    })
  })

  it('fixed 金额非法（负 / 小数 / 超上界）⇒ AmountValidationError，不静默取整', () => {
    expect(() => resolveProcess(ticket, { amountType: 'fixed', amountMinor: -1 })).toThrow(AmountValidationError)
    expect(() => resolveProcess(ticket, { amountType: 'fixed', amountMinor: 1.5 })).toThrow(AmountValidationError)
    expect(() =>
      resolveProcess(ticket, { amountType: 'fixed', amountMinor: MAX_FIXED_AMOUNT_MINOR + 1 }),
    ).toThrow(AmountValidationError)
  })

  it('fixed 金额边界（0 与上界）⇒ 放行', () => {
    expect(assertValidFixedAmount(0)).toBeUndefined()
    expect(assertValidFixedAmount(MAX_FIXED_AMOUNT_MINOR)).toBeUndefined()
  })

  it('ratio 越界（<0 / >1 / NaN / Infinity）⇒ AmountValidationError', () => {
    for (const bad of [-0.1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveProcess(ticket, { amountType: 'ratio', refundRatio: bad })).toThrow(
        AmountValidationError,
      )
    }
    expect(assertValidRatio(0)).toBeUndefined()
    expect(assertValidRatio(1)).toBeUndefined()
  })
})

describe('isProcessable', () => {
  it('只有 pending 可处理；completed / cancelled 都是已终态', () => {
    expect(isProcessable('pending')).toBe(true)
    expect(isProcessable('completed')).toBe(false)
    expect(isProcessable('cancelled')).toBe(false)
  })
})

describe('pg 类型陷阱的收口（bigint 与 numeric 都返回【字符串】）', () => {
  it('toMinor：字符串、数字、null 都能落到 number', () => {
    expect(toMinor('10000')).toBe(10_000)
    expect(toMinor(10_000)).toBe(10_000)
    expect(toMinor(null)).toBe(0)
    expect(toMinor(undefined)).toBe(0)
  })

  it('toRatioOrNull：null 保持 null（fixed/reject 路的比例就是 null，不是 0）', () => {
    expect(toRatioOrNull('0.1000')).toBe(0.1)
    expect(toRatioOrNull(null)).toBeNull()
    expect(toRatioOrNull(undefined)).toBeNull()
  })
})

describe('TicketStatus 的取值就是源侧权威三态', () => {
  it('没有 processing —— 源 types/afterSalesWorkOrder.ts 那个 4 态版全仓零写入，是死声明', () => {
    const all: TicketStatus[] = ['pending', 'completed', 'cancelled']
    expect(all).toHaveLength(3)
  })
})
