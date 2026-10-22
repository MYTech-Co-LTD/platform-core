import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getPipelineImpl, listPipelinesImpl } from './read'
import type { PipelineDeps } from './read'

const root = mkdtempSync(join(tmpdir(), 'pl-read-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const put = (rel: string, body: unknown): void => {
  const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(body))
}
put('pipelines/lemeng.a.b.json', {
  name: 'lemeng.a.b', version: 2,
  nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a/all.parquet' } } },
  ],
  edges: [{ id: 'e1', source: 's1', target: 'k1' }],
})
put('schedules/3120.json', [{ pipeline_id: 'lemeng.a.b', pipelineId: 'x', enabled: true, kind: { type: 'cron', expr: '*/5 * * * *' }, timezone: 'Asia/Shanghai' }])
put('contracts/common/lemeng.a.json', {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
})
const deps: PipelineDeps = {
  roots: { pipelinesRoot: root, contractsRoot: join(root, 'contracts') },
  runs: null, env: {},
}

// 独立坏件树：一份好管线 + 一份 JSON 坏件（warnings 必须点名，坏 id 必须缺席）。
const brokenRoot = join(root, 'broken-root')
mkdirSync(join(brokenRoot, 'pipelines'), { recursive: true })
writeFileSync(join(brokenRoot, 'pipelines/lemeng.a.b.json'), JSON.stringify({
  name: 'lemeng.a.b', version: 1,
  nodes: [{ id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } }],
  edges: [],
}))
writeFileSync(join(brokenRoot, 'pipelines/torn.json'), '{ not json')
const brokenDeps: PipelineDeps = {
  roots: { pipelinesRoot: brokenRoot, contractsRoot: join(root, 'contracts') },
  runs: null, env: {},
}

// 根目录**不存在**：读不到 ≠ 没有。
const missingDeps: PipelineDeps = {
  roots: { pipelinesRoot: join(root, 'no-such-root'), contractsRoot: join(root, 'contracts') },
  runs: null, env: {},
}

describe('listPipelinesImpl', () => {
  it('回清单：id/name/版本/节点统计/调度/契约', async () => {
    const out = await listPipelinesImpl(deps, {})
    expect(out.isError).toBe(false)
    const p = out.payload as { status: string; count: number; pipelines: Record<string, unknown>[] }
    expect(p.status).toBe('ok')
    expect(p.count).toBe(1)
    expect(p.pipelines[0]).toMatchObject({
      id: 'lemeng.a.b', name: 'lemeng.a.b', version: 2,
      nodes: { source: 1, transform: 0, sink: 1, control: 0 },
      contractId: 'lemeng.a',
    })
    expect((p.pipelines[0].schedules as unknown[]).length).toBe(1)
  })
  it('q 过滤 + source 过滤', async () => {
    const none = await listPipelinesImpl(deps, { q: 'zzz' })
    expect((none.payload as { count: number }).count).toBe(0)
    const bySource = await listPipelinesImpl(deps, { source: '3120' })
    expect((bySource.payload as { count: number }).count).toBe(1)
    const otherSource = await listPipelinesImpl(deps, { source: '64188' })
    expect((otherSource.payload as { count: number }).count).toBe(0)
  })
  it('空串仍是「不过滤」', async () => {
    const out = await listPipelinesImpl(deps, { q: '', source: '' })
    expect((out.payload as { count: number }).count).toBe(1)
  })
  it('非法过滤参数 fail closed（不静默放宽成不过滤）', async () => {
    for (const args of [{ q: 123 }, { q: '   ' }, { source: { a: 1 } }, { source: ' ' }]) {
      const out = await listPipelinesImpl(deps, args)
      expect(out.isError).toBe(true)
      expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_filter' })
    }
  })
  it('pipelines 根不可读 ⇒ unknown（不是空清单）', async () => {
    const out = await listPipelinesImpl(missingDeps, {})
    expect(out.isError).toBe(false)
    const p = out.payload as { status: string; reason: string; warnings: string[] }
    expect(p.status).toBe('unknown')
    expect(p.reason).toBe('pipelines_root_unreadable')
    expect(p.warnings.some((w) => w.includes('pipelines'))).toBe(true)
  })
  it('坏件：warnings 点名，好管线照常返回', async () => {
    const out = await listPipelinesImpl(brokenDeps, {})
    const p = out.payload as { status: string; count: number; pipelines: { id: string }[]; warnings: string[] }
    expect(p.status).toBe('ok')
    expect(p.count).toBe(1)
    expect(p.pipelines[0].id).toBe('lemeng.a.b')
    expect(p.warnings.some((w) => w.includes('torn.json'))).toBe(true)
  })
})

describe('getPipelineImpl', () => {
  it('命中：带 definition / 调度 / 契约 / 校验结论', async () => {
    const out = await getPipelineImpl(deps, { id: 'lemeng.a.b' })
    expect(out.isError).toBe(false)
    const p = out.payload as Record<string, unknown>
    expect(p).toMatchObject({ status: 'ok', id: 'lemeng.a.b', name: 'lemeng.a.b' })
    expect((p.definition as { name: string }).name).toBe('lemeng.a.b')
    expect(p.contract).toMatchObject({ id: 'lemeng.a', columnCount: 1 })
    expect(Array.isArray(p.validation)).toBe(true)
  })
  it('未知名 ⇒ not_found（isError）', async () => {
    const out = await getPipelineImpl(deps, { id: 'nope' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'not_found', id: 'nope' })
  })
  it('坏件 id ⇒ not_found 且带 warnings（与「确实没有」可区分）', async () => {
    const out = await getPipelineImpl(brokenDeps, { id: 'torn' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'not_found', id: 'torn' })
    expect((out.payload as { warnings: string[] }).warnings.some((w) => w.includes('torn.json'))).toBe(true)
  })
  it('pipelines 根不可读 ⇒ unknown（不是 not_found）', async () => {
    const out = await getPipelineImpl(missingDeps, { id: 'lemeng.a.b' })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({ status: 'unknown', reason: 'pipelines_root_unreadable' })
  })
  it('路径穿越形态一律 not_found（不拼路径、不读盘）', async () => {
    for (const id of ['../../etc/passwd', 'a/b', '']) {
      const out = await getPipelineImpl(deps, { id })
      expect(out.payload).toMatchObject({ status: 'not_found' })
    }
  })
  it('非法 id 在 readAll 之前就回 not_found（根不存在也仍是 not_found，不是 unknown）', async () => {
    // 根目录读不到时合法 id 会回 unknown（上一条）；非法 id 若也去读盘就会得到 unknown。
    // 这里拿到 not_found ⇒ 证明 loader 根本没被调用。
    const out = await getPipelineImpl(missingDeps, { id: 'a/b' })
    expect(out.payload).toMatchObject({ status: 'not_found', id: 'a/b' })
    expect(out.isError).toBe(true)
  })
})
