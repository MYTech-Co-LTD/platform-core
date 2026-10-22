#!/usr/bin/env node
// check-guide-sync.mjs — guide↔SKILL 同源门禁（Wave 2 决策 D-G1，ref #985）。
// guide.ts 是三通道同源内容的事实源：A 编译期 import（改动即编译错）、B 内嵌（GUIDE_TEXT_BUILDER）、
// C 消费静态 md（openclaw 容器内无法 import TS）⇒ 只有这里能机检。SKILL.md 漏抄/改写
// GUIDE_INVARIANTS 同源行 ⇒ 本门红。
// 用法：pnpm exec tsx scripts/check-guide-sync.mjs；干净 exit 0，违规 exit 1（stderr 逐行 [GUIDE-SYNC]）。
import { readFileSync } from 'node:fs'
import { GUIDE_INVARIANTS } from '../modules/data/domain/toolbox/guide.ts'

const SKILL_PATH = new URL('../deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md', import.meta.url)
const REQUIRED_TOOL_NAMES = ['describe_metric', 'sample_dimension_values', 'get_freshness']

/**
 * 判据纯函数（单测直接喂桩文本）。
 * @param {readonly string[]} invariants
 * @param {string} skillText
 * @returns {string[]}
 */
export function checkGuideSync(invariants, skillText) {
  const out = []
  for (const line of invariants) {
    if (!skillText.includes(line)) {
      out.push(`[GUIDE-SYNC] SKILL.md 缺同源硬约束行（须与 guide.ts GUIDE_INVARIANTS 逐字一致）：${line}`)
    }
  }
  for (const t of REQUIRED_TOOL_NAMES) {
    if (!skillText.includes(t)) out.push(`[GUIDE-SYNC] SKILL.md 未提及工具 ${t}（Wave 2 三新工具必须入文）`)
  }
  return out
}

// main：真仓判定（argv 守卫——被单测 import 时不触发，check-mcp-toolface.mjs 同款先例）
if (process.argv[1]?.endsWith('check-guide-sync.mjs')) {
  const violations = checkGuideSync(GUIDE_INVARIANTS, readFileSync(SKILL_PATH, 'utf8'))
  if (violations.length > 0) {
    for (const v of violations) console.error(v)
    process.exit(1)
  }
  console.log('check-guide-sync: OK')
}
