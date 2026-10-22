import { mkdtempSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildContractProposal, buildPipelineProposal } from './propose'
import type { PipelineDeps } from './read'

const root = mkdtempSync(join(tmpdir(), 'pl-propose-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'pipelines'), { recursive: true })
writeFileSync(join(root, 'pipelines', 'lemeng.a.b.json'), JSON.stringify({ name: 'lemeng.a.b', nodes: [], edges: [] }))
mkdirSync(join(root, 'contracts', 'lemeng'), { recursive: true })
writeFileSync(join(root, 'contracts', 'lemeng', 'lemeng.a.json'), JSON.stringify({
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  batch: { markerColumn: 'b', type: 'varchar', unique: false },
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
}))
const deps: PipelineDeps = { roots: { pipelinesRoot: root, contractsRoot: join(root, 'contracts') }, runs: null, env: {} }

const pipeline = {
  name: 'lemeng.a.c', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a_c/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}
const contract = {
  contractVersion: 2, domain: 'lemeng', table: 'a_c', owner: 'data-platform',
  layout: { prefix: 'lemeng/a_c', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
  batch: { markerColumn: 'batch_id', type: 'varchar', unique: false },
  columns: [{ name: 'batch_id', type: 'varchar', nullable: false }],
}

describe('buildPipelineProposal', () => {
  it('两件套路径正确、内容可回读、slug 化分支名', () => {
    const p = buildPipelineProposal(deps, { pipeline, contract, title: '新增 A_C 采集: v1!', rationale: '因为要' })
    expect(p.branch).toBe('proposal/a-c-v1')
    expect(p.pieces.map((x) => x.path)).toEqual([
      'deploy/duckle/console/pipelines/lemeng.a.c.json',
      'contracts/lemeng/lemeng.a_c.json',
    ])
    expect(JSON.parse(p.pieces[0].content).name).toBe('lemeng.a.c')
    expect(JSON.parse(p.pieces[1].content).table).toBe('a_c')
    expect(p.validation).toEqual([])
  })
  it('管线名非法 ⇒ validation 有 issue（路由片据此拒）', () => {
    const p = buildPipelineProposal(deps, { pipeline: { name: '../x', nodes: [], edges: [] }, title: 't', rationale: 'r' })
    expect(p.validation.length).toBeGreaterThan(0)
  })
  it('未提供契约 ⇒ downstream 点名缺契约；未提供时下游仍有 dbt staging 项', () => {
    const p = buildPipelineProposal(deps, { pipeline, title: 't', rationale: 'r' })
    expect(p.pieces.map((x) => x.path)).toEqual(['deploy/duckle/console/pipelines/lemeng.a.c.json'])
    expect(p.downstream.map((d) => d.why).join()).toContain('契约')
    expect(p.downstream.map((d) => d.path).join()).toContain('dbt/models/')
  })
  it('★ 零写入：调用前后目录树字节级不变', () => {
    const before = readdirSync(root, { recursive: true }).sort()
    buildPipelineProposal(deps, { pipeline, contract, title: 't', rationale: 'r' })
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before)
  })
})

describe('buildContractProposal', () => {
  it('路径按 domain 落 contracts/<domain>/<domain>.<table>.json；受影响管线反查出来', () => {
    const p = buildContractProposal(deps, { contract, title: '改 A', rationale: 'r' })
    expect(p.pieces[0].path).toBe('contracts/lemeng/lemeng.a_c.json')
    expect(p.downstream.map((d) => d.path).join()).toContain('lemeng.a.b')
  })
  it('非法契约 ⇒ validation 非空', () => {
    expect(buildContractProposal(deps, { contract: { ...contract, contractVersion: 1 }, title: 't', rationale: 'r' })
      .validation.length).toBeGreaterThan(0)
  })
})
