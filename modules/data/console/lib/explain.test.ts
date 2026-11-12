// explain.test.ts — 错误码人话化的行为钉（单页双层的默认层）。
//
// 两条纪律：① 常见码必须给具体人话；② 表外的码**回落**但**原码不许丢**（丢了排障就瞎了）。
import { describe, expect, it } from 'vitest'
import { humanError } from './explain'

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
