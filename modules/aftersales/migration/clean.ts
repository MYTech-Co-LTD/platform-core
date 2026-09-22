// clean.ts — wuji 源行 → 目标行的清洗（纯函数；M2b 的单位/词表/拼写归一**唯一处**）。
//
// 裁决落点（2026-09-22 拍板，见计划全局约束）：
//   · 历史附件不迁行：damage_images 在 cleanTicket 里整字段丢弃（ticket_attachment 只装新 ZOS 附件）。
//   · 金额整数分：工单域源值「元带分精度」（§2.4 源码实证）⇒ 换算只在 yuanToMinor 一处；
//     接龙域单位未证 ⇒ groupbuyToMinor 在 setGroupbuyUnit 之前一律抛（T3 自证后才许设）。
//   · openId/openid 两拼写归一（§3.3）；审批/工单状态词表归一英文枚举（§5 #9）。
//   · 词表未知值**不硬映射缺省**：mapValue 未知值一律 null，导入侧对必填枚举为 null 的行
//     跳行记因（unknown_status / unknown_amount_type / unknown_approve_type）——T3 核对
//     「按 skip 计数对照」与 T5 验收「未知状态不会落库为 pending」的前提都在这一条。
//   · refund_ratio 源存小数（注释谎称 %）⇒ 原样 4 位小数，绝不 ×100。
//
// ⚠️ *_KEYS 的字段名候选是 W1 按 spec §3.3 实证表 + 源仓调用面写的【暂定】清单——
//    T3 拉样后逐表核对：删掉不存在的候选、钉死真实字段名，fixtures 同步替换为脱敏真样本。
//    候选顺序即优先级（先命中先用）。
type SrcRow = Record<string, unknown>

function pick(row: SrcRow, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
function pickStr(row: SrcRow, keys: readonly string[], fallback = ''): string {
  const v = pick(row, keys)
  if (v === undefined) return fallback
  return (typeof v === 'string' ? v : String(v)).trim()
}
function pickInt(row: SrcRow, keys: readonly string[], fallback = 0): number {
  const v = pick(row, keys)
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}
/** 时间字段五套并存（§3.3）：按候选顺序取第一个可解析的。 */
const TIME_KEYS = ['create_time', 'created_at', '_ctime', 'ctime', 'timestamp_with_watermark'] as const
function pickTime(row: SrcRow, keys: readonly string[] = TIME_KEYS): Date | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v !== 'string' || v === '') continue
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

// ── 单位（裁决 5 的唯一处）──────────────────────────────────────────────
/** 工单域：元(带分精度) → 整数分。round 兜 7549.99*100=754998.999… 的浮点尾。 */
export function yuanToMinor(v: unknown): bigint | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return BigInt(Math.round(n * 100))
}

export type GroupbuyUnit = 'fen' | 'yuan'
export const GROUPBUY_UNIT_UNPROVEN = 'GROUPBUY_UNIT_UNPROVEN'
let groupbuyUnit: GroupbuyUnit | null = null
/** 只允许 T3 的样本自证结论（或客户答复）把单位设进来——「数据自证禁猜」的落点。 */
export function setGroupbuyUnit(u: GroupbuyUnit): void { groupbuyUnit = u }
/** 仅供测试重置模块级状态（clean.test.ts 的 beforeEach、T4 接龙用例开头先调它——消除用例间
 *  顺序依赖：没有它，「未自证即抛」类用例红绿取决于文件内谁先跑）。生产路径无调用方。 */
export function resetGroupbuyUnit(): void { groupbuyUnit = null }
export function groupbuyUnitProven(): boolean { return groupbuyUnit !== null }
export function groupbuyToMinor(v: unknown): bigint {
  if (groupbuyUnit === null) {
    throw new Error(`${GROUPBUY_UNIT_UNPROVEN}：接龙金额单位未经数据自证/客户确认，禁止按猜测换算（spec §5 #7②）`)
  }
  if (groupbuyUnit === 'fen') {
    if (v === undefined || v === null || v === '') return 0n
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n
  }
  return yuanToMinor(v) ?? 0n
}

// ── 词表与拼写归一 ─────────────────────────────────────────────────────
export const APPROVE_STATUS_MAP: Record<string, string> = {
  pending: 'pending', approved: 'approved', rejected: 'rejected',
  '待审批': 'pending', '通过': 'approved', '驳回': 'rejected',
}
export const TICKET_STATUS_MAP: Record<string, string> = {
  pending: 'pending', completed: 'completed', cancelled: 'cancelled',
  '待处理': 'pending', '已处理': 'completed', '已驳回': 'cancelled',
}
export const AMOUNT_TYPE_MAP: Record<string, 'ratio' | 'fixed' | 'reject'> = {
  ratio: 'ratio', fixed: 'fixed', reject: 'reject',
  '按比例': 'ratio', '固定金额': 'fixed', '驳回': 'reject',
}
/** 词表映射：未知值一律 null，**无 fallback 参数**——硬映射缺省（status→pending、amountType→ratio）
 *  会把不可解释的源值静默改成可解释的错值，正是 T3 核对要消灭的东西。导入侧对必填枚举为 null
 *  的行跳行记因（见 import.ts），skip 计数就是 T3/T5 的对照面。 */
