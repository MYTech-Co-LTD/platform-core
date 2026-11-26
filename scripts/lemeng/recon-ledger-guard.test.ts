// scripts/lemeng/recon-ledger-guard.test.ts — 台账自愈闸（#2894）的**判据同源**守卫。
//
// 这里只测不需要数据库的东西：
//   ① 判据与断言 ⑪ `checkReconLedgerCover` **同源**（目标日 T-4、期望集=近 7 天）——
//      两边各写一套判据是这类「兜底 + 自愈」组合最常见的静默漂移（改了一处，另一处还红/还绿）；
//   ② `missingLedgerRows` 只把 SQL 结果原样交出去，不在这里二次解释（解释 = 第二份判据）。
//
// ⚠️ 两边的**形态**不同、**语义**必须相同：断言侧 SQL 内现算 `now()`（历史形态，在
// `scripts/lib/time-semantics.test.ts` 的白名单里）；本闸侧用 `dateLiteral(shanghaiDaysAgo(n))`
// 在 JS 侧算好（扩散守卫不许裸写 `Asia/Shanghai`）。所以这里钉的是**两个常量 4 / 7**。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingLedgerRows } from './recon-ledger-guard.mjs'
import { shanghaiDaysAgo } from '../lib/time-semantics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = readFileSync(join(HERE, 'recon-ledger-guard.mjs'), 'utf8')
const ASSERTIONS = readFileSync(join(HERE, 'warehouse-assertions.mjs'), 'utf8')

describe('recon-ledger-guard · 与断言 ⑪ 同源', () => {
  it('断言侧：目标日 = 今天 −4，期望集 = 近 7 天', () => {
    expect(ASSERTIONS).toContain("(now() at time zone 'Asia/Shanghai')::date - 4")
    expect(ASSERTIONS).toContain('where bizday > (select d from t) - 7')
  })

  it('闸侧：同一个 4 与 7（> T-11 即近 7 天），且不裸写时区', () => {
    expect(GUARD).toContain('shanghaiDaysAgo(4, now)') // T-4
    expect(GUARD).toContain('shanghaiDaysAgo(11, now)') // (T-4) − 7
    expect(GUARD).not.toContain('Asia/Shanghai') // 扩散守卫（time-semantics.test.ts）同款红线
  })
})

describe('recon-ledger-guard · missingLedgerRows', () => {
  const NOW = new Date('2026-11-26T14:00:00Z') // 11-26 22:00 CST ⇒ T-4 = 11-22

  it('SQL 里是算好的字面量：目标日 T-4、下界 T-11', async () => {
    let seen = ''
    const pool = { query: async (sql: string) => { seen = sql; return { rows: [] } } }
    await missingLedgerRows(pool, NOW)
    expect(seen).toContain(`r.bizday = date '${shanghaiDaysAgo(4, NOW)}'`)
    expect(seen).toContain(`bizday > date '${shanghaiDaysAgo(11, NOW)}'`)
    // 只读：不写、不改 status —— 这条是「只读闸」的机检
    expect(seen).not.toMatch(/\b(insert|update|delete|truncate)\b/i)
    expect(seen).toContain('where r.status is null')
  })

  it('把 (账套, control) 原样交出，不做二次判定', async () => {
    const rows = [{ system_book: '3120', control: 'caliber_net' }]
    const pool = { query: async () => ({ rows }) }
    await expect(missingLedgerRows(pool, NOW)).resolves.toEqual(rows)
  })
})
