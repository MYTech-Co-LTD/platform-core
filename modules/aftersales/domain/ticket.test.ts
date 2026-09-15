import { describe, expect, it } from 'vitest'
import {
  AmountValidationError,
  MAX_FIXED_AMOUNT_MINOR,
  TICKET_STATUSES,
  assertValidFixedAmount,
  assertValidRatio,
  computeAmountMinor,
  isProcessable,
  normalizeRatio,
  resolveProcess,
  toMinor,
  toRatioOrNull,
} from './ticket'

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

  it('ratio 路返回【归一后】的比例（不是原始输入）——落库方拿到的就是算钱用的那个', () => {
    const out = resolveProcess(ticket, { amountType: 'ratio', refundRatio: 0.123456 })
    expect(out.refundRatio).toBe(0.1235)
    expect(out.amountMinor).toBe(
      computeAmountMinor({ ...ticket, refundRatio: out.refundRatio as number }),
    )
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

  it('fixed 金额非法（负 / 小数 / 超上界 / NaN / Infinity）⇒ AmountValidationError，不静默取整', () => {
    // NaN / Infinity 走同一条 Number.isInteger 判据（对二者都是 false）。之所以要钉住：
    // 将来若有人把校验放宽成 `typeof m === 'number'`（看着等价），NaN 会一路写进
    // amount_minor(bigint)——pg 侧要么报错要么写 0，而这里不会红。
    for (const bad of [
      -1,
      1.5,
      MAX_FIXED_AMOUNT_MINOR + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => resolveProcess(ticket, { amountType: 'fixed', amountMinor: bad })).toThrow(
        AmountValidationError,
      )
    }
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

describe('normalizeRatio —— 算钱的比例与落库的比例是同一个数（评审 R4 / Important-1）', () => {
  const T = { damageQuantity: 100, basicQuantity: 100, basicUnitPriceMinor: 50_000 }

  it('自洽性质：amountMinor === 用【返回的】refundRatio 再算一次（4 位/5 位小数字面量参数化）', () => {
    const ratios = [
      0, 0.1, 0.25, 0.5, 1, 0.99999,
      0.12345, 1 / 3, 0.10005, 0.00015, 0.33335, 0.77775, 2 / 3, 0.123456, 0.98765, 0.123456789,
    ]
    for (const r of ratios) {
      const out = resolveProcess(T, { amountType: 'ratio', refundRatio: r })
      const stored = out.refundRatio as number
      // ① 自洽：拿返回的比例复算，等于返回的金额。
      //    注意这条【单独不能抓到本次 bug】——修复前算钱与返回值同源（都是原始输入），它也成立。
      expect(out.amountMinor).toBe(computeAmountMinor({ ...T, refundRatio: stored }))
      // ② 返回的比例【已经】是存储契约上的值（幂等）⇒ numeric(6,4) 收窄它不再改变数值。
      //    这条才是会因「全精度算钱 + 落库被收窄」而红的守卫。
      expect(normalizeRatio(stored)).toBe(stored)
      // ③ 存储往返：它就是某个 4 位小数字符串的最近 double（写进 pg 再读出来是同一个数）。
      expect(Number(stored.toFixed(4))).toBe(stored)
    }
  })

  it('评审给出的漂移场景（修复前库内 (比例, 金额) 复算不上）', () => {
    // 0.12345：全精度算得 882_750 分，落库被 numeric(6,4) 收窄成 0.1235，
    // 按落库比例复算只有 882_500 分 —— 差 250 分，正是「整数分」要防的对账假差额。
    const t = { damageQuantity: 30, basicQuantity: 100, basicUnitPriceMinor: 50_000 }
    const out = resolveProcess(t, { amountType: 'ratio', refundRatio: 0.12345 })
    expect(out.refundRatio).toBe(0.1235)
    expect(out.amountMinor).toBe(882_500)
    expect(out.amountMinor).toBe(computeAmountMinor({ ...t, refundRatio: 0.1235 }))
    expect(computeAmountMinor({ ...t, refundRatio: 0.12345 })).toBe(882_750)

    // 1/3 更明显：全精度 3_333_333 ⇒ 落 0.3333 复算 3_333_500（差 167 分）。
    const t2 = { damageQuantity: 100, basicQuantity: 100, basicUnitPriceMinor: 50_000 }
    const out2 = resolveProcess(t2, { amountType: 'ratio', refundRatio: 1 / 3 })
    expect(out2.refundRatio).toBe(0.3333)
    expect(out2.amountMinor).toBe(3_333_500)
    expect(out2.amountMinor).toBe(computeAmountMinor({ ...t2, refundRatio: 0.3333 }))
    expect(computeAmountMinor({ ...t2, refundRatio: 1 / 3 })).toBe(3_333_333)
  })

  it('恰好半分位按【十进制真值】进位（直接 Math.round(r*1e4)/1e4 会漏进位的那几个）', () => {
    expect(normalizeRatio(0.12345)).toBe(0.1235)
    expect(normalizeRatio(0.10005)).toBe(0.1001)
    expect(normalizeRatio(0.00015)).toBe(0.0002) // 直乘：0.00015*1e4 = 1.4999999999999998 ⇒ 会漏成 0.0001
    expect(normalizeRatio(0.33335)).toBe(0.3334) // 直乘：3333.4999999999995 ⇒ 会漏成 0.3333
  })

  it('多于 4 位【四舍五入】到 4 位（不是拒绝）；4 位以内原样返回', () => {
    // 计划 2329-2334：提交 refundRatio=0.123456789 ⇒ 落库 refund_ratio = 0.1235（成功，不是 400）。
    expect(normalizeRatio(0.123456789)).toBe(0.1235)
    expect(normalizeRatio(0.123456)).toBe(0.1235)
    expect(normalizeRatio(1 / 3)).toBe(0.3333)
    expect(normalizeRatio(2 / 3)).toBe(0.6667)
    for (const r of [0, 0.1, 0.25, 0.5, 0.9999, 1]) expect(normalizeRatio(r)).toBe(r)
    // 归一值就是 4 位小数：十进制写法直接钉住。
    expect(String(normalizeRatio(0.123456789))).toBe('0.1235')
  })

  it('入参本身越界（>1 / 负数 / NaN / ±Infinity）⇒ 先卡后归一，抛 AmountValidationError', () => {
    for (const bad of [
      1.00005,
      1.5,
      -0.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => normalizeRatio(bad)).toThrow(AmountValidationError)
    }
    // 贴着上界但本身合法 —— 归一后落在 1，不抛（先卡后归一 ⇒ 归一不会把 [0,1] 内的值推出界）。
    expect(normalizeRatio(0.99999)).toBe(1)
  })

  it('assertValidRatio 是 normalizeRatio 丢弃返回值的薄封装（一条口径只有一个实现）', () => {
    expect(assertValidRatio(0.123456789)).toBeUndefined() // 合法即放行，不返回值
    expect(() => assertValidRatio(1.00005)).toThrow(AmountValidationError)
    expect(() => assertValidRatio(Number.NaN)).toThrow(AmountValidationError)
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
    // 断言【真实导出】，不是测试里当场新建的数组：往取值表里加 processing 会让这条红。
    // 且 TicketStatus 是从同一个数组派生的 ⇒ 类型不可能与它漂移（加 processing 必改数组）。
    expect([...TICKET_STATUSES]).toEqual(['pending', 'completed', 'cancelled'])
  })
})
