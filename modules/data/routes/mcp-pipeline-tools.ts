// mcp-pipeline-tools.ts —— 管理面 MCP 端点的**管线提案片**（Wave 3 / spec §7 的 8 个工具）。
//
// 门禁由宿主按 manifest 的 `POST /mcp-manage → data:manage` 施加——**本文件不写 requireScope**
// （与 mcp-metric-tools.ts 同规：声明即授权）。空身份守卫与读面/口径片同形（M3）。
//
// 三条不变式（本文件是它们的唯一落点）：
//   ① **写总闸**：mutating 工具在 DATA_MCP_ALLOW_MUTATING !== 'true' 时一律 mutating_disabled；
//   ② **审计单点**：所有结局（ok/denied/error）都写 data.query_audit（tool = 工具名）；
//   ③ **不认领返回 null**：mcp-manage.ts 的合成方据此继续问下一片。
import { writeAudit } from '../domain/audit-store'
import { mutatingAllowed } from '../domain/toolbox/registry'
import { PIPELINE_TOOLS, pipelineToolMeta } from '../domain/pipelines/tools'
import { rootsOf } from '../domain/pipelines/defs'
import type { PipelineRoots } from '../domain/pipelines/defs'
import { getPipelineImpl, listPipelinesImpl } from '../domain/pipelines/read'
import type { PipelineDeps, PipelineImpl } from '../domain/pipelines/read'
import { getPipelineRunImpl, listPipelineRunsImpl } from '../domain/pipelines/runs'
import type { PipelineRunSource } from '../domain/pipelines/runs'
import { runSourceFromEnv } from '../domain/pipelines/run-source'
import { applyPipelineProposalImpl } from '../domain/pipelines/apply'
import { proposalApplierFromEnv } from '../domain/pipelines/proposal-apply'
import type { ProposalApplier } from '../domain/pipelines/proposal-apply'
import { proposeContractChangeImpl, proposePipelineChangeImpl } from '../domain/pipelines/propose'
import { runPipelineSandboxImpl } from '../domain/pipelines/sandbox'
import { sandboxRunnerFromEnv } from '../domain/pipelines/sandbox-runner'
import type { SandboxRunner } from '../domain/pipelines/sandbox-runner'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

export interface PipelineWiring {
  roots: PipelineRoots
  env: Record<string, string | undefined>
  runs: PipelineRunSource | null
  sandbox: SandboxRunner | null
  apply: ProposalApplier | null
}

/**
 * 缺省装配：仓内路径（`rootsOf` 按模块位置解析 ⇒ 镜像内 /app，与 pnpm 脚本 cwd=apps/server 无关）
 * + process.env + 运行记录来源 + 沙箱执行面。
 *
 * 运行记录来源**按 env 决定**：`DATA_RUN_DIRS` 未配置 ⇒ `null`（seam：`runs_source_not_wired`
 * 语义不变）；配置了 ⇒ 只读文件源（部署期把 console 的 `runs/` 以 `:ro` 挂进来）。
 *
 * 沙箱执行面同理：`DATA_SANDBOX_URL` 未配 ⇒ `null`（`run_pipeline_sandbox` 只做校验、不执行）。
 * 配了但连不上 ⇒ 工具回 `unknown / sandbox_unreachable`，**不**静默退回「只校验」——
 * 那会让人以为试跑过了（§2.8 的失败语义表）。
 *
 * 提案应用通路同样按 env 决定：`DATA_MCP_GITHUB_TOKEN` 未配 ⇒ `null`
 * （`apply_pipeline_proposal` 过完白名单与重校验后回 `not_executed`——不配不生效）。
 */
export function defaultPipelineWiring(env: Record<string, string | undefined> = process.env): PipelineWiring {
  return {
    roots: rootsOf(env), env,
    runs: runSourceFromEnv(env), sandbox: sandboxRunnerFromEnv(env),
    apply: proposalApplierFromEnv(env),
  }
}

const IMPLS: Record<string, PipelineImpl> = {
  list_pipelines: listPipelinesImpl,
  get_pipeline: getPipelineImpl,
  list_pipeline_runs: listPipelineRunsImpl,
  get_pipeline_run: getPipelineRunImpl,
  run_pipeline_sandbox: runPipelineSandboxImpl,
  propose_pipeline_change: proposePipelineChangeImpl,
  propose_contract_change: proposeContractChangeImpl,
  apply_pipeline_proposal: applyPipelineProposalImpl,
}

// **装载期**一致性（Task 8 M10）：`PIPELINE_TOOLS` 与 `IMPLS` 是两份手写表，漏登记只会在
// **被调用时**才暴露成 impl_missing —— 一个已经对客户端宣称存在的工具，调用却报错。
// 这里在模块装载时就判死：新增工具必须两处同改（任何 import 本模块的测试即成为回归网）。
// 用 throw 而不是降级成 warning：两张表同出一个 PR，不一致就是坏构建；早失败好过每次调用失败。
for (const t of PIPELINE_TOOLS) {
  if (typeof IMPLS[t.name] !== 'function') {
    throw new Error(`pipeline tools: 「${t.name}」在 PIPELINE_TOOLS 里但没有实现（IMPLS 漏登记）`)
  }
}

