// domain/ticket.ts — 售后工单的业务内核【纯函数】：没有 IO（无 pg、无 Hono、无 fetch）。
// 抽出来的理由：这是 M2a 里唯一必须逐行对齐源行为的逻辑（spec §2.4），得能脱离数据库被穷举测试。
// 路由层只负责取数、开事务、把结果落库——算与判一概在这里。

export type TicketStatus = 'pending' | 'completed' | 'cancelled'
export type AmountType = 'ratio' | 'fixed' | 'reject'

/**
 * M2a 新增守卫（源侧没有这个上界）：fixed 的金额是操作员手输的，必须有个天花板挡住误输。
 * 取一百万元——远高于任何真实售后单，又远低于 Number.MAX_SAFE_INTEGER（见 toMinor 的说明）。
 */
export const MAX_FIXED_AMOUNT_MINOR = 100_000_000

/** 金额/比例校验失败。路由层捕获它 → 400 INVALID_AMOUNT（不静默取整、不静默归零）。 */
export class AmountValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountValidationError'
  }
}

/**
 * pg 的类型陷阱，一个函数收口：
 *   · bigint(int8) 默认返回【字符串】（pg 怕超出 Number.MAX_SAFE_INTEGER 丢精度）
 *   · numeric 同样返回【字符串】——`ticket_rule.refund_ratio` 就是 numeric(6,4)
 * 不转就直接参与算术是最阴的一类 bug：`"1200" * 3` 会被 JS 算对，`"1200" + 1` 却变成 "12001"。
 * 转 Number 在这里安全——金额上界 1e8 分、比例 4 位小数，都远在 2^53 之内。
 */
export function toMinor(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

/** 同 toMinor，但 null 保持 null——fixed/reject 路的 refund_ratio 就是 null，不能落成 0。 */
export function toRatioOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : Number(v)
}

export interface AmountInput {
  /** 报损数量（件，整数） */
  damageQuantity: number
  /** 基本数量（件，整数）——免赔门槛的基数 */
  basicQuantity: number
  /** 基本单价（整数【分】/件） */
  basicUnitPriceMinor: number
  /** 售后比例（【小数】不是百分数，spec §2.4 源码实证） */
  refundRatio: number
}

/**
 * 售后金额（整数分）= (报损数量 − 基本数量 × 售后比例) × 基本单价；负数取 0；四舍五入到分。
 *
 * 源（afterSalesWorkOrderManage.vue:687-705）在浏览器里算，且末尾是 `Math.round(amount*100)/100`
 * ——那是「元」换算成分的四舍五入。目标表单价本来就是分，所以这一步退化成一次 `Math.round`。
 *
 * `basicQuantity * refundRatio` 会产生 IEEE 浮点尾差（如 100×0.1 = 10.000000000000002），
 * 但结果只经过一次乘法就被舍入到整数分，误差量级 ~1e-12 分，被舍入吸收；不参与累加，
 * 不会像浮点金额那样攒出假差额。
 */
export function computeAmountMinor(i: AmountInput): number {
  const payableQuantity = i.damageQuantity - i.basicQuantity * i.refundRatio
  if (payableQuantity <= 0) return 0
  return Math.round(payableQuantity * i.basicUnitPriceMinor)
}

/** 比例必须是 [0, 1] 的有限数。工单处理（ratio 路）与规则写侧（T7）共用这一条口径。 */
export function assertValidRatio(r: number): void {
  if (!Number.isFinite(r) || r < 0 || r > 1) {
    throw new AmountValidationError(`refundRatio 必须在 [0, 1] 内（收到 ${r}）`)
  }
}

/** 固定额必须是非负【整数分】且不超过 MAX_FIXED_AMOUNT_MINOR。 */
export function assertValidFixedAmount(m: number): void {
  if (!Number.isInteger(m)) {
    throw new AmountValidationError(`固定金额必须是整数分（收到 ${m}）`)
  }
  if (m < 0) {
    throw new AmountValidationError(`固定金额不能为负（收到 ${m}）`)
  }
  if (m > MAX_FIXED_AMOUNT_MINOR) {
    throw new AmountValidationError(
      `固定金额超出上界 ${MAX_FIXED_AMOUNT_MINOR} 分（收到 ${m}）`,
    )
  }
}

/** 只有 pending 可以进处理动作；completed / cancelled 都是终态。 */
export function isProcessable(status: TicketStatus): boolean {
  return status === 'pending'
}

/** 处理动作的输入——三个分支互斥，用 discriminated union 让路由层的 zod 与这里同形。 */
export type ProcessInput =
  | { amountType: 'ratio'; refundRatio: number }
  | { amountType: 'fixed'; amountMinor: number }
  | { amountType: 'reject' }

export interface ProcessOutcome {
  status: TicketStatus
  amountType: AmountType
  amountMinor: number
  refundRatio: number | null
}

/**
 * 把一个处理动作解析成「状态 + 金额 + 比例」——纯函数，不碰数据库。
 * 三条路对应 spec §2.4 的三种金额类型，其中 fixed 是【采信操作员输入】（校验而非重算）。
 */
export function resolveProcess(
  ticket: { damageQuantity: number; basicQuantity: number; basicUnitPriceMinor: number },
  input: ProcessInput,
): ProcessOutcome {
  switch (input.amountType) {
    case 'ratio': {
      assertValidRatio(input.refundRatio)
      return {
        status: 'completed',
        amountType: 'ratio',
        amountMinor: computeAmountMinor({ ...ticket, refundRatio: input.refundRatio }),
        refundRatio: input.refundRatio,
      }
    }
    case 'fixed': {
      assertValidFixedAmount(input.amountMinor)
      return {
        status: 'completed',
        amountType: 'fixed',
        amountMinor: input.amountMinor,
        refundRatio: null,
      }
    }
    case 'reject':
      return { status: 'cancelled', amountType: 'reject', amountMinor: 0, refundRatio: null }
  }
}
