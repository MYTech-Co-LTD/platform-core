import { describe, expect, it } from 'vitest'
import { getPipelineRunImpl, listPipelineRunsImpl } from './runs'
import type { PipelineDeps } from './types'

const roots = { pipelinesRoot: '/nope', contractsRoot: '/nope' }
const noSeam: PipelineDeps = { roots, runs: null, env: {} }

describe('运行记录（seam 未接通）', () => {
  it('list_pipeline_runs ⇒ 显式 unknown + 原因 + 说明；不是空数组', async () => {
    const out = await listPipelineRunsImpl(noSeam, {})
    expect(out.isError).toBe(false)
    const p = out.payload as Record<string, unknown>
    expect(p.status).toBe('unknown')
    expect(p.reason).toBe('runs_source_not_wired')
    expect(String(p.note)).toContain('console')
    expect('runs' in p).toBe(false)
    expect(out.auditRowCount).toBeNull()
  })
  it('get_pipeline_run ⇒ 同样 unknown', async () => {
    const out = await getPipelineRunImpl(noSeam, { runId: 'run-1' })
    expect(out.payload).toMatchObject({ status: 'unknown', reason: 'runs_source_not_wired' })
  })
})

describe('运行记录（seam 接通后转真）', () => {
  const rows = [
    { runId: 'r2', pipelineId: 'p', startedAt: '2026-10-22T01:00:00Z', status: 'failed' as const, error: 'boom' },
    { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-21T01:00:00Z', status: 'ok' as const, rows: 12 },
  ]
  const deps: PipelineDeps = {
    roots, env: {},
    runs: async (q) => rows.filter((r) => q.pipelineId === undefined || r.pipelineId === q.pipelineId).slice(0, q.limit),
  }
  it('list：透传过滤与 limit', async () => {
    const out = await listPipelineRunsImpl(deps, { pipelineId: 'p', limit: 1 })
    expect(out.payload).toMatchObject({ status: 'ok', count: 1 })
    expect((out.payload as { runs: { runId: string }[] }).runs[0].runId).toBe('r2')
  })
  it('get：命中回 run，未命中 not_found', async () => {
    expect((await getPipelineRunImpl(deps, { runId: 'r1' })).payload).toMatchObject({ status: 'ok', run: { runId: 'r1' } })
    expect((await getPipelineRunImpl(deps, { runId: 'zz' })).payload).toMatchObject({ status: 'not_found', runId: 'zz' })
  })
  it('limit 越界/非法 ⇒ 缺省 20，硬顶 50', async () => {
    let seen = 0
    const spy: PipelineDeps = { roots, env: {}, runs: async (q) => { seen = q.limit; return [] } }
    await listPipelineRunsImpl(spy, { limit: 999 })
    expect(seen).toBe(50)
    await listPipelineRunsImpl(spy, { limit: 0 })
    expect(seen).toBe(20)
  })
})