const entryOf = (t: (typeof PIPELINE_TOOLS)[number]): Record<string, unknown> => ({
  name: t.name, title: t.title, description: t.description,
  inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations,
})

/**
 * 审计判决的**唯一**映射（纯函数，可脱库单测）。
 *
 * 按 `status` 分类，而不是按 `isError`：
 *   · `denied` / `refused` 都是「判了拒」——后者是草案没过校验、工具**明确拒绝产出**，
 *     不是「查了个空」；记成 ok 会让安全复核看不出「有人在反复提非法草案」；
 *   · `not_found`（问的客体不存在）与 `unknown`（读不到）都不是拒绝；
 *   · `not_executed`（沙箱闸「校验过了但没跑」）既不是拒、也不等于跑过 ⇒ ok + reason 透传；
 *   · **没有 status 却 isError**（impl 抛出的未知形状）⇒ denied + `tool_error`。
 * reason：透传 payload.reason（含 ok 行）→ status 非 ok 时回落 status → 无 status 的 denied
 * 回落 'tool_error' → 其余 ''（写库时转 null）。
 */
export function verdictOf(
  payload: Record<string, unknown>, isError: boolean,
): { verdict: 'ok' | 'denied' | 'error'; reason: string } {
  const status = typeof payload.status === 'string' ? payload.status : null
  const verdict: 'ok' | 'denied' | 'error' =
    status === 'error' ? 'error'
      : status === 'denied' || status === 'refused' ? 'denied'
        : status === null ? (isError ? 'denied' : 'ok')
          : 'ok'
  const reason = typeof payload.reason === 'string' ? payload.reason
    : status !== null && status !== 'ok' ? status
      : verdict === 'denied' ? 'tool_error'
        : ''
  return { verdict, reason }
}

export function makePipelineTools(wiring: PipelineWiring = defaultPipelineWiring()): McpToolGroup {
  const depsOf = (d: McpDeps): PipelineDeps => ({ roots: wiring.roots, env: wiring.env, runs: wiring.runs, sandbox: wiring.sandbox, apply: wiring.apply })

  /** 单点审计：工具名恒写；metricId 恒 ''（管线工具不是指标工具）。 */
  const audit = async (
    d: McpDeps, name: string, args: Record<string, unknown>,
    verdict: 'ok' | 'denied' | 'error', reason: string, rowCount: number | null,
  ): Promise<void> => {
    await writeAudit(d.pool, {
      org: d.org, userId: d.requester?.userId ?? '(anonymous)',
      channel: d.requester?.channel ?? 'session', keyId: d.requester?.keyId ?? null,
      metricId: '', params: args, rowCount, verdict,
      reason: reason === '' ? null : reason, masking: null, tool: name,
    })
  }

  const reply = async (
    d: McpDeps, name: string, args: Record<string, unknown>,
    payload: Record<string, unknown>, isError: boolean, rowCount: number | null,
  ): Promise<McpToolResult> => {
    // 判决映射见 `verdictOf`（按 status 分类，unknown/not_found ≠ denied）；reason 的三种空由它统一。
    // ⚠️ 本函数**不得**被 call() 的 try 包住：审计写不进去必须向上抛（协议壳不兜 ⇒ 500），
    //    而不是被当成 impl 异常再写一条 `error/tool_exception` 的假错行。
    const { verdict, reason } = verdictOf(payload, isError)
    await audit(d, name, args, verdict, reason, rowCount)
    return {
      text: JSON.stringify(payload), isError,
      ...(isError ? {} : { structured: payload }),
    }
  }

  return {
    async list(d: McpDeps) {
      if (d.requester === null) return []
      return PIPELINE_TOOLS.map(entryOf)
    },

    async call(d: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
      const meta = pipelineToolMeta(name)
      if (meta === undefined) return null
      if (d.requester === null) {
        return reply(d, name, args, { status: 'denied', reason: 'unauthenticated' }, true, null)
      }
      if (meta.mutating && !mutatingAllowed(wiring.env)) {
        return reply(d, name, args, { status: 'denied', reason: 'mutating_disabled', name }, true, null)
      }
      // 「清单里有、分派表漏登记」⇒ 精确错误，而不是 TypeError 文本（工具清单与 IMPLS 是两份表）。
      const impl = IMPLS[name]
      if (impl === undefined) {
        return reply(d, name, args, { status: 'error', reason: 'impl_missing', name }, true, null)
      }
      // 只包 impl：审计（reply）必须在 try **之外**——否则审计连接抖动会被 catch 成
      // 「impl 异常」，再写一条 error/tool_exception 的假错行，把一次成功的调用记成失败。
      let out: Awaited<ReturnType<PipelineImpl>>
      try {
        out = await impl(depsOf(d), args)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return reply(d, name, args, { status: 'error', reason: 'tool_exception', detail }, true, null)
      }
      return reply(d, name, args, out.payload, out.isError, out.auditRowCount ?? null)
    },
  }
}

/** 给 mcp-manage.ts 的现成实例（缺省装配）。 */
export const pipelineTools: McpToolGroup = makePipelineTools()
