// time-semantics.test.ts — 时间语义原语的单测 + **扩散守卫**（2026-11-22）。
//
// 守卫的目的不是抓存量（存量白名单已列），而是**阻止新增**：新写的 dbt 模型 / mjs 脚本
// 必须用单一事实源（`dbt/macros/time_semantics.sql` / `scripts/lib/time-semantics.mjs`），
// 否则裸时区字面量会再长回各文件里——那正是 2026-11-22 修掉四个缺陷的共同根因。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dateLiteral, shanghaiDaysAgo, shanghaiToday, shiftDay, todayIn } from './time-semantics.mjs'

const repoRoot = join(import.meta.dirname, '..', '..')

describe('time-semantics 原语', () => {
  it('shanghaiToday：按上海时区取日期，不受进程 UTC 时钟影响', () => {
    // UTC 2026-11-22T16:30Z = 上海 2026-11-23 00:30 —— 必须是 23 号（不是 22）。
    expect(shanghaiToday(new Date('2026-11-22T16:30:00Z'))).toBe('2026-11-23')
    // UTC 2026-11-22T15:59Z = 上海 2026-11-22 23:59 —— 仍是 22 号。
    expect(shanghaiToday(new Date('2026-11-22T15:59:00Z'))).toBe('2026-11-22')
  })

  it('shiftDay：跨月/跨年/负数都正确（锚上海正午）', () => {
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-11-22', 0)).toBe('2026-11-22')
  })

  it('shanghaiDaysAgo：0/2/3 与 dbt 宏语义一致', () => {
    const now = new Date('2026-11-22T10:00:00Z') // 上海 18:00
    expect(shanghaiDaysAgo(0, now)).toBe('2026-11-22')
    expect(shanghaiDaysAgo(2, now)).toBe('2026-11-20')
    expect(shanghaiDaysAgo(3, now)).toBe('2026-11-19')
  })

  it('dateLiteral：拒绝非法日期（拼进 SQL 的必须是校验过的字面量）', () => {
    expect(dateLiteral('2026-11-22')).toBe("date '2026-11-22'")
    expect(() => dateLiteral("2026-11-22' --")).toThrow(/非法日期/)
    expect(() => dateLiteral('2026-1-2')).toThrow(/非法日期/)
  })

  it('todayIn：任意时区可用（如 UTC 闭窗对账）', () => {
    const t = new Date('2026-11-22T16:30:00Z')
    expect(todayIn('UTC', t)).toBe('2026-11-22')
    expect(todayIn('Asia/Shanghai', t)).toBe('2026-11-23')
  })
})

/** 递归列出目录下指定后缀的文件（跳过 node_modules / target）。 */
function walk(dir: string, ext: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p, ext))
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

/**
 * 存量白名单：**只减不增**。迁移一个就从这里删一项；新增项会让「白名单不得腐化」失败。
 * 误报防护：白名单里的文件如果哪天不再含裸时区，测试会要求你删项——名单不会悄悄腐化。
 */
const DBT_LEGACY = new Set<string>([
  // 既有 marts 的 SQL 内时区运算；迁移到 macros/time_semantics.sql 原语的单独一轮。
  'dbt/models/lemeng/marts/fct_retail_profit.sql',
  'dbt/models/lemeng/marts/fct_retail_item_profit.sql',
])

const SCRIPT_LEGACY = new Set<string>([
  // 工具/运维脚本（非数据面核心路径）：迁移收益低，保留但不再扩增。
  'scripts/oa-p1-smoke.mjs',
  'scripts/apply-eval-set.mjs',
  'scripts/gen-pipeline.mjs',
  // 断言面：SQL 内的 cutoff 运算（13 处）待迁移到 JS 侧字面量；新增的检查（如 ㉑）已走 lib。
  'scripts/lemeng/warehouse-assertions.mjs',
])

describe('扩散守卫：时间语义必须走单一事实源', () => {
  it('dbt/models/**.sql 不得直接写 AT TIME ZONE \'Asia/Shanghai\'（白名单外）', () => {
    const offenders = walk(join(repoRoot, 'dbt', 'models'), '.sql')
      .filter((p) => readFileSync(p, 'utf8').includes("AT TIME ZONE 'Asia/Shanghai'"))
      .map((p) => relative(repoRoot, p).replaceAll('\\', '/'))
      .filter((p) => !DBT_LEGACY.has(p))
    expect(offenders, `改用 {{ shanghai_today() }} / {{ shanghai_days_ago(n) }} / {{ compile_time_date() }}：\n${offenders.join('\n')}`).toEqual([])
  })

  it('scripts/**/*.mjs 不得直接写 Asia/Shanghai（白名单外）', () => {
    const offenders = walk(join(repoRoot, 'scripts'), '.mjs')
      .filter((p) => readFileSync(p, 'utf8').includes('Asia/Shanghai'))
      .map((p) => relative(repoRoot, p).replaceAll('\\', '/'))
      // 原语自身是定义处——它是唯一允许写时区的地方。
      .filter((p) => p !== 'scripts/lib/time-semantics.mjs')
      .filter((p) => !SCRIPT_LEGACY.has(p))
    expect(offenders, `改用 scripts/lib/time-semantics.mjs 的原语：\n${offenders.join('\n')}`).toEqual([])
  })

  it('白名单不得腐化：列进去的文件确实还含裸时区（迁移后必须删项）', () => {
    for (const p of DBT_LEGACY) {
      expect(readFileSync(join(repoRoot, p), 'utf8').includes("AT TIME ZONE 'Asia/Shanghai'"), `${p} 已迁移，请从 DBT_LEGACY 删除`).toBe(true)
    }
    for (const p of SCRIPT_LEGACY) {
      expect(readFileSync(join(repoRoot, p), 'utf8').includes('Asia/Shanghai'), `${p} 已迁移，请从 SCRIPT_LEGACY 删除`).toBe(true)
    }
  })
})
