import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditFileOf, loadRunResults, parseRunResults, reconcileFaceFor, reconcileFaceOf,
  reconcileStatusOf, resetRunResultsCache, runResultsPathOf, testNameOfUniqueId,
} from './reconcile'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'reconcile-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  resetRunResultsCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const runResults = (results: Array<{ unique_id: string; status: string }>, generatedAt = '2026-11-11T03:00:00Z'): unknown => ({
  metadata: { generated_at: generatedAt, invocation_id: 'inv-1' },
  results,
})

describe('auditFileOf（映射不另造）', () => {
  it('与门禁同一个映射：`:` → `__`', () => {
    expect(auditFileOf('lemeng:retail:net_sales')).toBe('audit_lemeng__retail__net_sales.sql')
  })
})

describe('testNameOfUniqueId', () => {
  it('取 test.<pkg>.<name>.<hash> 里的 name', () => {
    expect(testNameOfUniqueId('test.lemeng.audit_lemeng__retail__net_sales.9f2c1a')).toBe('audit_lemeng__retail__net_sales')
  })
  it('非测试节点 / 形状不符 ⇒ null', () => {
    expect(testNameOfUniqueId('model.lemeng.fct_retail_sale')).toBeNull()
    expect(testNameOfUniqueId('test.lemeng.short')).toBeNull()
  })
})

describe('reconcileStatusOf（没跑 ≠ 通过）', () => {
  it('pass 才是 ok', () => expect(reconcileStatusOf('pass')).toBe('ok'))
  it('fail / error / warn 都是 failed', () => {
    for (const s of ['fail', 'error', 'warn']) expect(reconcileStatusOf(s)).toBe('failed')
  })
  it('skipped / 未出现 ⇒ unknown', () => {
    expect(reconcileStatusOf('skipped')).toBe('unknown')
    expect(reconcileStatusOf(undefined)).toBe('unknown')
  })
})

describe('parseRunResults', () => {
  it('只收测试节点，并带上运行时刻', () => {
    const idx = parseRunResults(runResults([
      { unique_id: 'test.lemeng.audit_lemeng__retail__net_sales.aa', status: 'pass' },
      { unique_id: 'model.lemeng.fct_retail_sale', status: 'success' },
    ]))
    expect(idx?.generatedAt).toBe('2026-11-11T03:00:00Z')
    expect(idx?.statusByName.get('audit_lemeng__retail__net_sales')).toBe('pass')
    expect(idx?.statusByName.has('fct_retail_sale')).toBe(false)
  })
  it('形状不符 / 非对象 ⇒ null（不抛）', () => {
    expect(parseRunResults(null)).toBeNull()
    expect(parseRunResults({ results: 'nope' })).toBeNull()
  })
})

describe('reconcileFaceOf', () => {
  it('有结果 ⇒ 照实报状态与时刻', () => {
    const idx = parseRunResults(runResults([
      { unique_id: 'test.lemeng.audit_lemeng__retail__net_sales.aa', status: 'fail' },
    ]))
    expect(reconcileFaceOf('lemeng:retail:net_sales', idx)).toEqual({
      auditFile: 'audit_lemeng__retail__net_sales.sql',
      status: 'failed',
      executedAt: '2026-11-11T03:00:00Z',
    })
  })
  it('索引缺席 ⇒ 文件名已知但状态 unknown（不冒充通过）', () => {
    expect(reconcileFaceOf('lemeng:retail:net_sales', null)).toEqual({
      auditFile: 'audit_lemeng__retail__net_sales.sql',
      status: 'unknown',
      executedAt: null,
    })
  })
})

describe('runResultsPathOf', () => {
  it('显式 env 优先', () => {
    expect(runResultsPathOf({ DATA_DBT_RUN_RESULTS_PATH: '/x/run.json', DATA_DBT_MANIFEST_PATH: '/y/manifest.json' }))
      .toBe('/x/run.json')
  })
  it('否则与 manifest 同目录', () => {
    expect(runResultsPathOf({ DATA_DBT_MANIFEST_PATH: '/app/dbt-target/manifest.json' }))
      .toBe('/app/dbt-target/run_results.json')
  })
  it('两者都没有 ⇒ null', () => {
    expect(runResultsPathOf({})).toBeNull()
  })
})

describe('loadRunResults / reconcileFaceFor（真实文件）', () => {
  it('读文件；文件变了（mtime/size）缓存失效', () => {
    const d = tmp()
    const p = join(d, 'run_results.json')
    writeFileSync(p, JSON.stringify(runResults([
      { unique_id: 'test.lemeng.audit_a.aa', status: 'pass' },
    ])))
    expect(loadRunResults(p)?.statusByName.get('audit_a')).toBe('pass')
    // 同一文件重读走缓存（内容不变）
    expect(loadRunResults(p)?.statusByName.get('audit_a')).toBe('pass')
    writeFileSync(p, JSON.stringify(runResults([
      { unique_id: 'test.lemeng.audit_a.aa', status: 'pass' },
      { unique_id: 'test.lemeng.audit_b.bb', status: 'fail' },
    ], '2026-11-11T04:00:00Z')))
    utimesSync(p, new Date(), new Date('2026-11-11T04:00:00Z'))
    const idx = loadRunResults(p)
    expect(idx?.statusByName.get('audit_b')).toBe('fail')
    expect(idx?.generatedAt).toBe('2026-11-11T04:00:00Z')
  })

  it('路径不存在 / JSON 坏 ⇒ null（fail-open）', () => {
    expect(loadRunResults(join(tmp(), 'nope.json'))).toBeNull()
    const d = tmp()
    const p = join(d, 'bad.json')
    writeFileSync(p, '{ not json')
    expect(loadRunResults(p)).toBeNull()
  })

  it('端到端：env 指到临时目录 ⇒ 对账面取到真值', () => {
    const d = tmp()
    const manifest = join(d, 'manifest.json')
    writeFileSync(manifest, '{}')
    writeFileSync(join(d, 'run_results.json'), JSON.stringify(runResults([
      { unique_id: 'test.lemeng.audit_m.a1', status: 'pass' },
    ])))
    expect(reconcileFaceFor('m', { DATA_DBT_MANIFEST_PATH: manifest })).toEqual({
      auditFile: 'audit_m.sql', status: 'ok', executedAt: '2026-11-11T03:00:00Z',
    })
  })
})
