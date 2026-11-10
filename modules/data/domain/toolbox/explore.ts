// explore.ts —— `explore_query` 的 MCP 工具实现（W6 Task 2）。
//
// 只做装配：身份 → 依赖 → `executeExplore`。**审计不在这里写**——`callTool` 是唯一分发点
// （registry 不变量），本 impl 只回填 `auditMetricId` / `auditRowCount` 让它记在正确的位置。
import { executeExplore } from '../analysis/explore-exec'
import { exploreProvenance, isoNow } from '../provenance'
import type { ToolImpl } from './registry'

export const exploreQueryImpl: ToolImpl = async (deps, args) => {
  if (deps.requester === null) {
    return { payload: { status: 'denied', reason: 'unauthenticated' }, isError: true }
  }
  if (deps.exploreExec === undefined) {
    // 没配仓库的部署（或测试漏配）⇒ 明确报错，不静默返回空集。
    return { payload: { status: 'error', reason: 'warehouse_unconfigured' }, isError: true }
  }
  const out = await executeExplore(
    {
      pool: deps.pool,
      org: deps.org,
      requesterUserId: deps.requester.userId,
      channel: deps.requester.channel,
      keyId: deps.requester.keyId,
      exec: deps.exploreExec,
      audit: false,
    },
    args,
  )
  const relation = typeof args.relation === 'string' ? args.relation : 'unknown'
  if (!out.ok) {
    return {
      payload: { status: out.code === 'EXEC_FAILED' || out.code === 'NO_CONTEXT' ? 'error' : 'denied', code: out.code, detail: out.detail ?? null, relation },
      isError: true,
      auditMetricId: `explore:${relation}`,
      auditRowCount: null,
    }
  }
  return {
    payload: {
      status: 'ok',
      relation,
      columns: out.columns,
      rows: out.rows,
      rowCount: out.rowCount,
      truncated: out.truncated,
      sql: out.sql,
      sqlPreview: out.preview,
      // 结果来源（S1）：explore 是即席查询，没有指标版本；锚点是关系 + 执行时刻 + 审计行。
      // auditId 仅在本层自己写审计时存在（MCP 路径由 callTool 统一写，故缺席）。
      provenance: exploreProvenance({
        relation,
        executedAt: isoNow(deps.now),
        auditId: out.auditId,
      }),
    },
    isError: false,
    auditMetricId: `explore:${relation}`,
    auditRowCount: out.rowCount,
  }
}
