import { existsSync, mkdtempSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildContractProposal, buildPipelineProposal, proposeContractChangeImpl, proposePipelineChangeImpl,
} from './propose'
import type { PipelineDeps } from './read'

// 仓根（本测试文件在 modules/data/domain/pipelines/）：零写入断言要对**真实仓目录**做，
// 不能只对比自己给的临时根（临时根里本来就没有真工件，写错了也看不出来）。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const makeRoot = (pipelines: Record<string, unknown>, contracts: Record<string, unknown>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pl-propose-'))
  mkdirSync(join(root, 'pipelines'), { recursive: true })
  for (const [id, doc] of Object.entries(pipelines)) {
    writeFileSync(join(root, 'pipelines', `${id}.json`), JSON.stringify(doc))
  }
  mkdirSync(join(root, 'contracts', 'common'), { recursive: true })
  for (const [id, doc] of Object.entries(contracts)) {
    writeFileSync(join(root, 'contracts', 'common', `${id}.json`), JSON.stringify(doc))
  }
  return root
}

const contractA = {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  batch: { markerColumn: 'b', type: 'varchar', unique: false },
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
}
const basePipeline = { name: 'lemeng.a.b', nodes: [], edges: [] }

const root = makeRoot(
  { 'lemeng.a.b': basePipeline, 'lemeng.a.c': { ...basePipeline, name: 'lemeng.a.c' } },
  { 'lemeng.a': contractA },
)
// 管线面**部分可读**（有文件被跳过）：只有一个坏文件名，目录本身读得到。
const partialRoot = makeRoot({ 'lemeng.a.b': basePipeline, 'bad!': basePipeline }, { 'lemeng.a': contractA })
// 新契约已有按命名约定指向它的管线（前缀命中但尚未解析到任何契约）。
const prefixRoot = makeRoot({ 'lemeng.a_c.tick': { ...basePipeline, name: 'lemeng.a_c.tick' } }, { 'lemeng.a': contractA })
const nopeDeps: PipelineDeps = { roots: { pipelinesRoot: '/nope', contractsRoot: '/nope' }, runs: null, env: {} }
afterAll(() => {
  for (const r of [root, partialRoot, prefixRoot]) rmSync(r, { recursive: true, force: true })
})

const depsOf = (pipelinesRoot: string, contractsRoot: string): PipelineDeps =>
  ({ roots: { pipelinesRoot, contractsRoot }, runs: null, env: {} })
const deps: PipelineDeps = depsOf(root, join(root, 'contracts'))

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

const repoTree = (): string[] => [
  ...readdirSync(join(REPO_ROOT, 'contracts'), { recursive: true }).map((p) => `contracts/${String(p)}`),
  ...readdirSync(join(REPO_ROOT, 'deploy/duckle/console/pipelines'), { recursive: true })
    .map((p) => `deploy/duckle/console/pipelines/${String(p)}`),
].sort()

