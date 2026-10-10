import { describe, expect, it } from 'vitest'
import { analyzePhones, maskPhone, normalizePhone } from './audit-employee-phones.mjs'

// Task 11（账户统一 Phase 1）：存量手机号摸底——纯核用例。
// 掩码口径：前 3 后 2、中间 ****（00-global-constraints「敏感值」条）；与
// apps/server/src/identity-links.ts 的 normalizePhone/maskPhone 同口径（脚本自带实现，不 import 仓 src）。

const row = (over = {}) => ({ org: 'o1', openId: 'oA', phone: '13812345678', approveStatus: 'approved', ...over })

describe('normalizePhone（归一，与 identity-links.ts 同口径）', () => {
  it('11 位手机号原样返回；86+11 位共 13 位去国家码', () => {
    expect(normalizePhone('13812345678')).toBe('13812345678')
    expect(normalizePhone('8613812345678')).toBe('13812345678')
  })
  it('剥掉非数字（空格/横线）后归一', () => {
    expect(normalizePhone('138 1234-5678')).toBe('13812345678')
    expect(normalizePhone('+86 138 1234 5678')).toBe('13812345678')
  })
  it('恰好 11 位即放行（含 0 开头座机）——与 identity-links.ts 逐字同口径，不私加规则', () => {
    expect(normalizePhone('07551234567')).toBe('07551234567')
  })
  it('非 11 位（残号/多一位的 86 前缀变体/非数字）→ null', () => {
    expect(normalizePhone('1381234567')).toBeNull()        // 10 位
    expect(normalizePhone('861381234567')).toBeNull()      // 86+10 位 ≠ 13 位，不去码也不放行
    expect(normalizePhone('abc')).toBeNull()
  })
})

describe('maskPhone（前 3 后 2；短于 6 位全遮）', () => {
  it('11 位 → 138****78；null 透传', () => {
    expect(maskPhone('13812345678')).toBe('138****78')
    expect(maskPhone(null)).toBeNull()
  })
  it('短于 6 位 ⇒ 整串遮住（前3后2 会把短串全露出来）', () => {
    expect(maskPhone('13812')).toBe('****')
    expect(maskPhone('12345')).toBe('****')
  })
})

describe('analyzePhones（只读盘点纯核）', () => {
  it('空清单 → 全零', () => {
    expect(analyzePhones([])).toEqual({ total: 0, empty: 0, invalid: 0, dupGroups: [] })
  })
  it('汇总计数：total 全量；空号（含空白串）与无效号分开数', () => {
    const r = analyzePhones([
      row(),                                    // 有效
      row({ openId: 'oB', phone: '' }),         // 空
      row({ openId: 'oC', phone: '   ' }),      // 空白也算空
      row({ openId: 'oD', phone: '138x' }),     // 无效
    ])
    expect(r.total).toBe(4)
    expect(r.empty).toBe(2)
    expect(r.invalid).toBe(1)
  })
  it('盘点不筛 approve_status：pending/rejected 行一样进 total（摸底 = 全量事实）', () => {
    const r = analyzePhones([
      row({ approveStatus: 'pending' }),
      row({ openId: 'oB', approveStatus: 'rejected' }),
    ])
    expect(r.total).toBe(2)
    expect(r.empty).toBe(0)
    expect(r.invalid).toBe(0)
  })
  it('dup 分组：同 org 同（归一后）号码、≥2 个不同 openid 才成组；86 前缀先归一再比', () => {
    const r = analyzePhones([
      row({ openId: 'oA', phone: '13812345678' }),
      row({ openId: 'oB', phone: '8613812345678' }),   // 同号（去国家码）
    ])
    expect(r.dupGroups).toEqual([
      { org: 'o1', phoneMasked: '138****78', openids: ['oA', 'oB'] },
    ])
  })
  it('不同 org 的同号不算 dup（绑定与置信池都按 org 圈死）；同 openid 重复行不成组', () => {
    const r = analyzePhones([
      row({ org: 'o1', openId: 'oA', phone: '13812345678' }),
      row({ org: 'o2', openId: 'oX', phone: '13812345678' }),  // 跨 org
      row({ org: 'o1', openId: 'oA', phone: '13812345678' }),  // 同 openid 重复行
    ])
    expect(r.dupGroups).toEqual([])
  })
  it('dup 组的 openids 去重且保出现序；组间按 org、号码排序（确定性输出）', () => {
    const r = analyzePhones([
      row({ org: 'o2', openId: 'z1', phone: '13900000001' }),
      row({ org: 'o2', openId: 'a1', phone: '13900000001' }),
      row({ org: 'o2', openId: 'a1', phone: '13900000001' }),  // 重复行：openid 去重
      row({ org: 'o1', openId: 'm1', phone: '13812345678' }),
      row({ org: 'o1', openId: 'n1', phone: '13812345678' }),
      row({ org: 'o1', openId: 'p1', phone: '13700000000' }),
      row({ org: 'o1', openId: 'q1', phone: '13700000000' }),
    ])
    expect(r.dupGroups).toEqual([
      { org: 'o1', phoneMasked: '137****00', openids: ['p1', 'q1'] },
      { org: 'o1', phoneMasked: '138****78', openids: ['m1', 'n1'] },
      { org: 'o2', phoneMasked: '139****01', openids: ['z1', 'a1'] },
    ])
  })
  it('安全口径：输出（含 dup 明细）里绝不出现完整手机号', () => {
    const r = analyzePhones([
      row({ openId: 'oA', phone: '13812345678' }),
      row({ openId: 'oB', phone: '13812345678' }),
      row({ org: 'o2', openId: 'oX', phone: '12' }),  // 短号若成组必须全遮
      row({ org: 'o2', openId: 'oY', phone: '12' }),
    ])
    const s = JSON.stringify(r)
    expect(s).not.toContain('13812345678')
    expect(s).toContain('138****78')
    expect(s).toContain('****')
  })
})
