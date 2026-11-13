// metric-changes.ts — 指标变更单端点（spec 2026-11-12 §6/§7，P0）。
//
//   POST /metric-changes              提交即试算（agent 只提案；PAT/会话都可）
//   GET  /metric-changes              列表（?status=，缺省 pending）
//   GET  /metric-changes/:id          单据详情
//   POST /metric-changes/:id/preview  重跑试算（pending 单才可）
//   POST /metric-changes/:id/adopt    采纳 —— **只认会话**（PAT/企微 ⇒ 403 DECISION_REQUIRES_SESSION）
//   POST /metric-changes/:id/reject   驳回 —— **只认会话**；reason 必填
//   POST /metric-changes/:id/withdraw 撤回 —— 提交者本人
//
// 采纳/驳回是**人的决策**：PAT/企微通道打决策端点一律 403 DECISION_REQUIRES_SESSION
// （结构性禁止 agent 自审；manifest 页门管不了通道，这是有意的第二道闸）。提交/试算/撤回
// 不设通道闸——agent 写面（data:manage）本来就是提案的生产通道。
//
// 门禁由宿主按 manifest 的 api.internal 施加——本文件**不写** requireScope（与 metrics.ts 同纪律）。
// 隔离键 org 一律取 `c.get('tenant').casdoor_org`；身份归一一律 `requesterOf(c)`。
// `:id` 是 `bigserial` ⇒ 用 `parseIdParam`（verified-questions.ts 同款；非法/缺失一律 404，
// 不给存在性探针）。
//
// 试算只读：`applyPreview` 自己没有租户/状态守卫（Task 3 评审遗留）⇒ 这层闸在**本文件**：
// 重跑试算前必须先 `getChange`（跨租户 ⇒ 404；已决/离场单 ⇒ 409 CHANGE_STATE_CHANGED），
// 不给 applyPreview 喂没验过的单。
import type { Context } from 'hono'
import { z } from 'zod'
import { REQUESTER_CHANNEL, TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { parseIdParam, requesterOf } from './context'
import { adoptChange, getChange, listChanges, rejectChange, submitChange, withdrawChange } from '../domain/metric-change'
import type { ChangeStatus } from '../domain/metric-change'
import { PENDING_STATUSES } from '../domain/metric-change'
import { applyPreview, previewTooRecent, recentPreviewFor, runPreview } from '../domain/metric-change-preview'
import { analystPool, runWarehouseSqlParams } from '../domain/warehouse'

const SubmitBody = z.object({
  metricId: z.string().min(1).max(128),
  kind: z.enum(['create', 'update', 'meta', 'delete', 'override', 'declaration']),
  payload: z.unknown().optional(),
})
const RejectBody = z.object({ reason: z.string().min(1).max(500) })

/** GET 列表允许的显式状态（'pending' = 三态未决合集）。非法值 400，不静默回空列表。 */
const LIST_STATUSES: ReadonlySet<string> = new Set<string>([
  'draft', 'preview_ready', 'preview_failed', 'adopted', 'rejected', 'superseded', 'withdrawn', 'pending',
])

/** 决策端点的通道闸：REQUESTER_CHANNEL 未设 = 系统内会话（requester-vars.ts 的语义）。
 *  这里只放行「不是 pat/wecom」——宿主将来加新通道时默认收紧（fail-closed）。 */
const requireSession = (c: Context<ModuleVars>): boolean =>
  (c.get(REQUESTER_CHANNEL) ?? 'session') === 'session'

/**
 * 试算执行器（runPreview 的 `deps.execute`：对象行形状，Task 3 的 PreviewDeps 契约）。
 * · `ctx.execute` 注入（测试缝）＝对象行假执行器，直接透传。`SqlExecutor` 的「数组行」形状是
 *   query 面的契约（T6），预览面统一对象行——这里的 cast 是**显式表态**（两个注入面形状不同，
 *   不是疏忽；测试注入面以 PreviewDeps 为准）。
 * · 生产（ctx.execute 缺省）＝ `analystPool` 只读池。⚠️ 用 `runWarehouseSqlParams` 而不是
 *   `runWarehouseSql`：后者**不收 params**（窗口过滤 `between $1 and $2` 参数就送不进库），
 *   且回的是列优先的数组行——这里把它 zip 回对象行归一到 PreviewDeps 形状。
 */
type PreviewExec = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
const previewExecOf = (ctx: RouteCtx): PreviewExec =>
  ctx.execute !== undefined
    ? ctx.execute as unknown as PreviewExec
    : async (sql, params) => {
        const r = await runWarehouseSqlParams(analystPool(), sql, params ?? [])
        return { rows: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))) }
      }

