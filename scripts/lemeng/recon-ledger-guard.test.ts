// scripts/lemeng/recon-ledger-guard.test.ts — 台账自愈闸（#2894）的**判据同源**守卫。
//
// 这里只测两件不需要数据库的事：
//   ① 判据 SQL 与断言 ⑪ `checkReconLedgerCover` **同源**（目标日 T-4、期望集=近 7 天）——
//      两边各写一套判据是这类「兜底 + 自愈」组合最常见的静默漂移（改了一处，另一处还红/还绿）；
//   ② `missingLedgerRows` 只把 SQL 结果原样交出去，不在这里二次解释（解释 = 第二份判据）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingLedgerRows } from './recon-ledger-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = readFileSync(join(HERE, 'recon-ledger-guard.mjs'), 'utf8')
const ASSERTIONS = readFileSync(join(HERE, 'warehouse-assertions.mjs'), 'utf8')

/** 判据的三个「钉死值」：改任一处就等于改了判据本身。 */
const PINNED = [
  "(now() at time zone 'Asia/Shanghai')::date - 4", // 目标日 = 今天 −4（固定）
  'bizday > (select d from t) - 7', // 期望集 = 近 7 天出现过的 (账套, control)
  'from recon_run', // 读的是台账本体
]

describe('recon-ledger-guard · 与断言 ⑪ 同源', () => {
  for (const pin of PINNED) {
    it(`两边都钉住：${pin}`, () => {
      expect(GUARD).toContain(pin)
      expect(ASSERTIONS).toContain(pin)
    })
  }
})

describe('recon-ledger-guard · missingLedgerRows', () => {
  it('把 (账套, control) 原样交出，不做二次判定', async () => {
    const rows = [{ system_book: '3120', control: 'caliber_net' }]
    let seen = ''
    const pool = {
      query: async (sql: string) => {
        seen = sql
        return { rows }
      },
    }
    await expect(missingLedgerRows(pool)).resolves.toEqual(rows)
    // 只读：不写、不改 status —— 这条是「只读闸」的机检
    expect(seen).not.toMatch(/\b(insert|update|delete|truncate)\b/i)
    expect(seen).toContain('where r.status is null')
  })
})
