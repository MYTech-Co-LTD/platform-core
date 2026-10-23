import { describe, expect, it } from 'vitest'
import { getPipelineRunImpl, listPipelineRunsImpl } from './runs'
import type {
  PipelineDeps, PipelineRunRecord, PipelineRunSource, RunGetResult, RunListResult,
} from './types'

const roots = { pipelinesRoot: '/nope', contractsRoot: '/nope' }
const noSeam: PipelineDeps = { roots, runs: null, env: {} }

const listRes = (over: Partial<RunListResult> = {}): RunListResult => ({
  runs: [], truncated: false, unreadable: [], warnings: [], scanned: 0, ...over,
})
const getRes = (over: Partial<RunGetResult> = {}): RunGetResult => ({
  run: null, absenceProven: true, unreadable: [], warnings: [], scanned: 0, ...over,
})

/** 只关心 list 的假来源。 */
const listOnly = (r: RunListResult): PipelineDeps => ({
  roots, env: {},
  runs: { list: async () => r, get: async () => getRes() },
})
/** 只关心 get 的假来源。 */
const getOnly = (r: RunGetResult): PipelineDeps => ({
  roots, env: {},
  runs: { list: async () => listRes(), get: async () => r },
})

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
  const rows: PipelineRunRecord[] = [
    { runId: 'r2', pipelineId: 'p', startedAt: '2026-10-22T01:00:00Z', status: 'failed', error: 'boom' },
    { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-21T01:00:00Z', status: 'ok', rows: 12 },
  ]
  const source = (seen: { pipelineId?: string; limit: number }[] = []): PipelineRunSource => ({
    list: async (q) => {
      seen.push(q)
      return listRes({
        runs: rows.slice(0, q.limit), scanned: rows.length,
      })
    },
    get: async (runId) => getRes({
      run: rows.find((r) => r.runId === runId) ?? null,
      absenceProven: true, scanned: rows.length,
    }),
  })
  it('list：透传过滤与 limit，回 truncated/scanned', async () => {
    const seen: { pipelineId?: string; limit: number }[] = []
    const deps: PipelineDeps = { roots, env: {}, runs: source(seen) }
    const out = await listPipelineRunsImpl(deps, { pipelineId: 'p', limit: 1 })
    expect(out.payload).toMatchObject({ status: 'ok', count: 1, truncated: false, scanned: 2 })
    expect((out.payload as { runs: { runId: string }[] }).runs[0].runId).toBe('r2')
    expect(seen[0]).toEqual({ pipelineId: 'p', limit: 1 })
  })
  it('get：命中回 run，未命中且缺席可证 ⇒ not_found', async () => {
    const deps: PipelineDeps = { roots, env: {}, runs: source() }
    expect((await getPipelineRunImpl(deps, { runId: 'r1' })).payload).toMatchObject({ status: 'ok', run: { runId: 'r1' } })
    expect((await getPipelineRunImpl(deps, { runId: 'zz' })).payload).toMatchObject({ status: 'not_found', runId: 'zz' })
  })
  it('get：带收据时把原始收据放进 detail', async () => {
    const deps = getOnly(getRes({
      run: { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' },
      receipt: { runId: 'r1', nodes: { sink: { rows: 3 } } },
    }))
    const out = await getPipelineRunImpl(deps, { runId: 'r1' })
    expect(out.payload).toMatchObject({ status: 'ok', detail: { runId: 'r1' } })
  })
  it('limit 越界/非法 ⇒ 缺省 20，硬顶 50', async () => {
    const seen: number[] = []
    const deps: PipelineDeps = {
      roots, env: {},
      runs: {
        list: async (q) => { seen.push(q.limit); return listRes() },
        get: async () => getRes(),
      },
    }
    await listPipelineRunsImpl(deps, { limit: 999 })
    expect(seen[0]).toBe(50)
    await listPipelineRunsImpl(deps, { limit: 0 })
    expect(seen[1]).toBe(20)
  })
})