describe('buildPipelineProposal', () => {
  it('两件套路径正确、内容可回读、slug 化分支名（契约落 contracts/common/）', () => {
    const p = buildPipelineProposal(deps, { pipeline, contract, title: '新增 A_C 采集: v1!', rationale: '因为要' })
    expect(p.branch).toBe('proposal/a-c-v1')
    expect(p.pieces.map((x) => x.path)).toEqual([
      'deploy/duckle/console/pipelines/lemeng.a.c.json',
      'contracts/common/lemeng.a_c.json',
    ])
    expect(JSON.parse(p.pieces[0].content).name).toBe('lemeng.a.c')
    expect(JSON.parse(p.pieces[1].content).table).toBe('a_c')
    expect(p.validation).toEqual([])
  })
  it('管线名非法 ⇒ validation 有 issue（path 是草案内 JSON 路径 name）', () => {
    const p = buildPipelineProposal(deps, { pipeline: { name: '../x', nodes: [], edges: [] }, title: 't', rationale: 'r' })
    expect(p.validation.length).toBeGreaterThan(0)
    expect(p.validation.some((i) => i.path === 'name')).toBe(true)
  })
  it('未提供契约 ⇒ 点名缺契约（required）并沿用既有契约的真实 path；dbt staging 仍是 required', () => {
    const p = buildPipelineProposal(deps, { pipeline, title: 't', rationale: 'r' })
    expect(p.pieces.map((x) => x.path)).toEqual(['deploy/duckle/console/pipelines/lemeng.a.c.json'])
    const contractItem = p.downstream.find((d) => d.why.includes('契约'))
    expect(contractItem).toMatchObject({ path: 'contracts/common/lemeng.a.json', kind: 'required' })
    expect(p.downstream.map((d) => d.path).join()).toContain('dbt/models/')
  })
  it('★ C1：基线里已有同 id 契约 ⇒ 用它的真实 path，不合成 contracts/<domain>/ 路径', () => {
    const existingDraft = { ...contract, table: 'a' } // id = lemeng.a，基线里真实存在
    const p = buildPipelineProposal(deps, { pipeline, contract: existingDraft, title: 't', rationale: 'r' })
    expect(p.pieces[1].path).toBe('contracts/common/lemeng.a.json')
    expect(p.downstream.some((d) => d.path === 'contracts/common/lemeng.a.json' && d.kind === 'required')).toBe(true)
    expect(p.downstream.every((d) => !d.path.includes('contracts/customers/'))).toBe(true)
  })
  it('★ M1：契约面读不全时，即便带了契约草案也要显式报 unknown（不能对基线沉默）', () => {
    const p = buildPipelineProposal(nopeDeps, { pipeline, contract, title: 't', rationale: 'r' })
    expect(p.downstream.some((d) => d.kind === 'unknown' && d.why.includes('契约面读不全'))).toBe(true)
  })
  it('契约面读不全 + 未提供契约 ⇒ 不断言「新表必须先有契约」（那是拿未知当没有）', () => {
    const p = buildPipelineProposal(nopeDeps, { pipeline, title: 't', rationale: 'r' })
    expect(p.downstream.some((d) => d.kind === 'unknown')).toBe(true)
    expect(p.downstream.every((d) => !d.why.includes('新表必须先有契约'))).toBe(true)
  })
  it('★ 零写入：临时根与真实仓目录树调用前后完全不变；产出路径不落成仓内既有文件', () => {
    const before = readdirSync(root, { recursive: true }).sort()
    const repoBefore = repoTree()
    const p = buildPipelineProposal(deps, { pipeline, contract, title: 't', rationale: 'r' })
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before)
    expect(repoTree()).toEqual(repoBefore)
    const filePaths = [
      ...p.pieces.map((x) => x.path),
      ...p.downstream.filter((d) => d.kind === 'required' || d.kind === 'affected').map((d) => d.path),
    ]
    for (const fp of filePaths) {
      expect(fp).not.toContain('contracts/customers/')
      expect(existsSync(join(REPO_ROOT, fp))).toBe(false)
    }
  })
})

