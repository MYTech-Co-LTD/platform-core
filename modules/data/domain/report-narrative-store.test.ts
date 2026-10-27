// report-narrative-store.test.ts — AI 文本缓存的惰性 GC（#1105）。
//
// 判据：
//  · `pruneNarratives` 按保留期删除旧行，保留期进参数（不拼 SQL）；
//  · `putNarrative` 写缓存后**最多每 24h** 触发一次 GC（进程级节流）；
//  · GC 失败（表缺/权限/并发）**不反噬**写缓存——生成主路径必须成功。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import {
  NARRATIVE_RETENTION_DAYS,
  pruneNarratives,
  putNarrative,
  resetNarrativePruneClock,
  type NarrativeKey,
} from './report-narrative-store'

const KEY: NarrativeKey = {
  org: 'org-a',
  reportId: 'r1',
  specKey: 'published:6',
  panelIndex: 8,
  focus: 'overview',
  periodKey: '2026-10-01..2026-10-19',
  branchKey: '92',
  factsHash: 'hash-1',
  promptVersion: 'narrative-v3',
  model: 'deepseek-flash',
}

function fakePool(failDelete = false) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('delete from data.report_narratives')) {
        if (failDelete) throw new Error('boom')
        return { rowCount: 5, rows: [] }
      }
      return { rowCount: 1, rows: [] }
    },
  } as unknown as Pool
  return { pool, calls }
}

beforeEach(() => resetNarrativePruneClock())

describe('pruneNarratives', () => {
  it('按保留期删除旧行（保留期走参数）并返回删除行数', async () => {
    const { pool, calls } = fakePool()
    await expect(pruneNarratives(pool, 30)).resolves.toBe(5)
    expect(calls[0]?.sql).toContain('delete from data.report_narratives')
    expect(calls[0]?.params).toEqual([30])
  })
})

describe('putNarrative 的惰性 GC', () => {
  it('写缓存后触发一次；24h 内第二次写不再触发', async () => {
    const { pool, calls } = fakePool()
    await putNarrative(pool, KEY, 'text', false, 'u')
    await putNarrative(pool, KEY, 'text', false, 'u')
    const deletes = calls.filter((c) => c.sql.includes('delete from data.report_narratives'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.params).toEqual([NARRATIVE_RETENTION_DAYS])
  })

  it('GC 失败不反噬写缓存（resolves，不抛）', async () => {
    const { pool } = fakePool(true)
    await expect(putNarrative(pool, KEY, 'text', false, 'u')).resolves.toBeUndefined()
  })
})