export function registerMetricChanges(r: ModuleHono, ctx: RouteCtx): void {
  // 提交即试算（spec §6.1）：试算失败落 preview_failed，单据仍可读、不可采纳——不回 5xx。
  r.post('/metric-changes', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const parsed = SubmitBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    // 提交即试算的限速（P6 Task 3）：取最近一条带快照且未被决策的单（superseded 计入，
    // adopted/rejected/withdrawn 排除）。命中 ⇒ 仍落单（提交是合法业务动作，不拒绝），但跳过
    // 试算——单停在 draft，人可在待核对页按「跑试算」补。
    const rateLimited = await recentPreviewFor(ctx.pool, org, parsed.data.metricId)
    const out = await submitChange(ctx.pool, org,
      { userId: requester.userId, channel: requester.channel },
      parsed.data.metricId, parsed.data.kind, parsed.data.payload ?? {})
    if (!out.ok) return c.json({ error: out.error }, out.http)
    if (rateLimited) {
      return c.json({
        change: await getChange(ctx.pool, org, out.change.id),
        previewSkipped: 'rate_limited',
      }, 200)
    }
    const preview = await runPreview({ pool: ctx.pool, execute: previewExecOf(ctx) }, org, out.change)
    await applyPreview(ctx.pool, out.change.id, preview)
    return c.json({ change: await getChange(ctx.pool, org, out.change.id) }, 200)
  })

  r.get('/metric-changes', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const q = c.req.query('status')
    // 缺省 pending：评审页的默认视图是「等决策的」；要看全史显式 ?status=adopted 等逐态查
    const status = q === undefined ? 'pending' : q
    if (!LIST_STATUSES.has(status)) return c.json({ error: 'INVALID_STATUS' }, 400)
    const changes = await listChanges(ctx.pool, c.get('tenant').casdoor_org, status as ChangeStatus | 'pending')
    return c.json({ changes }, 200)
  })

  r.get('/metric-changes/:id', async (c) => {
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const change = await getChange(ctx.pool, c.get('tenant').casdoor_org, id)
    return change === null ? c.json({ error: 'NOT_FOUND' }, 404) : c.json({ change }, 200)
  })

  // 重跑试算：只喂验过的单（Task 3 评审遗留——applyPreview 无自守，闸收在这里）。
  // 跨租户/不存在 ⇒ 404；已决/离场（adopted/rejected/superseded/withdrawn）⇒ 409
  // CHANGE_STATE_CHANGED（与采纳域层同名同义：这单已被处理，别再在旧凭据上花算力）。
  r.post('/metric-changes/:id/preview', async (c) => {
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    const change = await getChange(ctx.pool, org, id)
    if (change === null) return c.json({ error: 'NOT_FOUND' }, 404)
    if (!PENDING_STATUSES.includes(change.status)) return c.json({ error: 'CHANGE_STATE_CHANGED' }, 409)
    // 重跑限速（P4 Task 4，销缓办①）：提交即试算已刚落过 ranAt，60s 内连打不再烧执行资源。
    // 提交面有各自的限速（P6 Task 3：recentPreviewFor，命中时跳过试算而不是 409）——两处
    // 共用 previewTooRecent 这一份时钟判据，但拒绝形态不同（重跑 409 / 提交照落单）。
    if (previewTooRecent(change.preview)) return c.json({ error: 'PREVIEW_RATE_LIMITED' }, 409)
    const preview = await runPreview({ pool: ctx.pool, execute: previewExecOf(ctx) }, org, change)
    await applyPreview(ctx.pool, change.id, preview)
    return c.json({ change: await getChange(ctx.pool, org, change.id) }, 200)
  })

  // ── 决策端点：只认会话（结构性禁止 agent 自审）──
  r.post('/metric-changes/:id/adopt', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    if (!requireSession(c)) return c.json({ error: 'DECISION_REQUIRES_SESSION' }, 403)
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    // title 快照必须在**采纳动作之前**取（P1 Task 4，销缓办③）：delete 档采纳后
    // 行已删，事后 join 落空 ⇒ 那张单永远发不出变更通知。left join：create 档采纳前行还不存在
    // ⇒ 快照缺 —— title 回退 metricId（行为变化如实记：create 的通知 title 从「新 title」变为
    // metricId，这是快照语义的代价，计划写明）。查询失败在采纳前 fail-fast（此时零写入，
    // 不存在半态）；emit 仍 fail-open（见下）。eventId 不再用 metric 版本号（改用单号，见下）。
    const snap = await ctx.pool.query(
      `select ch.metric_id, m.title
         from data.metric_change ch left join data.metrics m on m.org = ch.org and m.id = ch.metric_id
        where ch.org = $1 and ch.id = $2`, [org, id])
    const out = await adoptChange(
      { pool: ctx.pool, adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []), requester,
        // override 档采纳（P1 Task 7）经 createOverrideDeclaration 用到数据面（列检查/EXPLAIN）；
        // 与 routes/metrics.ts 的 override 端点同款布线（缺省 = 跳那两道，其余校验不降级）。
        ...(ctx.warehouse === undefined ? {} : { warehouse: ctx.warehouse }) },
      org, id,
    )
    if (!out.ok) return c.json({ error: out.error }, out.http)
    // 变更通知（fail-open，模块协议 12：emit 的返回不参与业务分支；事件已在 manifest 声明）。
    // 收件人由 notify 层按绑定规则解析（scope_holders: data:query）——模块只报事实，不自己找收件人。
    if (ctx.notify) {
      try {
        // metric_id 在单据行上（adopt 已成功 ⇒ 行必在）；title 用**采纳前**快照——
        // delete 档行已删也发（P0 时代 delete 采纳从不发通知）。
        const hit = snap.rows[0] as { metric_id: string; title: string | null } | undefined
        if (hit !== undefined) {
          const metricId = String(hit.metric_id)
          // eventId 末段拼**变更单 id**（P4 Task 4，销缓办⑤）：P1 实证「delete→re-create 同
          // metricId」会复用 metric 版本号 ⇒ 被 notify 去重吞。单号每单唯一，重建即新事件。
          // ★ `ch:` 前缀是命名空间隔离（修复轮）：confirm-draft（routes/metrics.ts）仍发
          // `...:{metricId}:{version}`，两边末段都是整数——不加前缀时同 org+metric 下 changeId
          // 撞上历史 version 会被 notify 永久去重。`ch:` 让两族 eventId 永不相交。
          await ctx.notify.emit(c.get('identity'), {
            eventKey: 'data.metric.definition.changed',
            eventId: `data.metric.definition.changed:${org}:${metricId}:ch:${id}`,
            scope: metricId,
            payload: {
              metricId,
              title: String(hit.title ?? metricId),
              changedBy: requester.userId,
              link: `${process.env.PLATFORM_CONSOLE_BASE_URL ?? ''}/console/data/metrics`,
            },
          })
        }
      } catch (e) {
        console.warn('[data] metric.definition.changed emit failed（不阻断业务）:', e instanceof Error ? e.message : e)
      }
    }
    return c.json({ ok: true }, 200)
  })

  r.post('/metric-changes/:id/reject', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    if (!requireSession(c)) return c.json({ error: 'DECISION_REQUIRES_SESSION' }, 403)
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = RejectBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'REASON_REQUIRED' }, 400)
    const ok = await rejectChange(ctx.pool, c.get('tenant').casdoor_org, id, requester.userId, parsed.data.reason)
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'CHANGE_STATE_CHANGED' }, 409)
  })

  r.post('/metric-changes/:id/withdraw', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const ok = await withdrawChange(ctx.pool, c.get('tenant').casdoor_org, id, requester.userId)
    // false = 不是本人 / 已离场 / 本 org 无此行——一律 403（撤回是提交者私权，不暴露存在性）
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'FORBIDDEN' }, 403)
  })
}