describe('buildContractProposal', () => {
  it('★ C1：已存在契约 ⇒ pieces 用它真实的 path；受影响管线逐条 affected（反查命中）', () => {
    const p = buildContractProposal(deps, { contract: { ...contract, table: 'a' }, title: '改 A', rationale: 'r' })
    expect(p.pieces[0].path).toBe('contracts/common/lemeng.a.json')
    const affected = p.downstream.filter((d) => d.kind === 'affected')
    expect(affected.map((d) => d.path)).toEqual([
      'deploy/duckle/console/pipelines/lemeng.a.b.json',
      'deploy/duckle/console/pipelines/lemeng.a.c.json',
    ])
    expect(affected.every((d) => d.why.includes('其当前契约即 lemeng.a'))).toBe(true)
    expect(p.downstream.some((d) => d.kind === 'candidate')).toBe(false)
  })
  it('新契约 ⇒ 落 contracts/common/；同域管线聚合成**一条** candidate（不是 affected，也不逐条）', () => {
    const p = buildContractProposal(deps, { contract, title: '改 A', rationale: 'r' })
    expect(p.pieces[0].path).toBe('contracts/common/lemeng.a_c.json')
    const candidates = p.downstream.filter((d) => d.kind === 'candidate')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].why).toContain('lemeng.a.b')
    expect(candidates[0].why).toContain('lemeng.a.c')
    expect(candidates[0].why).toContain('2 条管线')
    expect(candidates[0].path.endsWith('.json')).toBe(false)
    expect(p.downstream.some((d) => d.kind === 'affected')).toBe(false)
  })
  it('命名前缀命中（新契约已有同名管线）⇒ affected，理由说明实际命中依据', () => {
    const p = buildContractProposal(depsOf(prefixRoot, join(prefixRoot, 'contracts')), { contract, title: 't', rationale: 'r' })
    const affected = p.downstream.filter((d) => d.kind === 'affected')
    expect(affected.map((d) => d.path)).toEqual([
      'deploy/duckle/console/pipelines/lemeng.a_c.tick.json',
    ])
    expect(affected[0].why).toContain('以契约 id 为前缀')
  })
  it('非法契约 ⇒ validation 非空', () => {
    expect(buildContractProposal(deps, { contract: { ...contract, contractVersion: 1 }, title: 't', rationale: 'r' })
      .validation.length).toBeGreaterThan(0)
  })
  it('★ I2：管线面读不全（有坏件被跳过）⇒ 显式 unknown，且不据此断言「没有受影响管线」', () => {
    const p = buildContractProposal(depsOf(partialRoot, join(partialRoot, 'contracts')), { contract, title: 't', rationale: 'r' })
    expect(p.downstream.some((d) => d.kind === 'unknown' && d.why.includes('管线面读不全'))).toBe(true)
    expect(p.downstream.every((d) => !d.why.includes('未找到引用该契约的管线'))).toBe(true)
    // 正命中仍是事实：同域候选照样列出来（部分列表不影响已读到的项）。
    expect(p.downstream.some((d) => d.kind === 'candidate' && d.why.includes('lemeng.a.b'))).toBe(true)
  })
  it('管线目录不可读 ⇒ unknown（未知 ≠ 没有受影响管线）', () => {
    const p = buildContractProposal(nopeDeps, { contract, title: 't', rationale: 'r' })
    expect(p.downstream.some((d) => d.kind === 'unknown' && d.why.includes('管线目录不可读'))).toBe(true)
    expect(p.downstream.some((d) => d.kind === 'affected' || d.kind === 'candidate')).toBe(false)
  })
})

describe('impl', () => {
  const okContract = { contract, title: 't', rationale: 'r' }
  it('合法草案 ⇒ ok，回包里声明不落盘；rationale 与 title 都截断', async () => {
    const out = await proposeContractChangeImpl(deps, okContract)
    expect(out.payload).toMatchObject({ status: 'ok', branch: 'proposal/t' })
    expect(String(out.payload.note)).toContain('不落盘')
    const long = await proposeContractChangeImpl(deps, { contract, title: 't', rationale: 'x'.repeat(2000) })
    expect(String(long.payload.rationale).length).toBe(500)
  })
  it('标题去空白后参与 slug；纯空白标题 ⇒ denied/bad_param（不落 proposal/change）', async () => {
    const out = await proposeContractChangeImpl(deps, { contract, title: '  A b  ', rationale: 'r' })
    expect(out.payload).toMatchObject({ status: 'ok', title: 'A b', branch: 'proposal/a-b' })
    const blank = await proposePipelineChangeImpl(deps, { pipeline, title: '   ', rationale: 'r' })
    expect(blank.isError).toBe(true)
    expect(blank.payload).toMatchObject({ status: 'denied', reason: 'bad_param' })
  })
  it('非法草案 ⇒ refused/invalid_draft（管线与契约同口径）', async () => {
    const badContract = await proposeContractChangeImpl(deps, { contract: {}, title: 't', rationale: 'r' })
    expect(badContract.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
    const badPipeline = await proposePipelineChangeImpl(deps, {
      pipeline: { name: '../x', nodes: [], edges: [] }, title: 't', rationale: 'r',
    })
    expect(badPipeline.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
})
