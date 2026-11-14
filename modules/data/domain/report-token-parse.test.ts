// report-token-parse.test.ts — 文本内嵌 token 的语法与写侧绑定（R3 / L2）。
// 纯函数：不碰库、不碰网络。判据是「不合法就拒」——静默吞掉 `{{…}}` 会让读者把占位符当数字。
import { describe, expect, it } from 'vitest'
import { parseTokens, tokenIssue } from './report-token-parse'

describe('token 语法', () => {
  it('三种引用 + 缺省值；文本其余部分原样', () => {
    const r = parseTokens('本期 {{metric:m:sales}}，对比 {{delta:m:sales|vs:prev_month}}，截至 {{as_of:m:sales}}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tokens.map((t) => t.kind)).toEqual(['metric', 'delta', 'as_of'])
    expect(r.tokens[0]).toMatchObject({ metricId: 'm:sales' })
    expect(r.tokens[0].window).toBeUndefined()   // 缺省 range
    expect(r.tokens[1]).toMatchObject({ metricId: 'm:sales', vs: 'prev_month' })
  })

  it('window / fmt 解析；无 token 文本合法', () => {
    const r = parseTokens('{{metric:m|window:prev_year|fmt:currency}}')
    expect(r.ok && r.tokens[0]).toMatchObject({ window: 'prev_year', fmt: 'currency' })
    expect(parseTokens('纯文本，没有引用')).toEqual({ ok: true, tokens: [] })
  })

  it('★ 不合法一律拒（未闭合 / 未知类型 / 未知参数 / 空 id / 重复参数）', () => {
    for (const bad of [
      '未闭合 {{metric:m',
      '野生 }} 结尾',
      '{{}}',
      '{{tool:m}}',
      '{{metric:}}',
      '{{metric:m|nope:1}}',
      '{{metric:m|window:last_week}}',
      '{{delta:m|vs:range}}',
      '{{metric:m|fmt:money}}',
      '{{metric:m|fmt:number|fmt:percent}}',
      '{{as_of:m|fmt:number}}',
    ]) {
      expect(parseTokens(bad).ok, bad).toBe(false)
    }
  })

  it('数量上限', () => {
    const many = Array.from({ length: 21 }, () => '{{metric:m}}').join(' ')
    expect(parseTokens(many).ok).toBe(false)
  })
})

describe('写侧绑定（tokenIssue）', () => {
  const ids = new Set(['m:sales', 'm:orders'])

  it('引用报表里已有的指标 ⇒ 通过；无关文本 ⇒ 通过', () => {
    expect(tokenIssue('{{metric:m:sales}}', ids)).toBeNull()
    expect(tokenIssue('纯文本', ids)).toBeNull()
  })

  it('★ 引用报表外的指标 ⇒ 拒（引用即授权面：不许把词表当开放查询入口）', () => {
    expect(tokenIssue('{{metric:m:secret}}', ids)).toBe('引用的指标不在本报表里：m:secret')
  })

  it('语法错误透出具体原因', () => {
    expect(tokenIssue('{{metric:m:sales', ids)).toContain('未闭合')
    expect(tokenIssue('{{metric:m:sales|window:last_week}}', ids)).toContain('window')
  })
})
