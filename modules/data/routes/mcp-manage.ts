// mcp-manage.ts — POST /mcp-manage：MCP 的**写面**（本租户口径的定义）。
//
// 门禁由宿主按 manifest 的 `scope: data:manage` 施加——**本文件不写 requireScope**。
// 与读面分成两个端点（而不是把写工具塞进 /mcp）的理由：写工具所需的能力必须出现在清单里，
// 否则「声明即授权」这条单一事实源就被削弱了。设计见
// docs/superpowers/specs/2026-10-07-mcp-write-face-design.md。
//
// 判定不自建：写/删一律经 domain/metric-write（与 HTTP 面**同一份**判定），
// 本文件只做「入参形状校验 + 域层结果 → MCP 工具级错误」。
import { z } from 'zod'
import { visibleMetrics } from '../domain/authz'
import { loadMergedCatalog } from '../domain/metric-store'
import { L2DeclarationSchema, dimensionNamesOf } from '../domain/semantic-compiler'
import { deleteMetricDeclaration, writeL2Declaration } from '../domain/metric-write'
import type { L2DeclarationBody, MetricWriteOutcome } from '../domain/metric-write'
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpToolSet } from './mcp-rpc'

/**
 * 工具入参 = L2 声明的**去掉 op 与 target**：
 *   · `op` 由工具面固定为 refine（v1 只有一个算子）——让 agent 去写它只会多一个
 *     「可能写错、而错法是 zod 先拦成 400」的噪音；
 *   · `target` 本就不受支持（域层会拒），干脆不出现在工具面。
 * `.strict()` 与 HTTP 面的 L2Body 同规：多写 sql 类字段一律拒，**不是**静默忽略。
 */
const CustomizeArgs = L2DeclarationSchema
  .omit({ op: true, target: true })
  .extend({ id: z.string().min(1).max(64) })
  .strict()

const DeleteArgs = z.object({ id: z.string().min(1).max(64) }).strict()

const ok = (o: Record<string, unknown>) => ({ text: JSON.stringify({ status: 'ok', ...o }), isError: false })

/** 域层判别式结果 → 工具级错误。`http` **不出现在工具面**（那是 HTTP 语义），只留可解释的 error 码。 */
const refused = (r: MetricWriteOutcome) => ({
  text: JSON.stringify({
    status: 'refused',
    error: r.ok ? 'UNKNOWN' : r.error,
    ...(r.ok ? {} : (r.extra ?? {})),
  }),
  isError: true,
})

/** 只投影**口径本身**：不回 selectSql（上游 spec §4.4：给人/给 agent 看的是口径，不是 SQL）。 */
const view = (m: Parameters<typeof dimensionNamesOf>[0] & { id: string; title: string; description: string }) =>
  ({ id: m.id, title: m.title, description: m.description, dimensions: dimensionNamesOf(m) })

const manageToolset: McpToolSet = {
  serverName: 'platform-data-mcp-manage',

  async list(deps) {
    // M3 守卫同读面：空身份 ⇒ 空工具面。守卫必须在加载词表**之前**（否则空身份先炸在加载上）。
    if (deps.requester === null) return []
    const all = await loadMergedCatalog(deps.pool, deps.org)
    const bases = visibleMetrics(
      all.filter((m) => m.source === 'l1'), deps.requester, deps.adoptedSources)
    const custom = all.filter((m) => m.source === 'l2')
    return [
      {
        name: 'list_metrics',
        description: '列出可用作基底的平台口径（含可用维度），以及本租户已定义的口径。定义前先调它。',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'customize_metric',
        description: [
          '基于一条已有平台口径，裁剪出本租户的口径（改名 / 收窄可见维度 / 加过滤）。',
          '**只能基于已有口径裁剪，不能凭空造新指标**：baseMetric 必须是 list_metrics 里出现的',
          '平台口径 id；可用维度也以它为准（维度越界会被拒）。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '本租户口径的 id（≤64 字，不能与平台口径重名）' },
            baseMetric: { type: 'string', description: '基底平台口径 id（取自 list_metrics）' },
            alias: { type: 'string', description: '展示名' },
            visibility: { type: 'object', description: '可见维度（决定外层聚合口径）' },
            filters: { type: 'array', description: '等值过滤' },
          },
          required: ['id', 'baseMetric'],
        },
      },
      {
        name: 'delete_custom_metric',
        description: '删除本租户自定义的口径。**平台口径不可删**（会被拒）。',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '口径 id' } },
          required: ['id'],
        },
      },
    ]
  },

  async call(deps, name, args) {
    if (deps.requester === null) {
      return { text: JSON.stringify({ status: 'error', reason: 'unauthenticated' }), isError: true }
    }
    const writeDeps = { pool: deps.pool, adoptedSources: deps.adoptedSources }

    if (name === 'list_metrics') {
      const all = await loadMergedCatalog(deps.pool, deps.org)
      const bases = visibleMetrics(
        all.filter((m) => m.source === 'l1'), deps.requester, deps.adoptedSources)
      return ok({ bases: bases.map(view), custom: all.filter((m) => m.source === 'l2').map(view) })
    }

    if (name === 'customize_metric') {
      const parsed = CustomizeArgs.safeParse(args)
      if (!parsed.success) return refused({ ok: false, http: 400, error: 'INVALID_BODY' })
      const { id, ...decl } = parsed.data
      const r = await writeL2Declaration(
        writeDeps, deps.org, id, { ...decl, op: { kind: 'refine' } } as L2DeclarationBody)
      return r.ok ? ok({ id }) : refused(r)
    }

    if (name === 'delete_custom_metric') {
      const parsed = DeleteArgs.safeParse(args)
      if (!parsed.success) return refused({ ok: false, http: 400, error: 'INVALID_BODY' })
      const r = await deleteMetricDeclaration(writeDeps, deps.org, parsed.data.id)
      return r.ok ? ok({ id: parsed.data.id }) : refused(r)
    }

    return { text: JSON.stringify({ status: 'error', reason: 'unknown_tool', name }), isError: true }
  },
}

export function registerMcpManage(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp-manage', ctx, manageToolset)
}
