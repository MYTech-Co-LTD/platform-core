// scripts/run-retail-day.test.ts —— 采集 wrapper「容器内调用模式」的护栏。
//
// 为什么要有它：调度改由 duckle 自带调度器承担后（openship-platform ADR-0014），console **容器内**
// 会以 `LEMENG_IN_CONTAINER=1` 调 `run-retail-day.sh`；那时 `$COMPOSE` 被换成 shim `lemeng_compose_shim`，
// 而脚本里 **11 处调用点一行不改**。shim 一旦认错旗标，那 11 处会**一起静默少参数** ——
// 正是本仓反复吃过的「静默错数据」形态，所以必须钉住。
//
// 两档：
//  ① 行为 —— 跑 `scripts/lemeng/run-retail-day.test.sh`（从脚本里抽真函数来测，不复制实现）。
//  ② 静态不变量 —— **所有 `$COMPOSE` 用法都必须是 shim 支持的形态**（`run --rm …`）。
//     这一档防的是「将来有人新增一处 shim 不认识的用法」——行为测试覆盖不到它。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const wrapper = join(repoRoot, 'scripts/lemeng/run-retail-day.sh')
const shellTest = join(repoRoot, 'scripts/lemeng/run-retail-day.test.sh')

describe('run-retail-day：容器内调用模式', () => {
  it('shim 的行为测试全绿（真函数、不复制实现）', () => {
    const out = execFileSync('sh', [shellTest], { encoding: 'utf8' })
    expect(out).toContain('compose-shim: OK')
  })

  it('静态不变量：每一处 $COMPOSE 都是 `run --rm` 形态（shim 只支持这一种）', () => {
    const src = readFileSync(wrapper, 'utf8')
    const lines = src.split('\n')
    const offenders: string[] = []
    let checked = 0
    lines.forEach((line, i) => {
      // 只看真正执行的行：排除注释、以及 COMPOSE 的定义/覆写那一行
      const code = line.trim()
      if (code.startsWith('#')) return
      if (!/\$COMPOSE/.test(code)) return
      if (/^COMPOSE=/.test(code)) return
      checked += 1
      if (!/\$COMPOSE\s+run\s+--rm/.test(code)) offenders.push(`${i + 1}: ${code}`)
    })
    // 基数断言：防「正则写错 ⇒ 一个都没检查 ⇒ 空集合通过」这种假绿
    expect(checked).toBeGreaterThanOrEqual(10)
    expect(offenders).toEqual([])
  })
})
