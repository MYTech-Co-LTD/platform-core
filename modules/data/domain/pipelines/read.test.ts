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
put('../contracts/common/lemeng.a.json', {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
})
const deps: PipelineDeps = {
  roots: { pipelinesRoot: root, contractsRoot: join(root, '..', 'contracts') },
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
})

describe('getPipelineImpl', () => {
  it('命中：带 definition / 调度 / 契约 / 校验结论', async () => {
    const out = await getPipelineImpl(deps, { id: 'lemeng.a.b' })
    expect(out.isError).toBe(false)
    const p = out.payload as Record<string, unknown>
    expect(p).toMatchObject({ status: 'ok', id: 'lemeng.a.b', name: 'lemeng.a.b' })
    expect((p.definition as { name: string }).name).toBe('lemeng.a.b')
    expect((p.contract as { id: string }).id).toBe('lemeng.a')
    expect(Array.isArray(p.validation)).toBe(true)
  })
  it('未知名 ⇒ not_found（isError）', async () => {
    const out = await getPipelineImpl(deps, { id: 'nope' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'not_found', id: 'nope' })
  })
  it('路径穿越形态一律 not_found（不拼路径）', async () => {
    for (const id of ['../../etc/passwd', 'a/b', '']) {
      const out = await getPipelineImpl(deps, { id })
      expect(out.payload).toMatchObject({ status: 'not_found' })
    }
  })
})
