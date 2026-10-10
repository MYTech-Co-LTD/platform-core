import { describe, expect, it } from 'vitest'
import { planBackfill, shouldBackfillWrite } from './backfill-identity-links.mjs'

// Task 11（账户统一 Phase 1）：存量员工身份绑定回填——纯核用例。
// 语义（task-11-brief Step 2）：approved 且手机号有效才进 binds；approved 无有效手机号 →
// invalid 转人工；非 approved 全忽略。normalizePhone 与 identity-links.ts 同口径（脚本自带实现）。

const row = (over = {}) => ({ org: 'o1', openId: 'oA', phone: '13812345678', approveStatus: 'approved', ...over })

describe('planBackfill（回填计划纯核）', () => {
  it('空清单 → 两清单皆空', () => {
    expect(planBackfill([])).toEqual({ binds: [], invalid: [] })
  })
  it('approved + 有效手机号 → binds（phone 归一；86 前缀去国家码）', () => {
    const r = planBackfill([
      row({ openId: 'oA', phone: '13812345678' }),
      row({ org: 'o2', openId: 'oX', phone: '8613900005678' }),
    ])
    expect(r.binds).toEqual([
      { org: 'o1', openId: 'oA', phone: '13812345678' },
      { org: 'o2', openId: 'oX', phone: '13900005678' },
    ])
    expect(r.invalid).toEqual([])
  })
  it('approved + 空/空白手机号 → invalid（phone_empty）转人工，不进 binds', () => {
    const r = planBackfill([
      row({ openId: 'oB', phone: '' }),
      row({ openId: 'oC', phone: '   ' }),
    ])
    expect(r.binds).toEqual([])
    expect(r.invalid.map((i) => ({ org: i.org, openId: i.openId, reason: i.reason }))).toEqual([
      { org: 'o1', openId: 'oB', reason: 'phone_empty' },
      { org: 'o1', openId: 'oC', reason: 'phone_empty' },
    ])
  })
  it('approved + 无效手机号 → invalid（phone_invalid），phoneMasked 掩码且不带原始全号', () => {
    const r = planBackfill([row({ openId: 'oD', phone: '138123456' })])
    expect(r.binds).toEqual([])
    expect(r.invalid).toEqual([{ org: 'o1', openId: 'oD', phoneMasked: '138****56', reason: 'phone_invalid' }])
  })
  it('非 approved（pending/rejected）全忽略：不进 binds 也不进 invalid', () => {
    const r = planBackfill([
      row({ openId: 'oP', approveStatus: 'pending', phone: '' }),
      row({ openId: 'oR', approveStatus: 'rejected', phone: '13900000000' }),
    ])
    expect(r).toEqual({ binds: [], invalid: [] })
  })
  it('approved + 空 openId → invalid（openid_empty）：external_id 为空没法绑，转人工', () => {
    const r = planBackfill([row({ openId: '', phone: '13812345678' })])
    expect(r.binds).toEqual([])
    expect(r.invalid.map((i) => i.reason)).toEqual(['openid_empty'])
  })
  it('同 (org, openId) 多行同号 → 去重成一个 bind（幂等，不重复写）', () => {
    const r = planBackfill([
      row({ openId: 'oA', phone: '13812345678' }),
      row({ openId: 'oA', phone: '8613812345678' }),   // 归一后同号
    ])
    expect(r.binds).toEqual([{ org: 'o1', openId: 'oA', phone: '13812345678' }])
    expect(r.invalid).toEqual([])
  })
  it('同 (org, openId) 多行异号 → invalid（phone_conflict）：绝不静默 last-write-wins 覆盖', () => {
    const r = planBackfill([
      row({ openId: 'oA', phone: '13812345678' }),
      row({ openId: 'oA', phone: '13900000000' }),
    ])
    expect(r.binds).toEqual([])
    expect(r.invalid.map((i) => i.reason)).toEqual(['phone_conflict'])
  })
  it('binds 按首次出现序；invalid 同序；输出确定性', () => {
    const r = planBackfill([
      row({ openId: 'oB', phone: '' }),
      row({ openId: 'oA', phone: '13812345678' }),
      row({ org: 'o2', openId: 'oX', phone: 'nope' }),
    ])
    expect(r.binds.map((b) => b.openId)).toEqual(['oA'])
    expect(r.invalid.map((i) => i.openId)).toEqual(['oB', 'oX'])
  })
  it('安全口径：invalid 清单里绝不出现完整手机号（binds 持归一全号是写库必需，输出层另行掩码）', () => {
    const r = planBackfill([
      row({ openId: 'oD', phone: '1381234567890' }),   // 无效
      row({ openId: 'oA', phone: '13812345678' }),
      row({ openId: 'oA', phone: '13900000000' }),     // 冲突
    ])
    const s = JSON.stringify(r.invalid)
    expect(s).not.toContain('1381234567890')
    expect(s).not.toContain('13812345678')
    expect(s).not.toContain('13900000000')
  })
})

describe('shouldBackfillWrite（写前裁决：批量回填绝不覆盖人工状态决定）', () => {
  it('无行(null/undefined)/pending → 写（fresh 回填或扶正草稿）', () => {
    expect(shouldBackfillWrite(null)).toBe(true)
    expect(shouldBackfillWrite(undefined)).toBe(true)
    expect(shouldBackfillWrite('pending')).toBe(true)
  })
  it('active/revoked/disputed → 不写——active 是已生效绑定；revoked/disputed 是人工状态决定，回填无权翻案', () => {
    expect(shouldBackfillWrite('active')).toBe(false)
    expect(shouldBackfillWrite('revoked')).toBe(false)
    expect(shouldBackfillWrite('disputed')).toBe(false)
  })
})
