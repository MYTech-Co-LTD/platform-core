// mcp-pipeline-tools.ts —— 管理面 MCP 端点的**管线提案片**（Wave 3 / spec §7 的 7 个工具）。
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
import { proposeContractChangeImpl, proposePipelineChangeImpl } from '../domain/pipelines/propose'
import { runPipelineSandboxImpl } from '../domain/pipelines/sandbox'
import type { McpDeps, McpToolGroup, McpToolResult } from './mcp-rpc'

export interface PipelineWiring {
  roots: PipelineRoots
  env: Record<string, string | undefined>
  runs: PipelineRunSource | null
}

/** 缺省装配：仓内路径（镜像 /app 与本地 cwd 都成立）+ process.env + 运行记录 seam 未接通。 */
export function defaultPipelineWiring(env: Record<string, string | undefined> = process.env): PipelineWiring {
  return { roots: rootsOf(env), env, runs: null }
}

const IMPLS: Record<string, PipelineImpl> = {
  list_pipelines: listPipelinesImpl,
  get_pipeline: getPipelineImpl,
  list_pipeline_runs: listPipelineRunsImpl,
  get_pipeline_run: getPipelineRunImpl,
  run_pipeline_sandbox: runPipelineSandboxImpl,
  propose_pipeline_change: proposePipelineChangeImpl,
  propose_contract_change: proposeContractChangeImpl,
}

const entryOf = (t: (typeof PIPELINE_TOOLS)[number]): Record<string, unknown> => ({
  name: t.name, title: t.title, description: t.description,
  inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations,
})

export function makePipelineTools(wiring: PipelineWiring = defaultPipelineWiring()): McpToolGroup {
  const depsOf = (d: McpDeps): PipelineDeps => ({ roots: wiring.roots, env: wiring.env, runs: wiring.runs })

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
    // 审计三态只有 ok / denied / error。**`not_found` 与 `unknown` 都不是 denied**：
    // 前者是「被问的客体不存在」、后者是「读不到」，都不是「调用被拒」——把它们记成 denied
    // 会让安全复核分不清「判了拒」和「查了个空」。reason 一律透传 payload.reason（含 ok 行），
    // 这样 `select tool, verdict, reason, count(*) … group by 1,2,3` 能区分三种空。
    const status = typeof payload.status === 'string' ? payload.status : null
    const verdict = status === 'error' ? 'error' : isError && status !== 'not_found' ? 'denied' : 'ok'
    const reason = typeof payload.reason === 'string' ? payload.reason : (status !== null && status !== 'ok' ? status : '')
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
      try {
        const out = await IMPLS[name]!(depsOf(d), args)
        return await reply(d, name, args, out.payload, out.isError, out.auditRowCount ?? null)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return await reply(d, name, args, { status: 'error', reason: 'tool_exception', detail }, true, null)
      }
    },
  }
}

/** 给 mcp-manage.ts 的现成实例（缺省装配）。 */
export const pipelineTools: McpToolGroup = makePipelineTools()
