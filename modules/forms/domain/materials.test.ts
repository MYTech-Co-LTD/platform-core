import { describe, expect, it } from 'vitest'
import { MATERIALS_MARKDOWN } from './materials'
import { SUPPORTED_WIDGETS } from './contract'

// 物料清单 ↔ 控件白名单一致性（#724）：清单是「AI 的选型面」，白名单是「渲染层真实能力」。
// 两者漂移的后果很隐蔽——教 AI 用一个渲染不出的控件 ⇒ RJSF 静默回落 ⇒ 字段长得不对但没人报错。
// 本测试把「清单里提到的每个 ui:widget 都在白名单内」变成机检，改清单忘改白名单时当场红。
describe('物料清单与控件白名单一致', () => {
  it('清单里出现的每个 ui:widget 值都 ∈ SUPPORTED_WIDGETS', () => {
    const mentioned = new Set<string>()
    for (const m of MATERIALS_MARKDOWN.matchAll(/"ui:widget"\s*:\s*"([a-z-]+)"/g)) mentioned.add(m[1])
    // 表格里那种裸写的 `ui:widget: radio` 形态也收
    for (const m of MATERIALS_MARKDOWN.matchAll(/ui:widget[:：]\s*`?([a-z-]+)`?/g)) mentioned.add(m[1])
    expect(mentioned.size).toBeGreaterThan(0)
    const outside = [...mentioned].filter((w) => !SUPPORTED_WIDGETS.has(w))
    expect(outside, `清单教了白名单外的控件：${outside.join(',')}`).toEqual([])
  })

  it('未实现的两个控件不在白名单；清单提到它们时**只**在禁止语境（警告模型别用）', () => {
    expect(SUPPORTED_WIDGETS.has('cascader')).toBe(false)
    expect(SUPPORTED_WIDGETS.has('signature')).toBe(false)
    for (const w of ['cascader', 'signature']) {
      const lines = MATERIALS_MARKDOWN.split('\n').filter((l) => l.includes(w))
      expect(lines.length, `${w} 竟未被提及（应显式警告禁用）`).toBeGreaterThan(0)
      for (const l of lines) expect(l, `${w} 出现在非禁止语境：${l}`).toMatch(/不许|禁止|不认识/)
    }
  })

  it('清单明确点名禁止的控件（file/richtext）不在白名单里', () => {
    for (const w of ['file', 'richtext']) expect(SUPPORTED_WIDGETS.has(w), w).toBe(false)
  })
})
