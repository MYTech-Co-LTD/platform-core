// reports.ts — Metabase 报表 facade 的路由层（T7）。
//
// **门禁由宿主施加**（manifest 的 api.internal），本文件不写 requireScope。分档：
//   制作/登记/对账 = `data:manage`；观看面（清单 + 拿嵌入 URL）= `data:query`。
//
// ⚠️ **权限双门必须分开表态**（spec §4，安全论断的落点）：
//   · 页门「谁**能看**」= 本模块的 platform scope（宿主按 manifest 施加）。
//   · 数据门「看**哪个租户的数据**」= 嵌入时**锁定的 tenant 参数**——它由平台**写死**成
//     调用者身份里的 org（`requester.orgId`），**绝不接受任何入参覆盖**。
//     为什么不能接受入参：观看者拿到的是我们签的 JWT，`locked` 值对观看者不可见不可改
//     （spec §6.3）——这正是「AI/客户端不能靠传参换租户」的结构性保证。
//   两门都必须在：只有页门 ⇒ 任何有 data:query 的人能看全租户；只有数据门 ⇒ 「谁看」无判定。
//
// ⚠️ 为什么报表**必须**经平台建（spec §11.3.1 / §4）：AI 侧的语义层自身不带权限，
//   「建报表 = 跨租户能力」；facade 是唯一的鉴权与定租户点。故本模块绝不把 Metabase 凭据
//   下发给任何调用方，凭据只在本模块服务端 env。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import {
  MetabaseError,
  archiveDashboard,
  embedDashboardUrl,
  listEmbeddableDashboards,
  metabaseDeps,
  metabaseFromEnv,
  setEmbedding,
  signEmbedToken,
  upsertDashboard,
} from '../domain/metabase'
import { deleteReport, getReport, listReports, upsertReport } from '../domain/report-store'

/**
 * 平台**保留**的锁定参数名：它的值恒为调用者 org、只在签 token 时现写。
 * 调用方在 `lockedParams` 里给 `tenant` ⇒ 400（不是「静默忽略」：静默会让调用方以为
 * 自己锁定了别的租户，而实际没锁——那种误解比报错危险）。
 * ⚠️ 同一个名字也必须出现在 Metabase 的 `embedding_params` 里（且为 `locked`）——
 * 否则 JWT 里带了值也不生效，租户绑定在真机上不成立。见 POST /reports 的 setEmbedding 调用。
 */
export const TENANT_PARAM = 'tenant'

/** 嵌入 URL 的有效期（秒）。短期凭证：不落书签、不进日志、可被重放但窗口很小。 */
const EMBED_TTL_SECONDS = 600

const ReportBody = z.object({
  title: z.string().trim().min(1).max(200),
  /** 除 tenant 外要锁的参数 → 值。锁定即「观看者不可见不可改」，值由我们签进 JWT。 */
  lockedParams: z.record(z.string()).default({}),
  /** NULL = 所有拿到本模块的人可见（口径同 data.metrics.required_scope）。 */
  requiredScope: z.string().min(1).nullable().default(null),
})

/**
 * 报表 id 的解析口径（text，uuid）。**只挡「空/缺失」**，一律 404——与 aftersales /
 * metrics 的「非法 id 一律 404」一致，不给存在性探针（不做 uuid 形状校验：形状不对
 * 也只是查不到，多一条正则就多一个「合法 id 被拒」的误伤面）。
 */
const reportIdOf = (raw: string | undefined): string | null =>
  raw === undefined || raw === '' ? null : raw

/** 行级数据门：词表外的报表可见性也按「org + 行上 required_scope」裁（口径同 visibleMetrics）。 */
const visibleTo = (
  row: { requiredScope: string | null },
  requester: { hasScope(code: string): boolean },
): boolean => row.requiredScope === null || requester.hasScope(row.requiredScope)

