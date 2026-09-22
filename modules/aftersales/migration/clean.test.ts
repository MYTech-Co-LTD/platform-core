import { beforeEach, describe, expect, it } from 'vitest'
import {
  GROUPBUY_UNIT_UNPROVEN, cleanEmployee, cleanEmployeeApproval, cleanRule, cleanTicket,
  groupbuyToMinor, groupbuyUnitProven, openIdOf, ratioOf, resetGroupbuyUnit, setGroupbuyUnit,
  splitStoreRefs, yuanToMinor,
} from './clean'
import {
  FIXTURE_EMPLOYEE, FIXTURE_EMPLOYEE_APPROVE, FIXTURE_RULE, FIXTURE_TICKET,
} from './fixtures'

describe('单位与归一（裁决 5：唯一处）', () => {
  beforeEach(() => { resetGroupbuyUnit() })   // 模块级单位状态：用例间互不染——首例「未自证即抛」不再依赖文件内执行顺序

  it('yuanToMinor：元(带分精度)→整数分；字符串数字可；空/非法→null', () => {
    expect(yuanToMinor(7549.99)).toBe(754999n)          // 7549.99*100=754998.999…，round 兜住
    expect(yuanToMinor('12.5')).toBe(1250n)
    expect(yuanToMinor(0)).toBe(0n)
    expect(yuanToMinor(null)).toBeNull()
    expect(yuanToMinor('')).toBeNull()
    expect(yuanToMinor('abc')).toBeNull()
  })

  it('groupbuyToMinor：未自证即抛（禁猜是裁决，不是提示）；setGroupbuyUnit 后按域换算', () => {
    expect(groupbuyUnitProven()).toBe(false)
    expect(() => groupbuyToMinor(5000)).toThrow(GROUPBUY_UNIT_UNPROVEN)
    setGroupbuyUnit('fen')
    expect(groupbuyToMinor(5000)).toBe(5000n)
    setGroupbuyUnit('yuan')
    expect(groupbuyToMinor(50)).toBe(5000n)
  })

  it('ratioOf：refund_ratio 源存小数——原样定 4 位小数，绝不 ×100（§2.4 实证）', () => {
    expect(ratioOf(0.05)).toBe('0.0500')
    expect(ratioOf('0.1234')).toBe('0.1234')
    expect(ratioOf(null)).toBeNull()
  })
})

describe('拼写与词表归一（§3.3 实证表）', () => {
  it('openIdOf：openId/openid 两拼写归一', () => {
    expect(openIdOf({ openId: 'oABC' })).toBe('oABC')
    expect(openIdOf({ openid: 'oDEF' })).toBe('oDEF')
    expect(openIdOf({})).toBe('')
  })

  it('splitStoreRefs：中英文逗号都拆、空段滤掉', () => {
    expect(splitStoreRefs('S001，S002, ,S003')).toEqual(['S001', 'S002', 'S003'])
    expect(splitStoreRefs(123)).toEqual([])   // 源字段类型漂移：非串一律空
  })

  it('词表未知值 → null（无硬映射缺省）：未知态不会变 pending、未知类型不会变 ratio', () => {
    expect(cleanTicket({ ...FIXTURE_TICKET, status: '神秘态' }).status).toBeNull()
    expect(cleanTicket({ ...FIXTURE_TICKET, after_sales_type: '第四种' }).amountType).toBeNull()
    expect(cleanEmployee({ ...FIXTURE_EMPLOYEE, approve_status: '待定' }).approveStatus).toBeNull()
    expect(cleanEmployeeApproval({ ...FIXTURE_EMPLOYEE_APPROVE, approve_type: '注销' }).approveType).toBeNull()
    // 已知中英文照常归一
    expect(cleanTicket({ ...FIXTURE_TICKET, status: '已处理' }).status).toBe('completed')
    expect(cleanEmployee({ ...FIXTURE_EMPLOYEE, approve_status: '驳回' }).approveStatus).toBe('rejected')
  })
})

describe('各表清洗（fixtures 按 spec §3.3 实证表编造；T3 拉样后以脱敏真样本替换）', () => {
  it('employee：审批词表三套归一英文；store_info 逗号串拆行；openId 归一', () => {
    const e = cleanEmployee(FIXTURE_EMPLOYEE)
    expect(e).toMatchObject({
      sourceId: '591-001', name: '张三', openId: 'oEMP001',
      approveStatus: 'approved', storeSourceIds: ['S001', 'S002'],
    })
  })

  it('employeeApproval：中文词表归一 + approveinfo 展平两列', () => {
    const a = cleanEmployeeApproval(FIXTURE_EMPLOYEE_APPROVE)
    expect(a).toMatchObject({
      // 源 _id 是 int（§3.3 实证：employee_info_approve 的 _id 与 employee_info 的 str 不同型）——
      // pickStr 把它字符串化，别在断言里写带横线的「看起来像 id」的串
      sourceId: '214001', openId: 'oAPP001', approveType: 'change', status: 'approved',
      oldInfo: { name: '旧名' }, newInfo: { name: '新名' },
    })
  })

  it('rule：refund_ratio 原样（小数，不是百分数）', () => {
    const r = cleanRule(FIXTURE_RULE)
    expect(r.refundRatio).toBe('0.0500')
  })

  it('ticket：金额 ×100 落整数分；状态三态映射；【历史附件整字段丢弃】（裁决 1）', () => {
    const t = cleanTicket(FIXTURE_TICKET)
    expect(t).toMatchObject({
      sourceId: 'wo-001', status: 'completed', amountType: 'ratio',
      amountMinor: 20000n,              // 200 元 → 20000 分
      basicUnitPriceMinor: 1250n,       // 12.5 元 → 1250 分
    })
    // damage_images（COS URL 数组/字符串混用）不进任何产物字段——历史附件不迁行
    //（bigint replacer：产物含 bigint，裸 JSON.stringify 直接 TypeError，断言到不了）
    expect(JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('cos.example')
  })
})
