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

describe('pipelineId 形状校验（fail closed）', () => {
  it('非字符串 ⇒ denied / bad_param / invalid_pipeline_id，且不透传给 seam', async () => {
    let called = 0
    const deps: PipelineDeps = { roots, env: {}, runs: async () => { called += 1; return [] } }
    const out = await listPipelineRunsImpl(deps, { pipelineId: 3120 })
    expect(out.isError).toBe(true)
    expect(out.auditRowCount).toBeNull()
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_pipeline_id' })
    expect(called).toBe(0)
  })
  it('路径穿越值 ⇒ list 同样 denied，不落到未来的路径拼接', async () => {
    const deps: PipelineDeps = { roots, env: {}, runs: async () => [] }
    const out = await listPipelineRunsImpl(deps, { pipelineId: '../../deploy/duckle/console/schedules/3120' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_pipeline_id' })
  })
  it('空串是 schema 合法值 ⇒ 视为「不过滤」，回 null', async () => {
    let seen: string | undefined = 'sentinel'
    const deps: PipelineDeps = {
      roots, env: {},
      runs: async (q) => { seen = q.pipelineId; return [] },
    }
    const out = await listPipelineRunsImpl(deps, { pipelineId: '' })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({ status: 'ok', pipelineId: null })
    expect(seen).toBeUndefined()
  })
  it('get 不消费 pipelineId（schema 未声明）⇒ 即便传入也忽略并回 null', async () => {
    const deps: PipelineDeps = {
      roots, env: {},
      runs: async () => [
        { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' as const },
      ],
    }
    const got = await getPipelineRunImpl(deps, { runId: 'r1', pipelineId: '../../deploy/duckle/console/schedules/3120' })
    expect(got.isError).toBe(false)
    expect(got.payload).toMatchObject({ status: 'ok', run: { runId: 'r1' }, pipelineId: null })
    const got2 = await getPipelineRunImpl(deps, { runId: 'r1', pipelineId: 'p' })
    expect(got2.payload).toMatchObject({ status: 'ok', pipelineId: null })
  })
})

describe('扫描窗口饱和 ⇒ 缺席不可证', () => {
  const full = Array.from({ length: 50 }, (_, i) => ({
    runId: `r${i}`, pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' as const,
  }))
  it('命中整窗 50 条但无所求 id ⇒ unknown / runs_window_saturated，非错误', async () => {
    const deps: PipelineDeps = { roots, env: {}, runs: async (q) => full.slice(0, q.limit) }
    const out = await getPipelineRunImpl(deps, { runId: 'old-one' })
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBeNull()
    expect(out.payload).toMatchObject({
      status: 'unknown', reason: 'runs_window_saturated', runId: 'old-one', scanned: 50, limit: 50,
    })
  })
  it('窗口未满且无所求 id ⇒ not_found（带 reason），是错误', async () => {
    const deps: PipelineDeps = { roots, env: {}, runs: async (q) => full.slice(0, q.limit - 1) }
    const out = await getPipelineRunImpl(deps, { runId: 'old-one' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'not_found', reason: 'not_found', runId: 'old-one', scanned: 49 })
  })
  it('来源忽略 limit 回 51 条 ⇒ 仍判饱和（>= 而非 ===）', async () => {
    const plusOne = [...full, { runId: 'r50', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' as const }]
    const deps: PipelineDeps = { roots, env: {}, runs: async () => plusOne }
    const out = await getPipelineRunImpl(deps, { runId: 'old-one' })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({
      status: 'unknown', reason: 'runs_window_saturated', scanned: 51, limit: 50,
    })
  })
  it('list ok 回显已生效的 pipelineId 与 scanned', async () => {
    const deps: PipelineDeps = { roots, env: {}, runs: async () => full.slice(0, 2) }
    const filtered = await listPipelineRunsImpl(deps, { pipelineId: 'p' })
    expect(filtered.payload).toMatchObject({ status: 'ok', count: 2, scanned: 2, pipelineId: 'p' })
    const all = await listPipelineRunsImpl(deps, {})
    expect(all.payload).toMatchObject({ status: 'ok', pipelineId: null })
  })
})
