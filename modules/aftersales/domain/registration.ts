// domain/registration.ts — 员工登记/变更的**纯函数内核**（spec §2.5）。
//
// 为什么差异计算在这一层而不在路由：spec §2.5 纪律②——源侧 `submitApproval` 在**前端**逐字段
// diff 后把 old_info/new_info 传给后端（`wuji-2/src/composables/useStoreEmployeeApproval.ts`），
// 按 §0.3 属「前端式编排」。平台的服务端本就知道当前 employee 行 ⇒ **由这里算**，
// 客户端只表达目标值。纯函数 ⇒ 可单测、无 IO。
//
// 门店用**集合语义**（源侧是多选，存成逗号串后顺序无意义）：比较与输出都先归一（去重 + 升序），
// 否则「[1,2] → [2,1]」会被判成一次变更，产生一条什么都没有改的申请。

/** 客户端表达的目标状态（M3b-2 的移动端表单就提交这个形状） */
export interface RegistrationTarget {
  name: string
  phone: string
  storeIds: number[]
}

/** 当前档案的快照（路由从 employee + employee_store 读出后传进来） */
export interface EmployeeSnapshot {
  name: string
  phone: string
  storeIds: number[]
}

/** 登记/变更域的错误——路由把它翻成 400 + message（与 domain/ticket.ts 的 AmountValidationError 同构） */
export class RegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistrationError'
  }
}

/** 归一门店集合：去重 + 升序。集合语义下顺序无意义，不归一会造出假变更。 */
function normalizeStoreIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * 算登记/变更：返回 `{ approveType, oldInfo, newInfo }`，**两个 info 只含实际变了的字段**
 * （照源侧行为——变更申请只记差异，审批人一眼看到改了什么）。
 *
 * @throws RegistrationError 当前已有档案但**没有任何字段变化**时（源侧「您没有修改任何信息」）
 */
export function computeRegistration(
  current: EmployeeSnapshot | null,
  target: RegistrationTarget,
): {
  approveType: 'register' | 'change'
  oldInfo: Partial<RegistrationTarget>
  newInfo: Partial<RegistrationTarget>
} {
  const next = {
    name: target.name,
    phone: target.phone,
    storeIds: normalizeStoreIds(target.storeIds),
  }

  // 无档案 ⇒ 注册：old 空、new 是全部目标字段
  if (current === null) {
    return { approveType: 'register', oldInfo: {}, newInfo: next }
  }

  const prev = {
    name: current.name,
    phone: current.phone,
    storeIds: normalizeStoreIds(current.storeIds),
  }

  const oldInfo: Partial<RegistrationTarget> = {}
  const newInfo: Partial<RegistrationTarget> = {}
  if (prev.name !== next.name) {
    oldInfo.name = prev.name
    newInfo.name = next.name
  }
  if (prev.phone !== next.phone) {
    oldInfo.phone = prev.phone
    newInfo.phone = next.phone
  }
  if (!sameIds(prev.storeIds, next.storeIds)) {
    oldInfo.storeIds = prev.storeIds
    newInfo.storeIds = next.storeIds
  }

  if (Object.keys(newInfo).length === 0) {
    throw new RegistrationError('您没有修改任何信息')
  }
  return { approveType: 'change', oldInfo, newInfo }
}

/**
 * 审批通过时写回 `employee.store_id`（「主门店」遗留列）用哪个门店。
 * 取归一后的第一个。**注意这只是遗留列**——「我的门店」以 `employee_store` 为准。
 */
export function pickPrimaryStoreId(target: RegistrationTarget): number | null {
  const ids = normalizeStoreIds(target.storeIds)
  return ids.length > 0 ? ids[0]! : null
}
