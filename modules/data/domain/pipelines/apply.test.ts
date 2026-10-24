// apply.test.ts —— apply_pipeline_proposal 的闸与映射：白名单、重校验、seam、outcome→payload。
import { describe, expect, it } from 'vitest'
import { verdictOf } from '../../routes/mcp-pipeline-tools'
import { applyPipelineProposalImpl } from './apply'
import { createProposalApplier, type ProposalApplyOutcome } from './proposal-apply'
import type { PipelineDeps } from './types'

// 契约 piece 必须真的过得了 validateContractDraft（owner/layout/batch/非空 columns），
// 否则闸在重校验就拒了，seam 与 outcome 映射根本测不到（fixture 对齐 validate.test.ts 的 goodContract）。
const goodPiece = {
  path: 'contracts/common/x.y.json',
  content: '{"contractVersion":2,"id":"x.y","domain":"x","table":"y","owner":"data-platform","source":{"system":"s","layer":"raw"},"grain":[],"layout":{"prefix":"x/y","partitionStyle":"hive","partitionBy":["bizday"],"fileName":"all.parquet"},"batch":{"markerColumn":"batch_id","type":"varchar","unique":false},"columns":[{"name":"batch_id","type":"varchar","nullable":false}]}\n',
}

const proposal = {
  status: 'ok', title: '加字段', rationale: '需要新列', branch: 'proposal/jia-zi-duan',
  pieces: [goodPiece], downstream: [], validation: [],
}

const depsWith = (apply: PipelineDeps['apply']): PipelineDeps =>
  ({ roots: { pipelinesRoot: '/nope', contractsRoot: '/nope' }, runs: null, env: {}, sandbox: null, apply })

/** 假 applier：回放 outcome 或断言「不该被调到」。 */
const applierOf = (outcome: ProposalApplyOutcome) => {
  let calls = 0
  const applier = { apply: async () => { calls += 1; return outcome } }
  return { applier: applier as unknown as PipelineDeps['apply'], calls: () => calls }
}

describe('apply_pipeline_proposal', () => {
  it('PAT 未配（apply 缺省）⇒ not_executed/proposal_apply_unconfigured，零网络', async () => {
    const out = await applyPipelineProposalImpl(depsWith(undefined), { proposal })
    expect(out.payload).toMatchObject({ status: 'not_executed', reason: 'proposal_apply_unconfigured' })
    expect(out.isError).toBe(false)
    expect(verdictOf(out.payload as Record<string, unknown>, out.isError)).toEqual({ verdict: 'ok', reason: 'proposal_apply_unconfigured' })
  })

  it('路径白名单：非允许前缀 / 含 .. / 非 .json ⇒ refused/invalid_draft，applier 零调用', async () => {
    for (const bad of ['.github/workflows/x.yml', 'contracts/../secrets.json', 'contracts/common/x.json ', 'contracts/common/x.txt']) {
      const { applier, calls } = applierOf({ kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] })
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [{ path: bad.trim(), content: '{}\n' }] } })
      expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      expect(calls()).toBe(0)
    }
  })

  it('内容重校验：管线草案删 position ⇒ refused/invalid_draft，零网络', async () => {
    const badPipelinePiece = { path: 'deploy/duckle/console/pipelines/lemeng.a.b.json', content: '{"name":"lemeng.a.b","nodes":[{"id":"s1","type":"source","data":{"label":"s"}}],"edges":[]}\n' }
    const { applier, calls } = applierOf({ kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] })
    const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [badPipelinePiece] } })
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
    expect(calls()).toBe(0)
  })

  it('outcome 映射：conflict ⇒ refused/proposal_conflict + 摘要；rejected ⇒ denied；unknown ⇒ unknown；nothing ⇒ ok', async () => {
    const cases: { outcome: ProposalApplyOutcome; payload: Record<string, unknown> }[] = [
      { outcome: { kind: 'conflict', path: goodPiece.path, currentSha256: 'abcdef0123456789' }, payload: { status: 'refused', reason: 'proposal_conflict', path: goodPiece.path, currentSha256: 'abcdef0123456789' } },
      { outcome: { kind: 'github_rejected', detail: 'HTTP 403' }, payload: { status: 'denied', reason: 'proposal_apply_rejected', detail: 'HTTP 403' } },
      { outcome: { kind: 'unknown', detail: 'HTTP 502', branch: 'proposal/x-abc123' }, payload: { status: 'unknown', reason: 'proposal_apply_unknown', detail: 'HTTP 502', branch: 'proposal/x-abc123' } },
      { outcome: { kind: 'nothing_to_apply', skipped: [goodPiece.path] }, payload: { status: 'ok', reason: 'nothing_to_apply' } },
      { outcome: { kind: 'applied', branch: 'proposal/x', prUrl: 'http://u/1', prNumber: 1, commitCount: 1, skipped: [] }, payload: { status: 'ok', prUrl: 'http://u/1', prNumber: 1, branch: 'proposal/x', commitCount: 1 } },
    ]
    for (const c of cases) {
      const { applier } = applierOf(c.outcome)
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal })
      expect(out.payload).toMatchObject(c.payload)
    }
  })
})
