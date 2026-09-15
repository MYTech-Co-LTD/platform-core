// domain/ticket.ts — 售后工单的业务内核【纯函数】：没有 IO（无 pg、无 Hono、无 fetch）。
// 抽出来的理由：这是 M2a 里唯一必须逐行对齐源行为的逻辑（spec §2.4），得能脱离数据库被穷举测试。
// 路由层只负责取数、开事务、把结果落库——算与判一概在这里。

/**
 * 三态状态机（spec §2.4）：pending → completed | cancelled。
 * 这里是状态取值的【唯一事实源】：类型从数组派生、测试直接断言数组本身，
 * 所以「往状态集里加一个值」会让类型与断言同时跟上，不可能出现类型漂移。
 * 源 types/afterSalesWorkOrder.ts 那个含 processing 的 4 态版本全仓零写入，是死声明，勿照搬。
 */
export const TICKET_STATUSES = ['pending', 'completed', 'cancelled'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export type AmountType = 'ratio' | 'fixed' | 'reject'

/**
 * M2a 新增守卫（源侧没有这个上界）：fixed 的金额是操作员手输的，必须有个天花板挡住误输。
 * 取一百万元——远高于任何真实售后单，又远低于 Number.MAX_SAFE_INTEGER。
 *
 * 【作用域只到 fixed 路】只有 assertValidFixedAmount 用它。ratio 路的金额是按公式算出来的，
 * 【没有任何显式上界】——它的取值上界由「报损数量 × 单价的合法输入范围」决定，不由本常量兜底。
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
 * 转 Number 在这里安全：比例是 4 位小数；金额分两路——fixed 由 MAX_FIXED_AMOUNT_MINOR（1e8 分）卡住，
 * ratio 由「报损数量 × 单价的合法输入范围」决定。两路都远在 2^53 之内。
 * 【别外推】1e8 只是 fixed 路的上界，不是全模块的兜底——ratio 路的金额没有显式上界。
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
 * 源（afterSalesWorkOrderManage.vue:687-705）在浏览器里按「元」算，末尾 `Math.round(amount*100)/100`
 * 是按分的四舍五入；目标表单价本来就是分，所以这里只剩一次 `Math.round` 到分。
 *
 * 【与源侧的关系】这里是【精确算术的按分四舍五入】；与源侧在【恰好半分位】上可差 1 分
 * （源侧浮点噪声所致，非本实现算错）——例：q=14.5、单价 0.01 元，
 * 源序 `Math.round(14.5 × 0.01 × 100)` = 14（中间值 14.499999999999998），本实现 `Math.round(14.5 × 1)` = 15。
 * 数学真值 14.5 分四舍五入就是 15 ⇒ 规格「四舍五入到分」被本实现精确满足。
 * （按 q∈{0.5,…,200 半步} × 单价∈{1..3000 分} 扫描：1_200_000 组里 34_636 处分歧，全部落在恰好半分位。）
 *
 * `basicQuantity * refundRatio` 会产生 IEEE 浮点尾差（如 0.1×3 = 0.30000000000000004、
 * 3×0.29 = 0.8699999999999999），但结果只经过一次乘法就被舍入到整数分，误差被舍入吸收；
 * 不参与累加，不会像浮点金额那样攒出假差额。
 */
export function computeAmountMinor(i: AmountInput): number {
  const payableQuantity = i.damageQuantity - i.basicQuantity * i.refundRatio
  if (payableQuantity <= 0) return 0
  return Math.round(payableQuantity * i.basicUnitPriceMinor)
}

/**
 * 比例的存储契约：`ticket.refund_ratio` 是 numeric(6,4)（spec §2.4 源侧保存走 .toFixed(4)）。
 * 算钱用的比例与落库的比例必须是【同一个数】，否则库里 (refund_ratio, amount_minor) 自相矛盾
 * ——按落库比例复算得不出落库金额，正是 spec §2.1「整数分」要防的对账假差额。
 */
export const REFUND_RATIO_DECIMALS = 4

/**
 * 比例收口的【唯一实现】（纯函数，无 IO）：先按现有口径卡 [0, 1] 与有限性（越界抛
 * AmountValidationError），再把比例四舍五入到存储契约的 4 位小数，【返回归一后的值】。
 *
 * 为什么是「四舍五入」而不是「拒绝 >4 位小数」：列就是 numeric(6,4)，存 0.123456789 会被列型
 * 收窄成 0.1235；与其让列型自己收窄、或干脆拒绝，不如在这里收口——算钱与落库用同一个数。
 * （计划 2329-2334 行的用例即：提交 0.123456789 ⇒ 落库 refund_ratio = 0.1235，是成功不是 400。）
 *
 * 归一按【十进制真值】做，不直接 `Math.round(r * 1e4) / 1e4`：`r * 1e4` 会把浮点噪声一起放大，
 * 恰好半分位上会漏进位（0.00015、0.33335 这类），而目标列 numeric(6,4) 自身的口径是半分位进位
 * ——两边口径必须一致。实测：0..1 的 100_001 个 5 位小数字面量里，直乘有 573 个漏进位、
 * 被 toFixed 的二进制近似带偏的有 4992 个，本实现 0 个偏离十进制真值。
 * 先按 15 位有效数字把二进制尾差收干净（十进制输入在 double 里的噪声 ~1e-16 相对量级），再整数量化。
 *
 * 注：先卡后归一 ⇒ 归一值必然仍在 [0, 1]（r ∈ [0,1] ⇒ r·10⁴ ∈ [0,10⁴] ⇒ 归一值 ∈ [0,1]），
 * 因此不需要再补一道「归一后复核」。
 */
export function normalizeRatio(r: number): number {
  if (!Number.isFinite(r) || r < 0 || r > 1) {
    throw new AmountValidationError(`refundRatio 必须在 [0, 1] 内（收到 ${r}）`)
  }
  const factor = 10 ** REFUND_RATIO_DECIMALS
  return Math.round(Number((r * factor).toPrecision(15))) / factor
}

/**
 * 比例合法性的校验面（签名与语义保持不变，返回 void）。工单处理（ratio 路）与规则写侧（T7）
 * 共用这一条口径：内部委托 normalizeRatio 后丢弃返回值——「一条口径只有一个实现」，
 * 改了归一也就改了校验，不会两边漂移。
 */
export function assertValidRatio(r: number): void {
  normalizeRatio(r)
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

/**
 * 可处理状态（三态里的 pending）。`satisfies TicketStatus` 把它钉在 TICKET_STATUSES 派生出的类型上
 * ——取值表改名/删值，这里编译期就报错，不会静默漂移；同时口径不放宽：
 * 只列进来的这一态算可处理（fail-closed），将来多出第四态默认【不可】处理。
 */
const PROCESSABLE_STATUS = 'pending' satisfies TicketStatus

/** 只有 pending 可以进处理动作；completed / cancelled 都是终态。 */
export function isProcessable(status: TicketStatus): boolean {
  return status === PROCESSABLE_STATUS
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
      // normalizeRatio 一次收口（校验 + 归一），归一值【同时】用于算钱与落库：
      // 不能拿全精度的比例算钱、却被 numeric(6,4) 收窄后落库——那样库里的
      // (refund_ratio, amount_minor) 复算不上，正是 §2.1「整数分」要防的对账假差额。
      // 校验口径不另起炉灶：assertValidRatio 就是本函数丢弃返回值的薄封装。
      const refundRatio = normalizeRatio(input.refundRatio)
      return {
        status: 'completed',
        amountType: 'ratio',
        amountMinor: computeAmountMinor({ ...ticket, refundRatio }),
        refundRatio,
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
