// scripts/diagnose.test.ts —— 只读诊断工具（scripts/lemeng/diagnose.sh）的护栏。
//
// 两档（与 run-retail-day.test.ts 同形）：
//  ① 行为 —— 跑 `scripts/lemeng/diagnose.test.sh`（从脚本里抽**真函数**来测，不复制实现）。
//  ② 静态不变量 —— 两件行为测试照不到的事：
//     · **`$COMPOSE` 只有 `run --rm` 一种形态**（诊断工具起一次性容器；多一种形态就多一条没人验的路径）；
//     · **`$VAR` 不得紧跟中文/全角字符** —— 本机 `/bin/sh` 是 bash 3.2，会把全角字符吃进变量名
//       ⇒ `unbound variable` 在**最需要出声**的失败路径上反而不出声（本仓实测过两次，本文件落地
//       当天又咬了一次）。中文注释多的脚本必须机器盯着，靠人眼必漏。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const tool = join(repoRoot, 'scripts/lemeng/diagnose.sh')
const shellTest = join(repoRoot, 'scripts/lemeng/diagnose.test.sh')

/** CJK 汉字 / 全角标点 / 全角空格（会被 bash 3.2 当变量名的一部分）。 */
const CJK = /[\u2E80-\u9FFF\uFF00-\uFFEF\u3000-\u303F]/

describe('diagnose：只读诊断工具', () => {
  it('行为测试全绿（真函数、不复制实现）', () => {
    const out = execFileSync('sh', [shellTest], { encoding: 'utf8' })
    expect(out).toContain('diagnose: OK')
  })

  it('静态不变量：每一处 $COMPOSE 都是 `run --rm` 形态（一次性容器，别多开路径）', () => {
    const src = readFileSync(tool, 'utf8')
    const offenders: string[] = []
    let checked = 0
    src.split('\n').forEach((line, i) => {
      const code = line.trim()
      if (code.startsWith('#')) return
      if (!/\$COMPOSE/.test(code)) return
      if (/^COMPOSE=/.test(code)) return
      checked += 1
      if (!/\$COMPOSE\s+run\s+--rm/.test(code)) offenders.push(`${i + 1}: ${code}`)
    })
    // 基数断言：防「正则写错 ⇒ 一个都没检查 ⇒ 空集合通过」这种假绿
    // （本工具只有 `rb_run` 一处起容器——采集形不在其列，所以基数就是 1，别照抄 run-retail-day 的 10）
    expect(checked).toBeGreaterThanOrEqual(1)
    expect(offenders).toEqual([])
  })

  it('静态不变量：裸 $VAR 不得紧跟中文/全角字符（bash 3.2 会把全角吃进变量名）', () => {
    const src = readFileSync(tool, 'utf8')
    const offenders: string[] = []
    src.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('#')) return
      for (const m of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const next = line.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1)
        if (next && CJK.test(next)) offenders.push(`${i + 1}: $${m[1]} 紧跟 ${next}`)
      }
    })
    expect(offenders).toEqual([])
  })
})