function mapValue<T>(map: Record<string, T>, v: unknown): T | null {
  const key = typeof v === 'string' ? v.trim() : String(v ?? '')
  return map[key] ?? null
}
/** 同概念两拼写（§3.3：employee_info.openId vs employee_info_approve.openid）。 */
export function openIdOf(row: SrcRow): string {
  return pickStr(row, ['openId', 'openid', 'open_id'])
}
/** 源 employee_info.store_info 逗号多门店串（中英文逗号都见过）→ source_id 列表。 */
export function splitStoreRefs(v: unknown): string[] {
  if (typeof v !== 'string') return []
  return v.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '')
}
/** refund_ratio 源存【小数比例】（注释谎称 %，§2.4 实证）——原样 4 位小数，绝不 ×100。 */
export function ratioOf(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n.toFixed(4) : null
}

// ── 各表字段候选（暂定；T3 拉样逐表核对）──────────────────────────────
export const KEYS = {
  region: { id: ['_id'], name: ['name', 'region_name'] },
  store: { id: ['_id'], name: ['name', 'store_name'], region: ['region_id', 'region'], address: ['address'], phone: ['phone', 'contact'] },
  product: { id: ['_id'], name: ['name', 'product_name'], spec: ['spec', 'specification'],
             basicQuantity: ['basic_quantity'], basicUnitPrice: ['basic_unit_price', 'price'] },
  employee: { id: ['_id'], name: ['name'], phone: ['phone', 'mobile'], approveStatus: ['approve_status', 'status'] },
  approval: { id: ['_id'], type: ['approve_type', 'type'], status: ['status', 'approve_status'],
              info: ['approveinfo'], decidedBy: ['decided_by', 'approver'] },
  rule: { id: ['_id'], name: ['name', 'rule_name'], ratio: ['refund_ratio', 'after_sales_rate'], remark: ['remark'] },
  ticket: {
    id: ['_id'], code: ['order_number', 'work_order_number', 'code'],
    productRef: ['product_name'], storeRef: ['store_selection', 'store_info'],
    damageQuantity: ['damage_quantity'], basicQuantity: ['basic_quantity'],
    basicUnitPrice: ['basic_unit_price'], status: ['status'],
    amountType: ['after_sales_type'], amount: ['after_sales_amount'], ratio: ['after_sales_rate'],
    operator: ['operator', 'handler'], remark: ['remark', 'remarks'],
    relatedOrder: ['related_order', 'order_id'],
  },
} as const

// ── 清洗产物（import.ts 的入参形状）───────────────────────────────────
export interface CleanRegion { sourceId: string; name: string }
export interface CleanStore { sourceId: string; name: string; regionSourceId: string | null; address: string; phone: string }
export interface CleanProduct { sourceId: string; name: string; spec: string; basicQuantity: number; basicUnitPriceMinor: bigint | null }
// 词表产物的 null 语义：源值不在词表（未知/缺失）——导入侧跳行记因，见各 import* 的 unknown_* 检查
export interface CleanEmployee { sourceId: string; name: string; phone: string; openId: string; approveStatus: string | null; storeSourceIds: string[] }
export interface CleanEmployeeApproval {
  sourceId: string; openId: string; approveType: 'register' | 'change' | null; status: string | null
  oldInfo: Record<string, unknown>; newInfo: Record<string, unknown>
  createdAt: Date | null; decidedAt: Date | null; decidedBy: string
}
export interface CleanRule { sourceId: string; name: string; refundRatio: string | null; remark: string }
export interface CleanTicket {
  sourceId: string; code: string; submitterOpenid: string
  productRefRaw: string; storeRefRaw: string        // 二义（ID 或名称）——import 侧带档案映射洗清
  damageQuantity: number; basicQuantity: number; basicUnitPriceMinor: bigint | null
  status: string | null; amountType: 'ratio' | 'fixed' | 'reject' | null
  amountMinor: bigint | null; refundRatio: string | null
  operator: string; remark: string; relatedOrder: string
  createdAt: Date | null; processedAt: Date | null
}

