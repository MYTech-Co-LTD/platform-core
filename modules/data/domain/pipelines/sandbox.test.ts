import { describe, expect, it } from 'vitest'
import { runPipelineSandboxImpl } from './sandbox'
import type { PipelineDeps } from './types'

const deps: PipelineDeps = { roots: { pipelinesRoot: '/nope', contractsRoot: '/nope' }, runs: null, env: {} }
const good = {
  name: 'lemeng.sbx', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: '__sandbox/lemeng/sbx/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}

describe('runPipelineSandboxImpl', () => {
  it('合法草案 ⇒ not_executed（校验通过但没跑），绝不给 ok', async () => {
    const out = await runPipelineSandboxImpl(deps, { pipeline: good })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({
      status: 'not_executed', reason: 'sandbox_runner_unavailable',
      checked: { structure: true, sandboxPrefix: true },
    })
    expect(String((out.payload as { note: string }).note)).toContain('待沉淀')
  })
  it('结构非法 ⇒ refused/invalid_draft', async () => {
    const out = await runPipelineSandboxImpl(deps, { pipeline: { name: '' } })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
  it('写正式湖 ⇒ denied/sandbox_prefix_violation（先于 not_executed）', async () => {
    const bad = { ...good, nodes: [good.nodes[0], { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/sbx/all.parquet' } } }] }
    const out = await runPipelineSandboxImpl(deps, { pipeline: bad })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'sandbox_prefix_violation' })
  })
  it('webhook 出口 ⇒ 同样被拒', async () => {
    // 节点 id 仍用 k1：边引用保持有效，结构门才会放行、落到沙箱断言这一支。
    const bad = { ...good, nodes: [good.nodes[0], { id: 'k1', type: 'sink', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }] }
    expect((await runPipelineSandboxImpl(deps, { pipeline: bad })).payload).toMatchObject({ status: 'denied' })
  })
})
