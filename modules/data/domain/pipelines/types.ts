// types.ts —— 提案面领域层的共享类型。
// 单独成文件只为破 read.ts ↔ runs.ts 的类型循环：read 的 PipelineDeps 要 PipelineRunSource，
// runs 的实现标注要 PipelineImpl。两边各自 import type 本文件，再对外转出，下游路径不变。
import type { ToolImplResult } from '../toolbox/registry'
import type { PipelineRoots } from './defs'
import type { ProposalApplier } from './proposal-apply'
import type { SandboxRunner } from './sandbox-runner'

export interface PipelineRunRecord {
  runId: string
  pipelineId: string
  startedAt: string
  /** 引擎真实词汇的归一：`error → failed`；`cancelled` / `interrupted` 原样；未知值 → `unknown`（rawStatus 留原值）。 */
  status: 'ok' | 'failed' | 'running' | 'cancelled' | 'interrupted' | 'unknown'
  rawStatus?: string
  endedAt?: string
  rows?: number
  error?: string
  durationMs?: number
  trigger?: string
  /** 来源账套名：同一 pipeline_id 可在多个 workspace 各有一份记录，不能混成一条。 */
  source?: string
}

/** 读不到的一个来源（workspace 名 + 原因摘要）。非空 ⇒ 结果的**缺席不可证**。 */
export interface RunSourceIssue { workspace: string; detail: string }

export interface RunListQuery { pipelineId?: string; limit: number }

export interface RunListResult {
  runs: PipelineRunRecord[]
  /** 结果被 limit 截断，或任一被扫描管线已达保留上限（更早的记录看不到）。 */
  truncated: boolean
  unreadable: RunSourceIssue[]
  warnings: string[]
  /** 参与排序/筛选的记录总数（截断前）。 */
  scanned: number
}

export interface RunGetResult {
  run: PipelineRunRecord | null
  /** 缺席是否可证；false ⇒ 调用方只能回 unknown，不许回 not_found。 */
  absenceProven: boolean
  /** 命中的原始收据（有则带出，供排障看逐节点结果）。 */
  receipt?: Record<string, unknown>
  unreadable: RunSourceIssue[]
  warnings: string[]
  scanned: number
}

/**
 * 运行记录来源。**对象而非函数**：`get` 直读收据，避免被 `list` 的「最近 N 条」窗口误判；
 * 两个方法都返回结构化信号（截断 / 不可读 / 缺席可证），因为「未知 ≠ 没有」要靠它们落地。
 */
export interface PipelineRunSource {
  list(q: RunListQuery): Promise<RunListResult>
  get(runId: string): Promise<RunGetResult>
}

export interface PipelineDeps {
  roots: PipelineRoots
  runs: PipelineRunSource | null
  env: Record<string, string | undefined>
  /** 沙箱执行面；`null` = 未接（`run_pipeline_sandbox` 只做校验，不执行）。 */
  sandbox: SandboxRunner | null
  /** 提案应用通路（#1003）；`null`/缺省 = PAT 未配 ⇒ apply 工具回 not_executed。 */
  apply?: ProposalApplier | null
}

export type PipelineImpl = (deps: PipelineDeps, args: Record<string, unknown>) => Promise<ToolImplResult>
