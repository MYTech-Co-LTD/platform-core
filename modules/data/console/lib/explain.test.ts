// explain.test.ts — 错误码人话化的行为钉（单页双层的默认层）。
//
// 两条纪律：① 常见码必须给具体人话；② 表外的码**回落**但**原码不许丢**（丢了排障就瞎了）。
import { describe, expect, it } from 'vitest'
import { humanError, TERMS, termEntry } from './explain'

describe('humanError', () => {
  it('常见码 → 具体人话 + 保留原码', () => {
    const h = humanError({ code: 'ID_RESERVED_BY_L1', detail: 'lemeng:retail:net_sales' })
    expect(h.text).toContain('重名')
    expect(h.code).toBe('ID_RESERVED_BY_L1')
    expect(h.detail).toBe('lemeng:retail:net_sales')
  })

  it('候选类错误给的是「下一步做什么」而不是状态机术语', () => {
    expect(humanError({ code: 'CANDIDATE_NOT_ADOPTABLE' }).text).toContain('刷新')
    expect(humanError({ code: 'CANDIDATE_NOT_REJECTABLE' }).text).toContain('刷新')
  })

  it('变更单四码（P0 终审 F2）：说下一步，不说状态机术语', () => {
    expect(humanError({ code: 'CHANGE_STATE_CHANGED' }).text).toContain('刷新')
    expect(humanError({ code: 'PREVIEW_UNAVAILABLE' }).text).toContain('跑试算')
    expect(humanError({ code: 'DECISION_REQUIRES_SESSION' }).text).toContain('登录')
    expect(humanError({ code: 'REASON_REQUIRED' }).text).toContain('驳回')
    // 原码永远保留（回落纪律不变）
    expect(humanError({ code: 'PREVIEW_UNAVAILABLE' }).code).toBe('PREVIEW_UNAVAILABLE')
  })

  it('PREVIEW_RATE_LIMITED（P4 Task 4）：给等待动作，不落通用句', () => {
    const h = humanError({ code: 'PREVIEW_RATE_LIMITED' })
    expect(h.text).toContain('稍等')
    expect(h.text).not.toContain('重试一次') // 通用回落句的指纹：说明命中了具体条目
    expect(h.code).toBe('PREVIEW_RATE_LIMITED')
  })

  it('表外的码 ⇒ 通用句 + 原码仍保留', () => {
    const h = humanError({ code: 'SOME_NEW_CODE' })
    expect(h.text).toContain('重试')
    expect(h.code).toBe('SOME_NEW_CODE')
  })

  it('非 ApiError 形状（Error / 字符串）也能取出码，不抛', () => {
    expect(humanError(new Error('boom')).code).toBe('boom')
    expect(humanError('oops').code).toBe('oops')
    expect(humanError('oops').text).toContain('重试')
  })

  it('空 detail 视为没给（不在文案后留空括号）', () => {
    expect(humanError({ code: 'NOT_FOUND', detail: '' }).detail).toBeUndefined()
  })
})

describe('术语词典（Wave 4.4）', () => {
  it('每个术语都有 label 与一句话解释（空解释 = 界面上出现空提示）', () => {
    for (const [key, entry] of Object.entries(TERMS)) {
      expect(entry.label, key).not.toBe('')
      expect(entry.text.length, key).toBeGreaterThan(10)
    }
  })

  it('未登记的 term ⇒ null（组件据此不渲染问号，而不是渲染空 tooltip）', () => {
    expect(termEntry('no_such_term')).toBeNull()
    expect(termEntry('caliber')?.label).toBe('口径')
  })

  it('解释里不出现「物化/水位/SQL」这类工程词（默认层纪律）', () => {
    for (const [key, entry] of Object.entries(TERMS)) {
      expect(entry.text, key).not.toMatch(/物化|水位|SQL|DBT|dbt/)
    }
  })
})