describe('pipelineId 形状校验（fail closed）', () => {
  it('非字符串 ⇒ denied / bad_param / invalid_pipeline_id，且不透传给来源', async () => {
    let called = 0
    const deps: PipelineDeps = {
      roots, env: {},
      runs: {
        list: async () => { called += 1; return listRes() },
        get: async () => getRes(),
      },
    }
    const out = await listPipelineRunsImpl(deps, { pipelineId: 3120 })
    expect(out.isError).toBe(true)
    expect(out.auditRowCount).toBeNull()
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_pipeline_id' })
    expect(called).toBe(0)
  })
  it('路径穿越值 ⇒ list 同样 denied，不落到路径拼接', async () => {
    const deps = listOnly(listRes())
    const out = await listPipelineRunsImpl(deps, { pipelineId: '../../deploy/duckle/console/schedules/3120' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_pipeline_id' })
  })
  it('空串是 schema 合法值 ⇒ 视为「不过滤」，回 null', async () => {
    let seen: string | undefined = 'sentinel'
    const deps: PipelineDeps = {
      roots, env: {},
      runs: {
        list: async (q) => { seen = q.pipelineId; return listRes() },
        get: async () => getRes(),
      },
    }
    const out = await listPipelineRunsImpl(deps, { pipelineId: '' })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({ status: 'ok', pipelineId: null })
    expect(seen).toBeUndefined()
  })
  it('get 不消费 pipelineId（schema 未声明）⇒ 即便传入也忽略并回 null', async () => {
    const deps = getOnly(getRes({
      run: { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' },
    }))
    const got = await getPipelineRunImpl(deps, { runId: 'r1', pipelineId: '../../deploy/duckle/console/schedules/3120' })
    expect(got.isError).toBe(false)
    expect(got.payload).toMatchObject({ status: 'ok', run: { runId: 'r1' }, pipelineId: null })
    const got2 = await getPipelineRunImpl(deps, { runId: 'r1', pipelineId: 'p' })
    expect(got2.payload).toMatchObject({ status: 'ok', pipelineId: null })
  })
  it('runId 畸形（穿越/含斜杠/前导点）⇒ denied，且不触来源', async () => {
    let called = 0
    const deps: PipelineDeps = {
      roots, env: {},
      runs: {
        list: async () => listRes(),
        get: async () => { called += 1; return getRes() },
      },
    }
    for (const runId of ['../../etc/passwd', 'a/b', '.hidden']) {
      const out = await getPipelineRunImpl(deps, { runId })
      expect(out.isError, runId).toBe(true)
      expect(out.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_run_id' })
    }
    expect(called).toBe(0)
  })
})

describe('来源不可读 / 部分可读', () => {
  const issue = { workspace: '64188', detail: 'EACCES' }
  it('list：部分来源不可读但读到了记录 ⇒ ok + incomplete 点名', async () => {
    const deps = listOnly(listRes({
      runs: [{ runId: 'r1', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' }],
      scanned: 1, unreadable: [issue],
    }))
    const out = await listPipelineRunsImpl(deps, {})
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({ status: 'ok', count: 1, incomplete: ['64188'], upstream: [issue] })
  })
  it('list：全部不可读且零记录 ⇒ unknown/runs_source_unreadable（不是空清单）', async () => {
    const deps = listOnly(listRes({ unreadable: [issue] }))
    const out = await listPipelineRunsImpl(deps, {})
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({ status: 'unknown', reason: 'runs_source_unreadable', incomplete: ['64188'] })
    expect((out.payload as { upstream: unknown[] }).upstream).toHaveLength(1)
  })
  it('list：truncated 与 warnings 透传', async () => {
    const deps = listOnly(listRes({
      runs: [{ runId: 'r1', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' }],
      scanned: 60, truncated: true, warnings: ['3120/x.json 不可解析'],
    }))
    const out = await listPipelineRunsImpl(deps, {})
    expect(out.payload).toMatchObject({ status: 'ok', truncated: true, warnings: ['3120/x.json 不可解析'] })
  })
  it('get：来源不可读 ⇒ unknown/runs_source_unreadable（优先于饱和）', async () => {
    const deps = getOnly(getRes({ absenceProven: false, unreadable: [issue], scanned: 50 }))
    const out = await getPipelineRunImpl(deps, { runId: 'r1' })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({
      status: 'unknown', reason: 'runs_source_unreadable', incomplete: ['64188'],
    })
  })
})

describe('扫描窗口饱和 ⇒ 缺席不可证', () => {
  it('absenceProven=false ⇒ unknown / runs_window_saturated，非错误', async () => {
    const deps = getOnly(getRes({ absenceProven: false, scanned: 50 }))
    const out = await getPipelineRunImpl(deps, { runId: 'old-one' })
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBeNull()
    expect(out.payload).toMatchObject({
      status: 'unknown', reason: 'runs_window_saturated', runId: 'old-one', scanned: 50, limit: 50,
    })
  })
  it('absenceProven=true ⇒ not_found（带 reason），是错误', async () => {
    const deps = getOnly(getRes({ absenceProven: true, scanned: 49 }))
    const out = await getPipelineRunImpl(deps, { runId: 'old-one' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'not_found', reason: 'not_found', runId: 'old-one', scanned: 49 })
  })
  it('list ok 回显已生效的 pipelineId 与 scanned', async () => {
    const two = [
      { runId: 'r1', pipelineId: 'p', startedAt: '2026-10-22T01:00:00Z', status: 'ok' as const },
      { runId: 'r2', pipelineId: 'p', startedAt: '2026-10-22T00:00:00Z', status: 'ok' as const },
    ]
    const deps = listOnly(listRes({ runs: two, scanned: 2 }))
    const filtered = await listPipelineRunsImpl(deps, { pipelineId: 'p' })
    expect(filtered.payload).toMatchObject({ status: 'ok', count: 2, scanned: 2, pipelineId: 'p' })
    const all = await listPipelineRunsImpl(deps, {})
    expect(all.payload).toMatchObject({ status: 'ok', pipelineId: null })
  })
})
