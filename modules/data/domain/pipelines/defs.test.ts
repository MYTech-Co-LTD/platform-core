import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { contractFor, loadContracts, loadPipelines, loadSchedules, rootsOf } from './defs'

const root = mkdtempSync(join(tmpdir(), 'pl-defs-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function seed(rel: string, body: unknown): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
seed('deploy/duckle/console/pipelines/lemeng.a.b.json', {
  name: 'lemeng.a.b', version: 1,
  nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 't1', type: 'transform', data: { componentId: 'tr.sql', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a/system_book=1/all.parquet' } } },
    { id: 'k2', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/a.csv' } } },
  ],
  edges: [],
})
seed('deploy/duckle/console/pipelines/broken.json', '{ not json')
seed('deploy/duckle/console/schedules/3120.json', [
  { id: 'panel-1', pipeline_id: 'lemeng.a.b', name: 'lemeng.a.b', enabled: true, kind: { type: 'cron', expr: '*/5 * * * *' }, timezone: 'Asia/Shanghai' },
  { id: 'panel-2', pipeline_id: 'gone.away', name: 'gone.away', enabled: false, kind: { type: 'interval', seconds: 60 } },
])
seed('contracts/common/lemeng.a.json', {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
})
seed('contracts/common/_schema.schema.json', { title: 'infra' })

const roots = rootsOf({}, root)

describe('rootsOf', () => {
  it('缺省落在 cwd 下的仓内路径；env 可覆盖', () => {
    expect(rootsOf({}, '/repo')).toEqual({ pipelinesRoot: '/repo/deploy/duckle/console', contractsRoot: '/repo/contracts' })
    expect(rootsOf({ DATA_PIPELINES_ROOT: '/p', DATA_CONTRACTS_ROOT: '/c' }, '/repo')).toEqual({ pipelinesRoot: '/p', contractsRoot: '/c' })
  })
})

describe('loadPipelines', () => {
  it('按文件名取 id、统计节点类型、收集湖写入 key；坏 JSON 进 warnings 不抛', () => {
    const { defs, warnings, readable } = loadPipelines(roots)
    expect([...defs.keys()]).toEqual(['lemeng.a.b'])
    const d = defs.get('lemeng.a.b')!
    expect(d.name).toBe('lemeng.a.b')
    expect(d.counts).toEqual({ source: 1, transform: 1, sink: 2, control: 0 })
    expect(d.lakeKeys).toEqual(['lemeng/a/system_book=1/all.parquet'])
    expect(warnings.some((w) => w.includes('broken.json'))).toBe(true)
    expect(readable).toBe(true)
  })
  it('目录不存在 ⇒ 空 + warning + readable=false（不抛）', () => {
    expect(loadPipelines(rootsOf({}, '/definitely/not/here'))).toEqual({ defs: new Map(), warnings: [expect.stringContaining('pipelines')], readable: false })
  })
})

describe('loadSchedules', () => {
  it('按 pipeline_id 归并，cron 抽平，interval 型 cron=null', () => {
    const { byPipeline } = loadSchedules(roots)
    expect(byPipeline.get('lemeng.a.b')).toEqual([
      { source: '3120', pipelineId: 'lemeng.a.b', enabled: true, cron: '*/5 * * * *', timezone: 'Asia/Shanghai' },
    ])
    expect(byPipeline.get('gone.away')?.[0]).toMatchObject({ enabled: false, cron: null, timezone: null })
  })
})

describe('loadContracts / contractFor', () => {
  it('跳过 _ 前缀基础设施文件', () => {
    const { contracts } = loadContracts(roots)
    expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
    expect(contracts[0]).toMatchObject({ domain: 'lemeng', table: 'a', columns: 1 })
  })
  it('contractFor：最长 domain.table 前缀命中；无命中回 null', () => {
    const { contracts } = loadContracts(roots)
    expect(contractFor('lemeng.a.tick', contracts)?.id).toBe('lemeng.a')
    expect(contractFor('lemeng.zzz', contracts)).toBeNull()
  })
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    '领域目录不可读 ⇒ 进 warnings，其余领域照常返回',
    () => {
      const locked = join(root, 'contracts/locked')
      seed('contracts/locked/x.json', { domain: 'locked', table: 'x', columns: [] })
      chmodSync(locked, 0o000)
      try {
        const { contracts, warnings } = loadContracts(roots)
        expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
        expect(warnings.some((w) => w.includes('locked'))).toBe(true)
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )
})
