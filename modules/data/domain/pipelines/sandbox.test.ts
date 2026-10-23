import { describe, expect, it } from 'vitest'
import { verdictOf } from '../../routes/mcp-pipeline-tools'
import { runPipelineSandboxImpl } from './sandbox'
import { SandboxUnreachableError, type SandboxOutcome, type SandboxRunner } from './sandbox-runner'
import type { PipelineDeps } from './types'

const depsWith = (sandbox: SandboxRunner | null): PipelineDeps =>
  ({ roots: { pipelinesRoot: '/nope', contractsRoot: '/nope' }, runs: null, env: {}, sandbox })

const good = {
  name: 'lemeng.sbx', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: '__sandbox/lemeng/sbx/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}

/** 假 runner：记录拿到的 runId，回放给定结果（或抛）。 */
const runnerOf = (outcome: SandboxOutcome | Error) => {
  const calls: { draft: unknown; runId: string }[] = []
  const runner: SandboxRunner = {
    run: async (draft, runId) => {
      calls.push({ draft, runId })
      if (outcome instanceof Error) throw outcome
      return { ...outcome, runId }
    },
  }
  return { runner, calls }
}

describe('runPipelineSandboxImpl —— 校验闸（未接执行面）', () => {
  it('合法草案 ⇒ not_executed/sandbox_runner_unconfigured（绝不给 ok）', async () => {
    const out = await runPipelineSandboxImpl(depsWith(null), { pipeline: good })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({
      status: 'not_executed', reason: 'sandbox_runner_unconfigured',
      checked: { structure: true, components: true, sandboxPrefix: true },
    })
    expect(String((out.payload as { note: string }).note)).toContain('没有执行任何管线')
  })
  it('结构非法 ⇒ refused/invalid_draft', async () => {
    const out = await runPipelineSandboxImpl(depsWith(null), { pipeline: { name: '' } })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
  it('写正式湖 ⇒ denied/sandbox_prefix_violation', async () => {
    const bad = { ...good, nodes: [good.nodes[0], { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/sbx/all.parquet' } } }] }
    const out = await runPipelineSandboxImpl(depsWith(null), { pipeline: bad })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'sandbox_prefix_violation' })
  })
  it('webhook 出口 ⇒ 同样被拒', async () => {
    const bad = { ...good, nodes: [good.nodes[0], { id: 'k1', type: 'sink', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }] }
    expect((await runPipelineSandboxImpl(depsWith(null), { pipeline: bad })).payload).toMatchObject({ status: 'denied' })
  })
})

describe('runPipelineSandboxImpl —— 组件策略先于执行', () => {
  // 草案看着完全合法（有 source、有落在 __sandbox/ 的 sink）——不跑组件策略就真会执行。
  const withNodes = (componentId: string) => ({
    ...good,
    nodes: [
      { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
      { id: 'x1', type: 'transform', data: { componentId, properties: {} } },
      good.nodes[1],
    ],
    edges: [{ source: 's1', target: 'x1' }, { source: 'x1', target: 'k1' }],
  })
  it('code.shell ⇒ denied/component_not_allowed，且**没有**调用执行面', async () => {
    const { runner, calls } = runnerOf({ status: 'ok', runId: '', file: '' })
    const out = await runPipelineSandboxImpl(depsWith(runner), { pipeline: withNodes('code.shell') })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'component_not_allowed' })
    expect(calls).toHaveLength(0)
  })
  it('ctl.foreach ⇒ denied/component_not_allowed', async () => {
    const { runner, calls } = runnerOf({ status: 'ok', runId: '', file: '' })
    const out = await runPipelineSandboxImpl(depsWith(runner), { pipeline: withNodes('ctl.foreach') })
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'component_not_allowed' })
    expect(calls).toHaveLength(0)
  })
})

describe('runPipelineSandboxImpl —— 真执行（接了执行面）', () => {
  it('ok ⇒ status ok + runId/durationMs/rows/nodes，审计行数取 rows', async () => {
    const { runner, calls } = runnerOf({ status: 'ok', runId: '', file: 'sandbox/x.json', durationMs: 88, rows: 12, nodes: { sink: { rows: 12 } } })
    const out = await runPipelineSandboxImpl(depsWith(runner), { pipeline: good })
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBe(12)
    expect(out.payload).toMatchObject({ status: 'ok', file: 'sandbox/x.json', durationMs: 88, rows: 12, nodes: { sink: { rows: 12 } } })
    // runId 由 impl 生成（文件名主干）：安全字符，且回填的是 runner 报的那个
    expect(calls).toHaveLength(1)
    expect(calls[0].runId).toMatch(/^sbx-[a-z0-9]+-[0-9a-f]{8}$/)
    expect((out.payload as { runId: string }).runId).toBe(calls[0].runId)
    expect(verdictOf(out.payload as Record<string, unknown>, out.isError)).toEqual({ verdict: 'ok', reason: '' })
  })
  it('跑失败 ⇒ failed/pipeline_failed + 引擎错误；isError 但仍记 ok（关于草案的结论）', async () => {
    const { runner } = runnerOf({ status: 'failed', runId: '', file: 'sandbox/x.json', error: 'Data contract violated: in_range(exit_code)' })
    const out = await runPipelineSandboxImpl(depsWith(runner), { pipeline: good })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'failed', reason: 'pipeline_failed', error: 'Data contract violated: in_range(exit_code)' })
    expect(verdictOf(out.payload as Record<string, unknown>, out.isError)).toEqual({ verdict: 'ok', reason: 'pipeline_failed' })
  })
  it('超时仍 running ⇒ running + runId，不判失败', async () => {
    const { runner } = runnerOf({ status: 'running', runId: '', file: 'sandbox/x.json' })
    const out = await runPipelineSandboxImpl(depsWith(runner), { pipeline: good })
    expect(out.isError).toBe(false)
    expect(out.payload).toMatchObject({ status: 'running', file: 'sandbox/x.json' })
    expect(String((out.payload as { note: string }).note)).toContain('不要据此判失败')
  })
  it('执行面不可达 ⇒ unknown/sandbox_unreachable（「不知道跑没跑」≠ denied）', async () => {
    const { runner } = runnerOf(new SandboxUnreachableError('/api/runs → HTTP 401'))
    const out = await runPipelineSandboxImpl(depsWith(runner), { pipeline: good })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'unknown', reason: 'sandbox_unreachable', detail: '/api/runs → HTTP 401' })
    expect(verdictOf(out.payload as Record<string, unknown>, out.isError)).toEqual({ verdict: 'ok', reason: 'sandbox_unreachable' })
  })
  it('非执行面异常照旧向上抛（协议壳记 tool_exception）', async () => {
    const { runner } = runnerOf(new TypeError('bug'))
    await expect(runPipelineSandboxImpl(depsWith(runner), { pipeline: good })).rejects.toThrow('bug')
  })
  it('单飞：上一次没结束时第二次 ⇒ denied/sandbox_busy；结束后恢复', async () => {
    let release!: (o: SandboxOutcome) => void
    const gate = new Promise<SandboxOutcome>((r) => { release = r })
    const runner: SandboxRunner = { run: async (_d, runId) => ({ ...(await gate), runId }) }

    const first = runPipelineSandboxImpl(depsWith(runner), { pipeline: good })
    // 让 first 进到 await runner.run
    await Promise.resolve()
    const second = await runPipelineSandboxImpl(depsWith(runner), { pipeline: good })
    expect(second.isError).toBe(true)
    expect(second.payload).toMatchObject({ status: 'denied', reason: 'sandbox_busy' })
    expect(verdictOf(second.payload as Record<string, unknown>, second.isError)).toEqual({ verdict: 'denied', reason: 'sandbox_busy' })

    release({ status: 'ok', runId: '', file: 'sandbox/x.json' })
    expect((await first).payload).toMatchObject({ status: 'ok' })
    // finally 释放了锁：下一次照跑
    release({ status: 'ok', runId: '', file: 'sandbox/x.json' })
    expect((await runPipelineSandboxImpl(depsWith(runner), { pipeline: good })).payload).toMatchObject({ status: 'ok' })
  })
})