export function cleanRegion(row: SrcRow): CleanRegion {
  return { sourceId: pickStr(row, KEYS.region.id), name: pickStr(row, KEYS.region.name) }
}
export function cleanStore(row: SrcRow): CleanStore {
  return {
    sourceId: pickStr(row, KEYS.store.id), name: pickStr(row, KEYS.store.name),
    regionSourceId: pickStr(row, KEYS.store.region) || null,
    address: pickStr(row, KEYS.store.address), phone: pickStr(row, KEYS.store.phone),
  }
}
export function cleanProduct(row: SrcRow): CleanProduct {
  return {
    sourceId: pickStr(row, KEYS.product.id), name: pickStr(row, KEYS.product.name),
    spec: pickStr(row, KEYS.product.spec),
    basicQuantity: pickInt(row, KEYS.product.basicQuantity),
    // 单位跟随工单域实证（§2.4：公式把它当元用）——T3 拉样核对量级（若显分数量级则此处是唯一改点）
    basicUnitPriceMinor: yuanToMinor(pick(row, KEYS.product.basicUnitPrice)),
  }
}
export function cleanEmployee(row: SrcRow): CleanEmployee {
  return {
    sourceId: pickStr(row, KEYS.employee.id), name: pickStr(row, KEYS.employee.name),
    phone: pickStr(row, KEYS.employee.phone), openId: openIdOf(row),
    approveStatus: mapValue(APPROVE_STATUS_MAP, pick(row, KEYS.employee.approveStatus)),
    storeSourceIds: splitStoreRefs(row.store_info),
  }
}
export function cleanEmployeeApproval(row: SrcRow): CleanEmployeeApproval {
  // approveinfo：全区唯一嵌套字段（§3.3）——形状 { old: {...}, new: {...} }（T3 核对，形状不符就地修）
  const info = row.approveinfo
  const oldInfo = info && typeof info === 'object' && 'old' in (info as object)
    ? ((info as { old: Record<string, unknown> }).old ?? {}) : {}
  const newInfo = info && typeof info === 'object' && 'new' in (info as object)
    ? ((info as { new: Record<string, unknown> }).new ?? {}) : {}
  const typeRaw = pickStr(row, KEYS.approval.type)
  return {
    sourceId: pickStr(row, KEYS.approval.id), openId: openIdOf(row),
    // approve_type 与状态同规则：只有 register/注册、change/变更 四个拼写可映射，其余 → null（跳行）
    approveType: typeRaw === 'change' || typeRaw === '变更' ? 'change'
      : typeRaw === 'register' || typeRaw === '注册' ? 'register' : null,
    status: mapValue(APPROVE_STATUS_MAP, pick(row, KEYS.approval.status)),
    oldInfo, newInfo,
    createdAt: pickTime(row), decidedAt: pickTime(row, ['decided_at', 'decided_time']),
    decidedBy: pickStr(row, KEYS.approval.decidedBy),
  }
}
export function cleanRule(row: SrcRow): CleanRule {
  return {
    sourceId: pickStr(row, KEYS.rule.id), name: pickStr(row, KEYS.rule.name),
    refundRatio: ratioOf(pick(row, KEYS.rule.ratio)), remark: pickStr(row, KEYS.rule.remark),
  }
}
export function cleanTicket(row: SrcRow): CleanTicket {
  // 裁决 1：damage_images（无极 COS URL）整字段丢弃——历史附件不迁行，ticket_attachment 只装新 ZOS 附件。
  return {
    sourceId: pickStr(row, KEYS.ticket.id), code: pickStr(row, KEYS.ticket.code),
    submitterOpenid: openIdOf(row),
    productRefRaw: pickStr(row, KEYS.ticket.productRef), storeRefRaw: pickStr(row, KEYS.ticket.storeRef),
    damageQuantity: pickInt(row, KEYS.ticket.damageQuantity),
    basicQuantity: pickInt(row, KEYS.ticket.basicQuantity),
    basicUnitPriceMinor: yuanToMinor(pick(row, KEYS.ticket.basicUnitPrice)),
    status: mapValue(TICKET_STATUS_MAP, pick(row, KEYS.ticket.status)),
    amountType: ((): 'ratio' | 'fixed' | 'reject' | null => {
      const raw = pick(row, KEYS.ticket.amountType)
      if (raw === undefined || raw === null || raw === '') return null   // 缺值与未知值同路 null
      return mapValue(AMOUNT_TYPE_MAP, raw)                              // 未知值 → null ⇒ 导入侧跳行
    })(),
    amountMinor: yuanToMinor(pick(row, KEYS.ticket.amount)),
    refundRatio: ratioOf(pick(row, KEYS.ticket.ratio)),
    operator: pickStr(row, KEYS.ticket.operator), remark: pickStr(row, KEYS.ticket.remark),
    relatedOrder: pickStr(row, KEYS.ticket.relatedOrder),
    createdAt: pickTime(row), processedAt: pickTime(row, ['update_time', 'processed_at', '_mtime']),
  }
}
