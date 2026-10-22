// scripts/check-guide-sync.test.ts — guide↔SKILL 同源门禁的判据与真仓断言（Wave 2 决策 D-G1）。
// guide.ts 是三通道同源内容的事实源：A 编译期 import（改动即编译错）、B 内嵌、C 消费静态 md
// 无法 import TS ⇒ 只有这里能机检。SKILL.md 漏抄/改写同源行 ⇒ 本门红。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// .mjs 经显式路径 import（scripts 内互相引用的既有手法）；GUIDE_INVARIANTS 经 .ts 后缀（tsx/vitest 均可解析）
import { checkGuideSync } from './check-guide-sync.mjs'
import { GUIDE_INVARIANTS } from '../modules/data/domain/toolbox/guide.ts'

describe('checkGuideSync：判据', () => {
  it('SKILL 含全部不变量行 + 三新工具名 ⇒ 0 条', () => {
    const skill = GUIDE_INVARIANTS.join('\n') + '\ndescribe_metric sample_dimension_values get_freshness'
    expect(checkGuideSync(GUIDE_INVARIANTS, skill)).toEqual([])
  })
  it('缺任一行 ⇒ 逐行点名 [GUIDE-SYNC]；缺工具名 ⇒ 点名', () => {
    const out = checkGuideSync(GUIDE_INVARIANTS, GUIDE_INVARIANTS.slice(1).join('\n'))
    expect(out).toHaveLength(4) // 缺第一行（1）+ 三个工具名全缺（3）
    expect(out[0]).toContain('[GUIDE-SYNC]')
  })
})

describe('真仓：SKILL.md v3 与 GUIDE_INVARIANTS 逐字同源；CI 已接线', () => {
  const skill = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'openclaw', 'data-query-plugin', 'skills', 'data-query', 'SKILL.md'),
    'utf8',
  )
  it('四行硬约束逐字在场；三新工具已入文', () => {
    expect(checkGuideSync(GUIDE_INVARIANTS, skill)).toEqual([])
  })
  it('ci.yml 已接线本门（脚本存在但没接进 CI = 没固化，正典 §4.1 判据）', () => {
    const ci = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('check-guide-sync.mjs')
  })
})
