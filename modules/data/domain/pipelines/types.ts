// types.ts —— 提案面领域层的共享类型。
// 单独成文件只为破 read.ts ↔ runs.ts 的类型循环：read 的 PipelineDeps 要 PipelineRunSource，
// runs 的实现标注要 PipelineImpl。两边各自 import type 本文件，再对外转出，下游路径不变。
import type { ToolImplResult } from '../toolbox/registry'
import type { PipelineRoots } from './defs'

export interface PipelineRunRecord {
  runId: string
  pipelineId: string
  startedAt: string
  status: 'ok' | 'failed' | 'running'
  endedAt?: string
  rows?: number
  error?: string
}

export type PipelineRunSource = (q: { pipelineId?: string; limit: number }) => Promise<PipelineRunRecord[]>

export interface PipelineDeps {
  roots: PipelineRoots
  runs: PipelineRunSource | null
  env: Record<string, string | undefined>
}

export type PipelineImpl = (deps: PipelineDeps, args: Record<string, unknown>) => Promise<ToolImplResult>
