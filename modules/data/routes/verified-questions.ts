// verified-questions.ts — W1 可信度地基：已验证问答的**平台 HTTP 面**（列出 / 人工确认 / 人工拒绝）。
//
//   GET  /metrics/verified              读（manifest: data:query）
//   POST /metrics/verified/:id/verify   写（manifest: data:manage）
//   POST /metrics/verified/:id/reject   写（manifest: data:manage）
//
// 门禁由宿主按 manifest 的 `api.internal` 施加——本文件**不写** requireScope（与 metrics.ts 同纪律）。
// 隔离键 org 一律取 `c.get('tenant').casdoor_org`（text）；身份归一一律 `requesterOf(c)`。
//
// `:id` 是 `bigserial` ⇒ 用 `parseIdParam`（**不是** metrics 的 `metricIdOf`：指标 id 是外部
// 命名 text，数字解析器会把合法 id 判成非法）。非法/缺失 id 一律 404，不给存在性探针。
//
// 状态机与「确认 ⇒ source/strength 升为 human」在域层 `setStatus` 内实现（单一判定点）；
// 本文件只做「形状校验 + 域层结果 → HTTP」，不内联业务判定。
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { parseIdParam, requesterOf, writeOutcome } from './context'
import { listVerified, setStatus } from '../domain/verified-questions'
import type { ListVerifiedOptions, VerifiedQuestionStatus } from '../domain/verified-questions'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

/**
 * 允许显式查询的状态。缺省（不传 `status`）交给 `listVerified` 的默认值 `'verified'`——
 * 默认口径只有域层一处事实源，本文件不抄一遍。
 */
const STATUSES: ReadonlySet<string> = new Set<VerifiedQuestionStatus>([
  'candidate', 'verified', 'rejected', 'stale',
])

/** 人工决策（确认/拒绝）的共同前半段：身份 → id → 域层 setStatus → 判别式结果。 */
async function humanDecision(
  c: Context<ModuleVars>,
  ctx: RouteCtx,
  status: 'verified' | 'rejected',
) {
  const requester = requesterOf(c)
  // 人工状态变更要能归属到人（审计）；无身份、或 userId 为空 ⇒ 拒。
  // `requesterOf` 只拦空 orgId，userId 空串会一路落到域层抛错变 500——入口先挡。
  if (requester === null || requester.userId.trim() === '') {
    return c.json({ error: 'UNAUTHENTICATED' }, 403)
  }
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
  // 域层返回 false = 本 org 下没有这一行（含跨租户 id）⇒ 404，不区分「不存在」与「别人的」。
  const hit = await setStatus(ctx.pool, orgOf(c), id, status, requester.userId)
  return writeOutcome(c, hit ? { ok: true } : { ok: false, http: 404, error: 'NOT_FOUND' }, 200)
}

export function registerVerifiedQuestions(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/metrics/verified', async (c) => {
    const requester = requesterOf(c)
    // 「无身份」不列任何行（与 GET /metrics 同口径：不是报错，也不是全租户数据）。
    if (requester === null) return c.json({ questions: [] })

    const statusRaw = c.req.query('status')
    if (statusRaw !== undefined && !STATUSES.has(statusRaw)) {
      return c.json({ error: 'INVALID_STATUS' }, 400)
    }
    const metricId = c.req.query('metricId')
    const opts: ListVerifiedOptions = {
      ...(statusRaw === undefined ? {} : { status: statusRaw as VerifiedQuestionStatus }),
      ...(metricId === undefined || metricId === '' ? {} : { metricId }),
    }
    return c.json({ questions: await listVerified(ctx.pool, orgOf(c), opts) })
  })

  r.post('/metrics/verified/:id/verify', (c) => humanDecision(c, ctx, 'verified'))
  r.post('/metrics/verified/:id/reject', (c) => humanDecision(c, ctx, 'rejected'))
}
