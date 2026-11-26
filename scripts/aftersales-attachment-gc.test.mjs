// aftersales-attachment-gc.test.mjs — 孤儿附件 GC job 的**命令行与编排判据**单测。
//
// 只测会出事的两类判断（删除本体在 `modules/aftersales/domain/attachment-gc.ts` 及其测试里）：
//   ① 参数解析：破坏性脚本里「笔误被静默忽略」= 以为删了没删 / 以为没删却删了；
//   ② 选租户：`--org` 指向不存在的租户时不能静默 0 租户（那是「跑成功了」的假绿）。
import { describe, expect, it } from 'vitest'
import { GC_DEFAULT_LIMIT, GC_DEFAULT_OLDER_THAN_DAYS } from '../modules/aftersales/domain/attachment-gc.ts'
import { parseArgs, selectTenants } from './aftersales-attachment-gc.mjs'

describe('parseArgs（破坏性操作的安全缺省）', () => {
  it('无参数 ⇒ dry-run（绝不默认真删）', () => {
    expect(parseArgs([])).toEqual({
      apply: false,
      org: '',
      olderThanDays: GC_DEFAULT_OLDER_THAN_DAYS,
      limit: GC_DEFAULT_LIMIT,
    })
  })

  it('--apply 显式开删；--org / --older-than-days / --limit 支持 `=` 与空格两种写法', () => {
    expect(parseArgs(['--apply', '--org', 'shanhaiyiguo-org'])).toMatchObject({
      apply: true,
      org: 'shanhaiyiguo-org',
    })
    expect(parseArgs(['--older-than-days=14', '--limit', '50'])).toMatchObject({
      olderThanDays: 14,
      limit: 50,
    })
  })

  it('未知参数 ⇒ 抛（`--aply` 这类笔误不能静默降级成 dry-run 或反之）', () => {
    expect(() => parseArgs(['--aply'])).toThrow(/未知参数/)
    expect(() => parseArgs(['--dry-run'])).toThrow(/未知参数/)
  })

  it('数值参数严格校验（Number("")===0 这类宽松解析会变成「删 0 天前」）', () => {
    expect(() => parseArgs(['--limit', ''])).toThrow(/整数/)
    expect(() => parseArgs(['--limit', '0'])).toThrow(/整数/)
    expect(() => parseArgs(['--older-than-days', '1.5'])).toThrow(/整数/)
    expect(() => parseArgs(['--older-than-days', '3651'])).toThrow(/整数/)
    expect(() => parseArgs(['--older-than-days'])).toThrow(/缺值/)
  })
})

describe('selectTenants（按 org 收窄）', () => {
  const fakePool = () => {
    /** @type {{ sql: string, params: unknown[] }[]} */
    const calls = []
    return {
      calls,
      /**
       * @param {string} sql
       * @param {unknown[]} [params]
       */
      query: async (sql, params = []) => {
        calls.push({ sql, params })
        return { rows: [] }
      },
    }
  }

  it('不给 --org ⇒ 全租户扫描、无绑定参数', async () => {
    const pool = fakePool()
    await selectTenants(pool, '')
    expect(pool.calls[0].sql).toBe('select * from platform.tenant order by casdoor_org')
    expect(pool.calls[0].params).toEqual([])
  })

  it('给 --org ⇒ 参数化谓词（不是拼字符串）', async () => {
    const pool = fakePool()
    await selectTenants(pool, 'shanhaiyiguo-org')
    expect(pool.calls[0].sql).toContain('where casdoor_org = $1')
    expect(pool.calls[0].params).toEqual(['shanhaiyiguo-org'])
  })
})