export function registerReports(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/reports', async (c) => {
    // 入口先判身份：不给匿名者「本站有没有接报表服务」的探测信号（fail-closed）
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    // 没配 Metabase ⇒ 可解释的 503（配置状态，不是故障；口径同 LLM_UNCONFIGURED）
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const parsed = ReportBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 保留名一律拒（在碰 Metabase 之前）
    if (Object.hasOwn(parsed.data.lockedParams, TENANT_PARAM)) {
      return c.json({ error: 'TENANT_PARAM_RESERVED' }, 400)
    }

    const org = c.get('tenant').casdoor_org
    const deps = metabaseDeps(cfg)
    try {
      // 幂等（API 无按名 upsert，spec §6.5）：命中同名 ⇒ PUT、否则 POST
      const up = await upsertDashboard(deps, parsed.data.title)
      // 发布 + 锁参数。tenant 恒锁（值不在这里，在签名时现写）——这行是「租户绑定成立」的前提
      await setEmbedding(deps, up.id, [
        { name: TENANT_PARAM, mode: 'locked' },
        ...Object.keys(parsed.data.lockedParams).map((name) => ({ name, mode: 'locked' as const })),
      ])
      const id = await upsertReport(ctx.pool, org, {
        title: parsed.data.title,
        metabaseId: up.id,
        embedParams: parsed.data.lockedParams,
        requiredScope: parsed.data.requiredScope,
      })
      return c.json({ id, metabaseId: up.id, created: up.created }, 201)
    } catch (err) {
      // 上游失败与「没配」分开表达（502 vs 503）。`created` 的幂等证据也随之不可得——
      // 不在这里造一个假值。Metabase 侧可能已建出 dashboard 而登记行没写成（setEmbedding
      // 失败时）⇒ 那条孤儿会**显式**出现在对账的 unregistered 差集里，正是它该出现的地方。
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }
  })

  r.get('/reports', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：对其「看不见」（约束 3）——空清单，不是报错（口径同 GET /metrics）
    if (requester === null) return c.json({ reports: [] })
    const rows = await listReports(ctx.pool, c.get('tenant').casdoor_org)
    // 只投影消费面要的字段：metabase_id / embed_params 是实现细节，不外泄
    return c.json({
      reports: rows.filter((row) => visibleTo(row, requester))
        .map((row) => ({ id: row.id, title: row.title, requiredScope: row.requiredScope })),
    })
  })

  r.get('/reports/:id/embed-url', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 数据门之二（行级）：行上 required_scope 比页门更细
    if (!visibleTo(row, requester)) {
      return c.json({ error: 'FORBIDDEN', need: row.requiredScope }, 403)
    }

    // ★★ 安全论断的落点：locked.tenant 恒 = 调用者身份里的 org。
    //    · 查询串/请求体里的 tenant **从不读取**（本 handler 里没有任何 c.req.query('tenant')）；
    //    · 展开顺序也钉死：平台值放**最后**，即便库里被手工塞了一条带 tenant 的 embed_params
    //      也覆盖不了平台值（纵深防御，不只靠写入侧的那道 400）。
    //    为什么取 requester.orgId 而不是 c.get('tenant').casdoor_org：锁进 token 的是
    //    「以哪个租户的视角看数据」，必须以**调用者身份**的 org 为准，绝不展示身份之外 org 的数据。
    const locked = { ...row.embedParams, [TENANT_PARAM]: requester.orgId }
    const token = signEmbedToken(
      cfg.secretKey, { type: 'dashboard', id: row.metabaseId }, locked, EMBED_TTL_SECONDS,
    )
    return c.json({
      url: embedDashboardUrl(cfg.baseUrl, token),
      expiresAt: new Date(Date.now() + EMBED_TTL_SECONDS * 1000).toISOString(),
    })
  })

  r.delete('/reports/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const deps = metabaseDeps(cfg)
    try {
      // 先归档、再删行。顺序不能倒：只删登记行而把 dashboard 留在可嵌入集里 ⇒ 它恒出现在
      // 对账的 unregistered 差集里（一条永远消不掉的噪声）。反过来先归档、删行失败 ⇒
      // 登记行还在，对账会把它报成 missingInMetabase（可恢复的、显式可见的状态）。
      await archiveDashboard(deps, row.metabaseId)
    } catch (err) {
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }
    await deleteReport(ctx.pool, c.get('tenant').casdoor_org, row.id)
    return c.body(null, 204)
  })

  r.post('/reports/reconcile', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const org = c.get('tenant').casdoor_org
    const rows = await listReports(ctx.pool, org)
    let embeddable: { id: number; name: string }[]
    try {
      // 正规可观测面（spec §6.5）：**别看 iframe**——报表被 unpublish 后嵌入方显示什么
      // 官方没有任何说明，属不可观测面。
      embeddable = await listEmbeddableDashboards(metabaseDeps(cfg))
    } catch (err) {
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }

    // 双向差集（spec §7：对账必须有，且失败必须**显式可见**，不静默——M3c 教训）
    const embeddableIds = new Set(embeddable.map((d) => d.id))
    const localTitles = new Set(rows.map((r) => r.title))
    const missingInMetabase = rows
      .filter((r) => !embeddableIds.has(r.metabaseId))
      .map((r) => ({ id: r.id, title: r.title, metabaseId: r.metabaseId }))
    const unregistered = embeddable
      .filter((d) => !localTitles.has(d.name))
      .map((d) => ({ metabaseId: d.id, name: d.name }))
    const ok = missingInMetabase.length === 0 && unregistered.length === 0

    // 差集非空 ⇒ 打一条可检索的告警行：对账结果只在响应体里返回的话，只有**主动去调**的人
    // 才看得见（这正是 #M3c 那条「配了但不对，在请求路径上不可观测」的病）。
    if (!ok) {
      console.warn(
        `[data.reports] 对账差集 org=${org} `
        + `missingInMetabase=${missingInMetabase.length} unregistered=${unregistered.length}`,
      )
    }
    return c.json({
      ok,
      registered: rows.length,
      embeddable: embeddable.length,
      missingInMetabase,
      unregistered,
    })
  })
}
