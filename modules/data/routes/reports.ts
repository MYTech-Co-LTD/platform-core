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
//
// ⚠️ **Metabase 侧的身份按 org 命名空间化**（I-1）：`<org>/<title>`（`dashboardName`）。
//   平台的 Metabase 是单实例多租户共用，dashboard 只有 `name` 这一个身份 ⇒ 名字不带 org 时，
//   两个租户的同名报表经 `GET /api/search` 命中同一张 ⇒ 跨租户**改写**（setEmbedding 覆盖
//   embedding_params）与跨租户**归档**（DELETE 删掉别人的报表）。四处口径必须一致：
//   查找 / 创建（都过 `dashboardName`）、发布与归档（按 upsert / 登记行给出的 id 走）。
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TENANT_SOURCES } from '@platform/sdk'
import type { Context } from 'hono'
import type { Pool } from 'pg'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { requesterOf } from './context'
import type { Requester } from '../domain/authz'
import type { UserStatus } from '@platform/sdk'
import { llmFromEnv, openAiCompatModel } from '../domain/llm'
import type { StreamingChatModel } from '../domain/llm'
import { buildFacts } from '../domain/report-facts'
import { buildReportReceipt, exportDetailCsv, receiptCsv, type ReportReceipt } from '../domain/report-receipt'
import { buildReportReview } from '../domain/report-review'
import { summarizeExposure } from '../domain/publish-preview'
import { compileTemplate, REPORT_TEMPLATES, templateById } from '../domain/report-templates'
import { panelArgsOf } from '../domain/report-query'
import type { QueryDeps } from '../domain/query-service'
import { periodRangeOf, type DateRange } from '../domain/report-period'
import type { FactBundle } from '../domain/report-facts'
import { generateNarrative, NARRATIVE_PROMPT_VERSION, streamNarrative } from '../domain/narrative'
import { narrativeStats, recordNarrativeRun, type NarrativeOutcome } from '../domain/narrative-runs'
import type { NarrativeEvent } from '../domain/narrative'
import { signEditHandoff } from '../domain/edit-handoff'
import { withObjectLock } from '../domain/object-lock'
import {
  MetabaseError,
  archiveDashboard,
  dashboardName,
  embedDashboardUrl,
  listEmbeddableDashboards,
  metabaseDeps,
  metabaseFromEnv,
  parseDashboardName,
  setEmbedding,
  signEmbedToken,
  upsertDashboard,
} from '../domain/metabase'
import {
  deleteReport,
  getReport,
  getReportVersion,
  listAllReports,
  listReports,
  updateGates,
  updateRequiredScope,
  updateSpec,
  updateSpecAndScope,
  upsertReport,
} from '../domain/report-store'
import { PeriodSchema, parseReportSpec } from '../domain/report-spec'
import type { AiTextPanel, ReportSpec } from '../domain/report-spec'
import { deriveRequiredScope, metricIdsOf, validatePanelMetrics } from '../domain/report-scope'
import { reportScopeViolations } from '../domain/report-scope-gate'
import {
  getPublishedSpec,
  getVersion,
  listVersions,
  publishVersion,
  rollbackVersion,
  unpublishVersion,
} from '../domain/report-version'
import type { PublishErrorReason } from '../domain/report-version'
// ⚠️ `loadMergedCatalog` 的**家在 `domain/metric-store.ts`**，不在 query-service（后者只是它的
//    调用方之一）。写计划时第一版写成了 `'../domain/query-service'`——那是错的，已订正。
import { loadMergedCatalog } from '../domain/metric-store'
import {
  deptGatePasses, deptNamesOf, userDeptClosure, validateDeptGate,
} from '../domain/dept-gate'
import {
  applyPanelRenderGate,
  canEditAsset,
  canViewAsset,
  canViewVersionedContent,
  ensureOwner,
  factsSpecOf,
  isAdminOverride,
  loadAssetAcl,
  loadAssetAcls,
  replaceViewers,
  transferOwner,
  writeAssetAudit,
  type AclRow,
  type AclSubjectType,
  type RenderGateResult,
} from '../domain/asset-auth'
import { deptContextIfOwned } from '../domain/metric-visibility'
import {
  TENANT_PARAM_ID, TENANT_SLUG, publishWithTenantBinding, readDashboardContent,
} from '../domain/report-content'

/** 嵌入 URL 的有效期（秒）。短期凭证：不落书签、不进日志、可被重放但窗口很小。 */
const EMBED_TTL_SECONDS = 600

const ReportBody = z.object({
  title: z.string().trim().min(1).max(200),
  /**
   * 渲染器（#391 计划 6）：`metabase` = 嵌 Metabase dashboard（默认，既有行为）；
   * `platform` = 平台自绘（规格存 `data.reports.spec`，渲染通路归计划 6 Task 4）。
   */
  renderer: z.enum(['metabase', 'platform']).default('metabase'),
  /**
   * 平台自绘的声明式规格（`renderer='platform'` 时必给，形状由 `parseReportSpec` 白名单判）；
   * metabase 行必须 null——与库侧跨列 check `data_reports_spec_by_renderer` 同一口径，但
   * **防线只有下面那个 superRefine**：metabase 路径的 `upsertReport` 根本不传 spec（路由层
   * 丢弃，库侧 check 看不到入参），不在这里拒就是**静默丢弃**（不是库侧报错）。
   */
  spec: z.record(z.unknown()).nullable().default(null),
  /** 除 tenant 外要锁的参数 → 值。锁定即「观看者不可见不可改」，值由我们签进 JWT。
   *  ⚠️ 仅 metabase 行有意义（嵌入 token 的 locked 值）；platform 行没有嵌入通道 ⇒ 见 superRefine。 */
  lockedParams: z.record(z.string()).default({}),
  /** NULL = 所有拿到本模块的人可见（口径同 data.metrics.required_scope）。 */
  requiredScope: z.string().min(1).nullable().default(null),
  /**
   * 资产可见面（spec 2026-11-01 §4.3）：**新建默认私有**（`restricted` = 只有 owner 与 ACL 里的人）；
   * `tenant` = 沿用旧粗门（required_scope / required_depts）。显式给 `tenant` 即"建给全租户看"。
   * ⚠️ 与 `requiredScope` **正交**：后者是内容门/已发布语义，不是"公开"开关。
   */
  visibility: z.enum(['tenant', 'restricted']).default('restricted'),
  /**
   * 部门门（spec §3.4）：ext_id 数组，**子树继承**（授权「共享中心」⇒ 数字技术部的成员也可见）。
   * NULL / 空数组 = 无部门门。与 `requiredScope` **叠加**（两个门都要过），不是替代。
   * 上界 200 与 `MAX_QUERY_ROWS` 同理：只挡「客户端可控的长数组灌进 SQL」，不表达业务上限
   * （真实租户最深是一个部门一条链，个位数）。
   * 创建后改门走 `PUT /reports/:id/dept-gate`（自绘/嵌入两种行同一入口）。
   */
  requiredDepts: z.array(z.string().min(1)).max(200).nullable().default(null),
  // 内容侧版本（写保护）：更新既有 dashboard 时**必填**；见 handler 里的 fail-closed 分支
  expectedFingerprint: z.string().min(1).nullable().default(null),
}).strict()
  // 两渲染器的入参面**正交**（fail-closed，不是静默忽略）。⚠️ 本 refine 是这两支组合的
  // **唯一防线**（拒绝之后无库侧兜底）：metabase 路径的 `upsertReport` 不传 spec、platform
  // 分支硬编码 `embedParams:{}`——两支若无此 refine，入参会被**静默丢弃**而非报错，调用方
  // 以为存了规格/锁了参（TENANT_PARAM_RESERVED 同款理由：拒绝优于静默）。拒成 400 INVALID_BODY。
  .superRefine((d, ctx) => {
    if (d.renderer === 'platform' && Object.keys(d.lockedParams).length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lockedParams'], message: 'lockedParams 仅 metabase 行接受' })
    }
    if (d.renderer === 'metabase' && d.spec !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['spec'], message: 'spec 仅 platform 行接受' })
    }
  })

/**
 * AI 文本请求体（设计 spec §4.1，计划 2026-10-26 Task 7）。
 * `panelIndex` 指向**已发布/草稿快照**里的 ai_text 面板；`period` 是**本次观看**的期间
 * （随筛选栏变化，不一定等于 spec.period）。`preview:'draft'` = 管理面预览草稿
 * （仅 `data:manage`；其余人一律 404——不给「草稿存在」的探针）。
 */
const NarrativeBody = z.object({
  panelIndex: z.number().int().min(0),
  period: PeriodSchema,
  branchNum: z.string().min(1).max(64).optional(),
  /** 钉住历史快照（仍要求报表处于已发布状态，同 `GET /published-spec?v=`）。 */
  version: z.number().int().positive().optional(),
  preview: z.literal('draft').optional(),
}).strict()

/** 叙述上下文解析的失败码（handler 统一按 `narrativeErrorStatus` 映射到 400/403/404）。 */
type NarrativeContextErr = {
  error:
    | 'UNAUTHENTICATED'
    | 'NOT_FOUND'
    | 'RENDERER_NOT_SELF_DRAWN'
    | 'NO_SPEC'
    | 'NOT_PUBLISHED'
    | 'NOT_AI_TEXT_PANEL'
}

/** 失败码 → HTTP 状态（「不给存在性探针」：NOT_FOUND / NOT_PUBLISHED 同 404）。 */
const narrativeErrorStatus = (e: NarrativeContextErr): 400 | 403 | 404 => {
  if (e.error === 'UNAUTHENTICATED') return 403
  if (e.error === 'NOT_FOUND' || e.error === 'NOT_PUBLISHED') return 404
  return 400
}

/**
 * 报表 id 的解析口径（text，uuid）。**只挡「空/缺失」**，一律 404——与 aftersales /
 * metrics 的「非法 id 一律 404」一致，不给存在性探针（不做 uuid 形状校验：形状不对
 * 也只是查不到，多一条正则就多一个「合法 id 被拒」的误伤面）。
 */
/** 模块管理码（资产级判定的另一半：owner ∪ 该码）。单一常量，别在多处写字符串。 */
const MANAGE_SCOPE = 'data:manage'
/** 建**自己的**报表（#1330）。创建后 owner=创建者、默认私有；管理员（data:manage）同样可建。 */
const CREATE_SCOPE = 'data:create'

const reportIdOf = (raw: string | undefined): string | null =>
  raw === undefined || raw === '' ? null : raw

/** 行级数据门：词表外的报表可见性也按「org + 行上 required_scope」裁（口径同 visibleMetrics）。
 *  2026-10-30 起叠加**部门门**（spec §3.4 / D-O4：叠加不替代）——
 *  `userDepts` 是调用方预取的本人部门闭包（含祖先）；`undefined` = 未取 ⇒ 有门即拒（fail-closed）。 */
/**
 * 观看面的行级可见判定（spec §3.4）：**页门 ∧ 部门门**（叠加不替代，D-O4）。
 *
 * 部门门的 fail-closed 面在第三个参数：`undefined` = 调用方没解析用户部门。此时**只要行上有门
 * 就拒**——「没解析」绝不能等价于「没有部门，所以过」。调用方要么先算好部门集，要么先确认
 * 这批行里没有人带门（`GET /reports` 的惰性取法）。
 */
// 行级可见判定已收口到 `domain/asset-auth.ts` 的 `canViewAsset`（ACL → visibility → 旧内容门）。
// **不要再在路由里另写一套**——两处判断必然漂移（#1179 的教训）。

/**
 * 资产写权限（#1325 用户裁决：**owner 对自己报表的最高权限**）。
 *
 * 返回 `null` = 放行；否则返回 403 响应（`need: owner_or_data:manage`）。
 * 这些端点在 manifest 里声明为 `data:query`（门卫只挡匿名/无关者），真判据在
 * `canEditAsset`（owner ∪ 管理码，单一实现）——与 `/reports/:id/acl` 同口径。
 */
async function denyUnlessCanEdit(
  c: Context<ModuleVars>, pool: Pool, requester: Requester, org: string, id: string,
): Promise<Response | null> {
  const acl = await loadAssetAcl(pool, org, id)
  if (canEditAsset(acl, requester, MANAGE_SCOPE)) return null
  return c.json({ error: 'FORBIDDEN', need: 'owner_or_' + MANAGE_SCOPE }, 403)
}

/**
 * 受让人/受让所有者必须是**真实且可用**的账号（#1335）：与部门门同一 fail-closed 口径——
 * 「配了永远命不中」的授权不如当场拒。
 *
 * - `inactive`（查无此人 / Casdoor 停用）⇒ 拒；
 * - `unknown`（未注入 resolver / Casdoor 不可达）⇒ **放行**：可用性优先，且旧宿主/单测
 *   没有该能力（与 `userStatusOf` 的缺省契约一致）。这两态的区别是语义的，别合并。
 */
async function userStatusOf(ctx: RouteCtx, org: string, name: string): Promise<UserStatus> {
  return ctx.userStatus === undefined ? 'unknown' : ctx.userStatus(org, name)
}

/**
 * 渲染闸（P5 Task 3）：**观看面**规格按观看者的指标可见范围逐面板降级。
 *
 * 插入位置在 `canViewVersionedContent` + 快照页门/部门门**之后**：那两道管「报表该不该给这个人」，
 * 本闸管「报表里的每个口径该不该给这个人」。
 *
 * 三次取数的惰性纪律（与 P2 Task 4 同一条：现网 57 行 `owner_dept` 全空，不该因接线多打库）：
 *   · 规格里一个指标都没有（纯文本 / ai_text）⇒ 直接回原样，**零查询**；
 *   · 词表按需加载一次（`loadMergedCatalog`，L1 platform ∪ 本 org L2）；
 *   · 部门上下文再按「本次报表实际引用的指标里有没有归属部门」决定取不取
 *     （`deptContextIfOwned` 懒加载；无归属行 ⇒ 不查、不发 warn）。
 *
 * 审计沿用 `data.asset_audit`（`action='report.panel_denied'`）——不为一次观看写新表；
 * 审计写失败**不阻断观看**（可观测性副作用不该把页面打 500），落 structured warn 兜底。
 */
async function reportRenderGate(
  pool: Pool, requester: Requester, org: string, id: string, spec: ReportSpec,
): Promise<RenderGateResult> {
  const usedIds = new Set(spec.panels.flatMap((panel) => metricIdsOf(panel)))
  if (usedIds.size === 0) return { blocked: false, deniedPanels: [], denials: [], spec }

  const catalog = await loadMergedCatalog(pool, org)
  const usedRows = catalog.filter((m) => usedIds.has(m.id))
  const deptCtx = await deptContextIfOwned(pool, requester.tenantId, requester, usedRows)
  const gate = applyPanelRenderGate(spec, usedRows, deptCtx)

  if (gate.deniedPanels.length > 0) {
    try {
      await writeAssetAudit(pool, {
        org, assetId: id, actor: requester.userId, action: 'report.panel_denied',
        // 只记位置、原因与整表拒标记：审计要回答「谁被挡了几格 / 为什么 / 是否触发 reveal」，
        // 不需要把口径 id 再抄一份（metricId 在快照与词表里都能追）。
        detail: { deniedPanels: gate.deniedPanels, denials: gate.denials, revealReport: gate.blocked },
      })
    } catch (e) {
      console.warn(JSON.stringify({
        event: 'report_panel_denied_audit_failed', reportId: id,
        error: e instanceof Error ? e.message : String(e),
      }))
    }
  }
  return gate
}

export function registerReports(r: ModuleHono, ctx: RouteCtx): void {

  // ── 报表模板（R2）：把「自由写 spec」收窄成「选模板 + 填指标」────────────────────────
  // 模板是**仓内数据**（`domain/report-templates.ts`），这里只读；编译只产出 spec，
  // 不落库、不发布——创建仍走 `POST /reports` 的既有权限/校验链。
  r.get('/reports/templates', async (c) => {
    if (requesterOf(c) === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    return c.json({ templates: REPORT_TEMPLATES })
  })

  const CompileTemplateBody = z.object({
    values: z.record(z.string().min(1).max(64), z.string().min(1).max(128)).default({}),
  }).strict()

  r.post('/reports/templates/:id/compile', async (c) => {
    if (requesterOf(c) === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const template = templateById(c.req.param('id'))
    if (template === undefined) return c.json({ error: 'TEMPLATE_NOT_FOUND' }, 404)
    const body = CompileTemplateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const out = compileTemplate(template, body.data.values)
    if (!out.ok) {
      return c.json(
        { error: out.reason, ...(out.keys === undefined ? {} : { keys: out.keys }), ...(out.detail === undefined ? {} : { detail: out.detail }) },
        400,
      )
    }
    return c.json({ spec: out.spec })
  })
  r.post('/reports', async (c) => {
    // 入口先判身份：不给匿名者「本站有没有接报表服务」的探测信号（fail-closed）
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    // 创建权（#1330）：`data:create`（建自己的）∪ `data:manage`（管理员照旧，不因新码被收紧）。
    // manifest 声明的是 data:query（门卫只挡匿名/无关者），真判据在这里——与资产写同一口径。
    if (!requester.hasScope(CREATE_SCOPE) && !requester.hasScope(MANAGE_SCOPE)) {
      return c.json({ error: 'FORBIDDEN', need: CREATE_SCOPE }, 403)
    }
    // body 解析先于 metabaseFromEnv()（platform 分支要读 renderer/spec，且 400「调用方缺陷」
    // 本就该先于 503「配置状态」——先验参再查环境，与 PUT 的「先 parse 再查库」同序）。
    const parsed = ReportBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // ── 部门门的配置期校验（spec §3.4）：位置在**任何写之前**（拒 = 一行都不落）───────
    // 未知 ext_id ⇒ 400（配了也恒拒，不如当场拒）；org 表为空（租户没同步组织架构）⇒ 409
    // ORG_NOT_SYNCED（是**状态**问题，不是入参缺陷：同步后同一份 body 就能过）。
    const gateCheck = await validateDeptGate(ctx.pool, c.get('tenant').id, parsed.data.requiredDepts)
    if (!gateCheck.ok) {
      return c.json(
        { error: gateCheck.code, ...(gateCheck.unknown ? { unknown: gateCheck.unknown } : {}) },
        gateCheck.code === 'ORG_NOT_SYNCED' ? 409 : 400,
      )
    }
    // ── 平台自绘分支（#391 计划 6 Task 3）────────────────────────────────────────
    // ⚠️ **分支位置是硬要求**：必须在 `metabaseFromEnv()` 那次 503 检查**之前**——自绘报表
    //    不碰 Metabase，不该因为「Metabase 没配」而建不出来；顺序反了会在「平台自绘可用、
    //    Metabase 未配」的环境里**误报 503**（routes 测试「不设 DATA_METABASE_* 仍 201」钉住）。
    //    完全不碰 Metabase：不 upsertDashboard、不 publish、不 setEmbedding——也没有
    //    「search 后建」的竞态窗口 ⇒ 不需要 metabase 路径那把 `${org}/dash:` 对象锁。
    if (parsed.data.renderer === 'platform') {
      // 规格过白名单（机检落点在 parseReportSpec）：不合法 ⇒ 400 带专门码；缺 spec 同样落
      // INVALID_SPEC（safeParse(null) 不通过）——「自绘必须有规格」不靠调用方自觉。
      const spec = parseReportSpec(parsed.data.spec)
      if (!spec.ok) return c.json({ error: spec.code }, 400)
      const org = c.get('tenant').casdoor_org
      // ── 发布门（spec §4.2；issue #778）──────────────────────────────────────────────
      // ⚠️ 这里**曾经**直接用 `parsed.data.requiredScope`——而 `required_scope = null` 在这套模型里
      //    **就是「已发布」**（没有独立的 `published` 列，见 `updateRequiredScope` 头顶注）⇒
      //    带两个不同 scope 面板的报表可以**绕过发布门直接建成已发布态**：报表可见，但那个面板的
      //    `/query` 会 403 ⇒ 「报表看着正常、点进去有一个面板空」。
      //    ⇒ 与 `PUT /reports/:id` 走**同一个派生**：requiredScope 是 spec 的函数，不是调用方的输入。
      //    ⚠️ 不要改成「新建一律未发布」——那与「没有 published 列」的既有设计冲突。
      const catalog = await loadMergedCatalog(ctx.pool, org)
      const derived = deriveRequiredScope(spec.spec, catalog)
      if (!derived.ok) {
        return c.json(
          derived.reason === 'UNKNOWN_PANEL_METRIC'
            ? { error: derived.reason, metricId: derived.metricId }
            : { error: derived.reason, scopes: derived.scopes },
          400,
        )
      }
      // ── 派生值 vs 调用方给的值（**创建** ≠ **发布**，两者规则不同）──────────────────
      //  · 派生非 null ⇒ 它是**下界**：报表不能比它的面板更宽。调用方给的必须与它一致
      //    （这套模型**没有 scope 层级**，判不了「谁更严」⇒ 不一致只能拒，不能挑一个放行）。
      //  · 派生 null ⇒ 面板不需要任何码 ⇒ 调用方给的**草稿页门**是安全的，照用
      //    （空面板 + `data:manage` = 「先建草稿、之后再补面板并发布」，是既有正常流程）。
      let effectiveScope = derived.requiredScope
      if (effectiveScope === null) {
        effectiveScope = parsed.data.requiredScope
      } else if (parsed.data.requiredScope !== null && parsed.data.requiredScope !== effectiveScope) {
        return c.json(
          { error: 'SCOPE_CONFLICT_WITH_PANELS', derivedScope: effectiveScope, givenScope: parsed.data.requiredScope },
          400,
        )
      }
      // ── 写入侧可发布性（月报重做 Task 3 后续；spec §4.2 补强）────────────────────────
      // 与发布门 / MCP 提报面**同一份判定**（`domain/report-scope`）：未接入源的指标、
      // line/bar/kpi 上的不可加指标在**建行时**就拒——否则报表看着正常、点进去 403，
      // 或者图表把不可加指标（比率/去重计数）沿维度求和出一份假数。
      // 分档：源未接入 = 本租户的接入状态（与 `/query` 403 同因）⇒ 403；其余 = 入参本身
      // 不成立（调用方缺陷）⇒ 400。ai_text 的结构闸（AI_TEXT_REQUIRES_DATA_PANEL / _PERIOD）
      // 属后者，且没有 metricId 可点名（问题在整份规格）⇒ 只回 `error`。
      // 位置在**任何写之前**（拒 = 一行都不落）。
      const adoptedSources = new Set(c.get(TENANT_SOURCES) ?? [])
      const metrics = validatePanelMetrics(spec.spec, catalog, adoptedSources)
      if (!metrics.ok) {
        return c.json(
          { error: metrics.reason, ...('metricId' in metrics ? { metricId: metrics.metricId } : {}) },
          metrics.reason === 'METRIC_SOURCE_NOT_ADOPTED' ? 403 : 400,
        )
      }
      const id = await upsertReport(ctx.pool, org, {
        title: parsed.data.title,
        metabaseId: 0,                    // 哨兵：platform 行没有 Metabase dashboard（见 ReportRow）
        embedParams: {},                  // 入参面正交：非空 lockedParams 已在 zod 层被拒
        requiredScope: effectiveScope,
        requiredDepts: parsed.data.requiredDepts,
        renderer: 'platform',
        spec: spec.spec,
        // 资产级（spec 2026-11-01 §4.3）：缺省 restricted（私有）；显式 tenant = 建给全租户看。
        // 同名 upsert **不覆盖**既有可见性（upsert 的冲突分支不更新该列）。
        visibility: parsed.data.visibility,
      })
      await ensureOwner(ctx.pool, org, id, requester.userId)
      // `version` 是登记侧版本，**写后**回读（与 metabase 路径同口径）。自绘没有内容侧指纹
      // （内容就是 spec 本身，写保护走 PUT /spec 的 expectedVersion）也没有 `created` 证据
      // （upsertReport 只回 id）⇒ 响应体相应少这两键。
      const row = await getReport(ctx.pool, org, id)
      if (row === null) throw new Error('upsertReport 后登记行应可读（同一请求内的一致性假设被打破）')
      return c.json({ id, metabaseId: 0, version: row.version }, 201)
    }
    const cfg = metabaseFromEnv()
    // 没配 Metabase ⇒ 可解释的 503（配置状态，不是故障；口径同 LLM_UNCONFIGURED）
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    // 保留名一律拒（在碰 Metabase 之前）。TENANT_SLUG 是平台**保留**的锁定参数名：值恒 = 调用者
    // org、只在签 token 时现写；给了它 ⇒ 400（不是「静默忽略」：静默会让调用方以为锁定了别的
    // 租户而实际没锁）。⚠️ 同名必须出现在 Metabase 的 embedding_params 且为 locked，机械防线在
    // POST /reports/reconcile。**单一来源**（终审修复 1）：从 domain/report-content import——本文件
    // 曾自持 'tenant' 字面量，两处漂移 ⇒ setEmbedding 整表替换时丢 tenant:'locked' ⇒ 静默解锁租户。
    if (Object.hasOwn(parsed.data.lockedParams, TENANT_SLUG)) {
      return c.json({ error: 'TENANT_PARAM_RESERVED' }, 400)
    }

    const org = c.get('tenant').casdoor_org
    const deps = metabaseDeps(cfg)
    try {
      // ── 每对象一把锁（spec §3③）：整段写序列（upsert → 守卫 → publish → setEmbedding →
      //    登记 → 回读）串行化，收窄「先读后写」的并发窗口（version/fingerprint 比对本身只能
      //    事后发现，锁让同对象的两个写不再交错）。
      // ⚠️ 键用**规范名**（`dashboardName` 含 org，见 I-1）：创建前还没有 id，唯一稳定的对象身份
      //    就是名字；顺带把「并发建同名」也串起来——否则两个请求都 search 到空集 ⇒ 各建一张
      //    ⇒ 一张成为孤儿（既有 routes/reports.test.ts 的确定性竞态用例正是这条）。
      return await withObjectLock(`${org}/dash:${dashboardName(org, parsed.data.title)}`, async () => {
        // 幂等（API 无按名 upsert，spec §6.5）：命中同名 ⇒ PUT、否则 POST。
        // ⚠️ 查找/创建都用**含 org 的规范名**（I-1）：Metabase 是单实例多租户共用，裸 title 会让
        //    两个租户的同名报表命中同一张 dashboard ⇒ 跨租户改写 embedding_params / 跨租户归档。
        const up = await upsertDashboard(deps, dashboardName(org, parsed.data.title))
        // ── 内容侧写保护（spec §3③；人裁 2026-09-29 fail-closed）────────────────────────
        // 命中同名 ⇒ 这是**更新既有对象**：必须回带它当前的指纹，否则一律拒（不带就让人先读再写，
        // 不接受「省略 = 强制覆盖」——那正是实测里"人的两张图被静默抹掉"的那条路）。
        // ⚠️ 位置是契约的一半：必须在**任何发布写入之前**判——挪到 `publishWithTenantBinding` 之后，
        //    被拒的请求已经先写过 Metabase 了（「拒」就只是回了个码），且有卡的表上判到的还是
        //    发布后的内容。这条由 routes/reports.test.ts 的「守卫必须在写之前」用例钉住。
        //    而它放在 `upsertDashboard` **之后**是**刻意**的：那条同名路径只做**内容保持**的合并 PUT
        //    （`putDashboardMerged`：name 同值、dashcards/parameters/embedding_params 全部原值回写），
        //    对内容而言是 no-op ⇒ 不构成「先写」。守卫要拦的是**会改内容/锁参**的那两步
        //    （publish 与 setEmbedding），所以别再往「更靠前」挪（判指纹要先读内容，前置到
        //    upsert 之前只会多一次读，拦不到任何东西）。
        if (!up.created) {
          const cur = await readDashboardContent(deps, up.id)
          if (parsed.data.expectedFingerprint === null) {
            return c.json({ error: 'VERSION_REQUIRED', currentFingerprint: cur.fingerprint }, 409)
          }
          if (parsed.data.expectedFingerprint !== cur.fingerprint) {
            return c.json({ error: 'STALE_WRITE', currentFingerprint: cur.fingerprint }, 409)
          }
        }
        // 一次做全三件（声明参数 / 只映射带标签的卡 / 锁参）；额外的 lockedParams 由 setEmbedding 合并
        const pub = await publishWithTenantBinding(deps, up.id)
        if (Object.keys(parsed.data.lockedParams).length > 0) {
          await setEmbedding(deps, up.id, [
            { name: TENANT_SLUG, mode: 'locked' },
            ...Object.keys(parsed.data.lockedParams).map((name) => ({ name, mode: 'locked' as const })),
          ])
        }
        const id = await upsertReport(ctx.pool, org, {
          title: parsed.data.title,
          metabaseId: up.id,
          embedParams: parsed.data.lockedParams,
          requiredScope: parsed.data.requiredScope,
          requiredDepts: parsed.data.requiredDepts,
          visibility: parsed.data.visibility,
        })
        await ensureOwner(ctx.pool, org, id, requester.userId)
        // `version` 是**登记侧**版本（与内容侧指纹分属两条通路，别混名）：**写后**回读，不复用写前的值。
        // `fingerprint` 直接复用发布那次的现算结果——零额外请求（publishWithTenantBinding 已算过）。
        const row = await getReport(ctx.pool, org, id)
        if (row === null) throw new Error('upsertReport 后登记行应可读（同一请求内的一致性假设被打破）')
        return c.json({
          id, metabaseId: up.id, created: up.created,
          fingerprint: pub.fingerprint, version: row.version,
        }, 201)
      })
    } catch (err) {
      // 上游失败与「没配」分开表达（502 vs 503）。`created` 的幂等证据也随之不可得——
      // 不在这里造一个假值。Metabase 侧可能已建出 dashboard 而登记行没写成（setEmbedding
      // 失败时）⇒ 那条孤儿会**显式**出现在对账的 unregistered 差集里，正是它该出现的地方。
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }
  })

  /**
   * 报表规格里出现的指标 id（去重、保序）。`text` / `ai_text` 面板没有 metricId。
   * 只回**实际声明过的** id——移动壳的「口径与来源」深链靠它，前端不猜。
   */
  const metricIdsOfSpec = (spec: ReportSpec | null): string[] => {
    if (spec === null) return []
    const ids: string[] = []
    for (const panel of spec.panels) {
      if ('metricId' in panel && typeof panel.metricId === 'string' && !ids.includes(panel.metricId)) {
        ids.push(panel.metricId)
      }
    }
    return ids
  }

  r.get('/reports', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：对其「看不见」（约束 3）——空清单，不是报错（口径同 GET /metrics）
    if (requester === null) return c.json({ reports: [] })
    const org = c.get('tenant').casdoor_org
    const rows = await listReports(ctx.pool, org)
    // 资产级 ACL（spec 2026-11-01 §4）：批量取，避免 N+1；判据只有 canViewAsset 一处。
    const acls = await loadAssetAcls(ctx.pool, org, rows.map((r) => r.id))
    // 部门闭包：带部门门**或**有部门受让方时才取（其余情形零额外查询）
    const needsDepts = rows.some((r) => (r.requiredDepts ?? []).length > 0)
      || [...acls.values()].some((list) => list.some((a) => a.subjectType === 'dept'))
    const userDepts = needsDepts
      ? await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      : undefined
    // 只投影消费面要的字段：metabase_id / embed_params 是实现细节，不外泄
    return c.json({
      reports: rows.filter((row) => canViewAsset(row, requester, acls.get(row.id) ?? [], userDepts))
        .map((row) => ({
          id: row.id, title: row.title, requiredScope: row.requiredScope,
          requiredDepts: row.requiredDepts, renderer: row.renderer,
          // #1327：写保护的读侧值 + 服务端算好的「能不能改」。
          // `canEdit` 唯一实现仍是 `canEditAsset`（owner ∪ data:manage）——前端只消费结论，
          // 不复制判据（复制必然漂移，#1179 的教训）。
          version: row.version,
          // W5 Task 4 定案 A：移动壳「口径与来源」深链的唯一来源（规格里的指标 id）。
          // 没有指标 id（metabase 行 / 纯文本报表）⇒ 空数组，前端据此不渲染链接。
          metricIds: metricIdsOfSpec(row.spec),
          canEdit: canEditAsset(acls.get(row.id) ?? [], requester, MANAGE_SCOPE),
          // 所有者列（#1327）：owner-only 用户也在看这份清单，缺它会把自己的报表显示成「无所有者」
          owner: (acls.get(row.id) ?? []).find((a) => a.relation === 'owner')?.subjectId ?? null,
          // 版本徽标/发布按钮对 owner（可能无 manage 码）同样要有数据来源（#1327）
          publishedVersion: row.publishedVersion,
          hasUnpublishedChanges:
            row.publishedVersionId !== null && row.version > (row.publishedDraftVersion ?? 0),
        })),
    })
  })

  // ── 管理清单（spec §3⑤：租户管理员看**全量**本 org 行，含页门未放行的）─────────────
  // 与观看清单 GET /reports 的分野：观看面按行 required_scope 裁剪（visibleTo），管理面**不裁**
  // ——页门未放行的行对管理员必须可见、可改，否则没人能把未发布的报表发出来。
  // 授权由宿主门卫按 manifest（data:manage）施加，handler 不再判权限。
  r.get('/reports/manage', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const rows = await listReports(ctx.pool, c.get('tenant').casdoor_org)
    // 管理面**不裁行**（上面的分档），但「打开」按钮的可用性得知道管理员自己在不在门的部门里——
    // 把**请求者自己的**部门闭包一并回过（不是别人的，也不含任何组织架构全量信息）。
    // 惰性：本租户一张带门行都没有 ⇒ 不查、回空数组（零额外查询）。
    const myDepts = rows.some((r) => (r.requiredDepts ?? []).length > 0)
      ? [...await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))]
      : []
    // 所有者（spec 2026-11-01 §4.4）：管理面要能看出「谁负责 / 有没有人负责」。
    // 无 owner 行的 = 历史资产（本设计不猜测所有者，见 §4.3）；清单里显式标注，供交接清理。
    const acls = await loadAssetAcls(ctx.pool, c.get('tenant').casdoor_org, rows.map((r) => r.id))
    // 所有者活跃态（#1333，spec §4.4「管理员可列出无活跃所有者的资产供清理」）：
    // 逐行查 Casdoor 会 N+1（同一 owner 常有多张报表）⇒ 本请求内按 owner 去重缓存。
    // 未注入 resolver ⇒ null（未知），**不冒充 inactive**。
    const ownerStatusCache = new Map<string, boolean | null>()
    const ownerActiveOf = async (owner: string | null): Promise<boolean | null> => {
      if (owner === null || ctx.userStatus === undefined) return null
      const cached = ownerStatusCache.get(owner)
      if (cached !== undefined) return cached
      const s = await ctx.userStatus(c.get('tenant').casdoor_org, owner)
      // 只把确定态折成布尔；`unknown`（Casdoor 不可达/未注入）保持 null。
      const v = s === 'active' ? true : s === 'inactive' ? false : null
      ownerStatusCache.set(owner, v)
      return v
    }
    const reports: Array<Record<string, unknown>> = []
    for (const row of rows) {
      const owner = (acls.get(row.id) ?? []).find((a) => a.relation === 'owner')?.subjectId ?? null
      reports.push({
        id: row.id, title: row.title, requiredScope: row.requiredScope,
        requiredDepts: row.requiredDepts,
        renderer: row.renderer, version: row.version,
        publishedVersion: row.publishedVersion,
        // 服务端算的「能不能改」（#1327）：管理面恒 true，但仍走同一实现，别在前端另判。
        canEdit: canEditAsset(acls.get(row.id) ?? [], requester, MANAGE_SCOPE),
        // 无所有者（历史资产）显式暴露；管理员可「转移」给它一个负责人（spec §4.4）
        owner,
        // #1333：true=在职 / false=停用或查无此人 / null=未知（未注入或 Casdoor 不可达）
        ownerActive: await ownerActiveOf(owner),
        hasUnpublishedChanges:
          row.publishedVersionId !== null && row.version > (row.publishedDraftVersion ?? 0),
      })
    }
    return c.json({ myDepts, reports })
  })

  const GateBody = z.object({
    requiredScope: z.string().min(1).nullable(),
    // 登记侧版本（写保护；人裁 fail-closed）：必填，缺则 400。
    // ⚠️ **必须带上界** `.max(2147483647)`（int4 上限）：这个值会被绑进 SQL 与 `version`（int4 列）
    //    比较，无上界时 `3000000000` 这类**客户端可控**的取值会让 Postgres 报 22003、被兜成 500
    //    ——契约是「非法入参 ⇒ 400」，且 5xx 会污染监控。**闭区间**：int4 上限本身合法（仍走比对）。
    //    （DELETE 的同名字段**不需要**上界：它只在 JS 里与 `row.version` 比较，从不进 SQL。）
    expectedVersion: z.number().int().positive().max(2147483647),
  }).strict()

  // ── 页门改动（管理面动作：页门/发布/回收之「页门」「发布」）─────────────────────────
  // 发布 = requiredScope 置 null；改页门 = 换成新 scope。**没有独立的 published 列**
  // （见函数头顶注与计划 Global Constraints 1）。
  // ⚠️ 写保护（spec §3③）：**版本从请求体取**（`expectedVersion`，必填——fail-closed 人裁
  //    2026-09-29），条件更新（`version = expectedVersion` 才落）。Task 1 的过渡形态是
  //    「handler 先读版本再传进去」——那等于守卫自己给自己盖章（并发写都命中），本任务已换掉。
  r.put('/reports/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = GateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    // ── 平台自绘行：改页门入口**已下线**（月报重做 Task 10；设计 §8.2）────────────────────
    // 自绘行的页门是**发布时从面板派生**并随快照钉死的（见 domain/report-version.ts）。若还允许
    // 这里直接改 `requiredScope`，产出两种不一致态：①「发布了却没有版本行」——独立链接
    // 读不到快照；②行上的页门与线上快照不同步——独立链接按快照判权，改了行也不生效。
    // ⇒ 平台行走 `POST /reports/:id/publish` / `unpublish`；metabase 行（没有面板可派生、
    // 也没有版本通路）保持现状。
    // ⚠️ 读 `current` 在**锁外**：陈旧由 `expectedVersion` 兜（条件 UPDATE 落空 ⇒ 409），不会写错。
    const current = await getReport(ctx.pool, org, id)
    if (current === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 资产写权限（#1325）：owner ∪ data:manage。先于渲染器分流判，免给非 owner 存在性/形态探针。
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    if (current.renderer === 'platform') return c.json({ error: 'USE_PUBLISH_ENDPOINT' }, 409)
    const effectiveScope = parsed.data.requiredScope
    // ── 每对象一把锁（spec §3③）：条件 UPDATE + 「陈旧时分清 404/409」的二次读**同锁**，
    //    否则两次读之间夹一次并发写会拿到互相矛盾的版本。键用行 id（写对象已在，id 才是身份）。
    return await withObjectLock(`${org}/row:${id}`, async () => {
      const row = await updateRequiredScope(ctx.pool, org, id, effectiveScope, parsed.data.expectedVersion)
      if (row === null) {
        // 存储层把「不存在 / 跨租户 / 版本陈旧」合流成 null（不给存在性探针）⇒ 这里再查一次分清楚。
        // 带 org 查（跨租户在这里同样得 null ⇒ 404，不泄漏别的租户有没有这一行）。
        const cur = await getReportVersion(ctx.pool, org, id)
        if (cur === null) return c.json({ error: 'NOT_FOUND' }, 404)
        return c.json({ error: 'STALE_WRITE', currentVersion: cur }, 409)
      }
      // 成功响应回带**推进后**的版本（调用方据此续写下一次，无需再读一次）
      return c.json({
        id: row.id, title: row.title, requiredScope: row.requiredScope,
        renderer: row.renderer, version: row.version,
      })
    })
  })

  // ── 部门门（spec §3.4；#1173）：**两种渲染器同一入口** ─────────────────────────────
  // 为什么不并进 `GateBody`：那个端点对**平台自绘行**已下线（409 USE_PUBLISH_ENDPOINT），而部门门
  // 恰恰在自绘行上也要能改（console 的「报表页门配置权限时可选组织架构」）。为什么不并进
  // `PUT /reports/:id/spec`：部门门不是规格的一部分（规格是内容，门是授权），混在一个 body 里
  // 会让「只改门」也必须回带整份 spec——一次误覆盖就能把内容改掉。
  //
  // 两种行的生效时机**不同**，与既有的页门口径一致，别抹平：
  //   · metabase 行：行上就是生效值，改完立刻生效；
  //   · platform 行：**已发布**行的线上门归快照（`report_versions.required_depts`），改行只影响
  //     草稿预览与**下一次发布**；未发布行改完即生效。已发出的独立链接不会因为这次改动
  //     悄悄换门——这正是「页门跟快照走」要保证的。
  const DeptGateBody = z.object({
    requiredDepts: z.array(z.string().min(1)).max(200).nullable(),
    // 与 GateBody 同款上界（int4）：值会绑进 SQL 与 version 列比较
    expectedVersion: z.number().int().positive().max(2147483647),
  }).strict()

  // ── 资产级共享（spec 2026-11-01 §4）：谁能看这条资产 ────────────────────────────
  // 授权：**owner 或模块管理码**；管理员代管留 `asset_audit.by_admin=true`。
  // 声明 **data:query** 而不是 data:manage：owner 未必持管理码——那是本功能存在的理由。
  // 真判据在 handler 的 canEditAsset（单一实现），门卫只挡匿名/无关者。
  r.get('/reports/:id/acl', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const org = c.get('tenant').casdoor_org
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const acl = await loadAssetAcl(ctx.pool, org, id)
    if (!canEditAsset(acl, requester, MANAGE_SCOPE)) {
      return c.json({ error: 'FORBIDDEN', need: 'owner_or_' + MANAGE_SCOPE }, 403)
    }
    return c.json({
      visibility: row.visibility,
      owner: acl.find((a) => a.relation === 'owner')?.subjectId ?? null,
      viewers: acl.filter((a) => a.relation === 'viewer')
        .map((a) => ({ subjectType: a.subjectType, subjectId: a.subjectId })),
    })
  })

  r.put('/reports/:id/acl', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const org = c.get('tenant').casdoor_org
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = z.object({
      viewers: z.array(z.object({
        subjectType: z.enum(['user', 'dept', 'scope']),
        subjectId: z.string().min(1),
      })).max(200),
    }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const row = await getReport(ctx.pool, org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const acl = await loadAssetAcl(ctx.pool, org, id)
    if (!canEditAsset(acl, requester, MANAGE_SCOPE)) {
      return c.json({ error: 'FORBIDDEN', need: 'owner_or_' + MANAGE_SCOPE }, 403)
    }

    // 部门受让方必须真实存在（fail-closed：配了也永远命不中的门不如当场拒）
    const deptIds = parsed.data.viewers.filter((v) => v.subjectType === 'dept').map((v) => v.subjectId)
    if (deptIds.length > 0) {
      const gate = await validateDeptGate(ctx.pool, c.get('tenant').id, deptIds)
      if (!gate.ok) {
        return c.json(
          { error: gate.code, ...(gate.unknown ? { unknown: gate.unknown } : {}) },
          gate.code === 'ORG_NOT_SYNCED' ? 409 : 400,
        )
      }
    }

    // 点名的用户受让方同样必须真实可用（#1335）：与部门门同一 fail-closed 口径。
    // 去重后再查（同一人重复点名不重复打 Casdoor）；unknown（未注入/上游不可达）放行。
    const userIds = [...new Set(
      parsed.data.viewers.filter((v) => v.subjectType === 'user').map((v) => v.subjectId),
    )]
    const unknownUsers: string[] = []
    for (const u of userIds) {
      if (await userStatusOf(ctx, org, u) === 'inactive') unknownUsers.push(u)
    }
    if (unknownUsers.length > 0) {
      return c.json({ error: 'UNKNOWN_USER', unknown: unknownUsers }, 400)
    }

    const viewers: AclRow[] = parsed.data.viewers.map((v) => ({
      subjectType: v.subjectType as AclSubjectType,
      subjectId: v.subjectId,
      relation: 'viewer' as const,
    }))
    await replaceViewers(ctx.pool, org, id, viewers, requester.userId)
    await writeAssetAudit(ctx.pool, {
      org, assetId: id, actor: requester.userId, action: 'acl.update',
      detail: { viewers }, byAdmin: isAdminOverride(acl, requester, MANAGE_SCOPE),
    })
    return c.json({ ok: true, viewers: viewers.map((v) => ({ subjectType: v.subjectType, subjectId: v.subjectId })) })
  })

  // 所有者转移（spec §4.4）：离职/换负责人时**唯一 owner 换人**，旧 owner 不再有特权。
  // 授权 = canEditAsset（owner ∪ data:manage）；管理员代管记 by_admin。
  r.put('/reports/:id/owner', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const org = c.get('tenant').casdoor_org
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = z.object({ owner: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const row = await getReport(ctx.pool, org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const acl = await loadAssetAcl(ctx.pool, org, id)
    if (!canEditAsset(acl, requester, MANAGE_SCOPE)) {
      return c.json({ error: 'FORBIDDEN', need: 'owner_or_' + MANAGE_SCOPE }, 403)
    }
    // 目标账号必须真实可用（#1335）：转给拼错/停用的用户名 = 造出没人能管的资产。
    if (await userStatusOf(ctx, org, parsed.data.owner) === 'inactive') {
      return c.json({ error: 'UNKNOWN_OWNER' }, 400)
    }
    const from = acl.find((a) => a.relation === 'owner')?.subjectId ?? null
    await transferOwner(ctx.pool, org, id, parsed.data.owner, requester.userId)
    await writeAssetAudit(ctx.pool, {
      org, assetId: id, actor: requester.userId, action: 'owner.transfer',
      detail: { from, to: parsed.data.owner }, byAdmin: isAdminOverride(acl, requester, MANAGE_SCOPE),
    })
    return c.json({ ok: true, owner: parsed.data.owner })
  })

  r.put('/reports/:id/dept-gate', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = DeptGateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 先验门再落库：未知 ext_id ⇒ 400；org 表未同步 ⇒ 409（与创建通路同一份判定）
    const gateCheck = await validateDeptGate(ctx.pool, c.get('tenant').id, parsed.data.requiredDepts)
    if (!gateCheck.ok) {
      return c.json(
        { error: gateCheck.code, ...(gateCheck.unknown ? { unknown: gateCheck.unknown } : {}) },
        gateCheck.code === 'ORG_NOT_SYNCED' ? 409 : 400,
      )
    }
    const org = c.get('tenant').casdoor_org
    // 与 PUT /reports/:id、PUT /spec、DELETE 同键：同一行的「页门 / 部门门 / 规格 / 删」必须互斥
    return await withObjectLock(`${org}/row:${id}`, async () => {
      const current = await getReport(ctx.pool, org, id)
      if (current === null) return c.json({ error: 'NOT_FOUND' }, 404)
      // 资产写权限（#1325）：owner 可改自己报表的部门门。
      const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
      if (denied !== null) return denied
      // 页门原值回写（`updateGates` 要求两列同写）：锁内读到的值就是这一行此刻的值
      const row = await updateGates(
        ctx.pool, org, id,
        { requiredScope: current.requiredScope, requiredDepts: parsed.data.requiredDepts },
        parsed.data.expectedVersion,
      )
      if (row === null) {
        // 存储层把「不存在 / 跨租户 / 陈旧」合流成 null ⇒ 二次读分 404 / 409（同 PUT /reports/:id）
        const cur = await getReportVersion(ctx.pool, org, id)
        if (cur === null) return c.json({ error: 'NOT_FOUND' }, 404)
        return c.json({ error: 'STALE_WRITE', currentVersion: cur }, 409)
      }
      return c.json({ id: row.id, requiredDepts: row.requiredDepts, version: row.version })
    })
  })

  // ── 部门选择器的数据源（data:manage）：活节点平表 + 各节点直属人数 ─────────────────
  // 平表而不是嵌套树：前端已经有 `buildGroupTree` 同族的组装逻辑，且「门」的语义是 ext_id 集合，
  // 树形结构在这里没有额外信息。
  r.get('/reports/dept-options', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    // 数据源 = 宿主注入的组织架构平表（与通知模块的「按部门」选择器**同一份实现**）。
    // 模块不再自己查 platform schema（那条 SQL 2026-10-30 已下沉到
    // `apps/server/src/channel-address.ts` 的 `listOrgNodes`，本模块的 dataDependencies
    // 随之退役）。未注入 = 宿主装配缺陷 ⇒ 503，不静默回空表（那会让前端以为「组织架构没同步」）。
    const list = ctx.addresses?.listOrgNodes
    if (list === undefined) return c.json({ error: 'ORG_RESOLVER_UNAVAILABLE' }, 503)
    const depts = await list.call(ctx.addresses, c.get('tenant').casdoor_org)
    return c.json({ depts })
  })

  // ── 自绘规格读写（#391 计划 6 Task 3）────────────────────────────────────────────
  // 写 = 管理面动作（改规格就是改报表内容，与 PUT /reports/:id 同档）；读 = 观看面（Task 4 的
  // 渲染器从这取规格）。两端点都**不查 metabaseFromEnv**：自绘通路的可用性与 Metabase 配置
  // 完全无关（这正是 POST 里 platform 分支先于 503 检查的同一口径）。
  const SpecBody = z.object({
    // 形状由 parseReportSpec 白名单判（本层只保证「是个对象 + 版本必带 + 无多余键」）
    spec: z.record(z.unknown()),
    // 与 GateBody 同款上界（int4）：值会绑进 SQL 与 version 列比较，无上界 ⇒ 22003 被兜成 500
    // （客户端可控的取值不许污染 5xx；闭区间：int4 上限本身合法，仍走版本比对）。
    expectedVersion: z.number().int().positive().max(2147483647),
  }).strict()

  r.put('/reports/:id/spec', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = SpecBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 规格先过白名单再落库：库侧跨列 check 只判「platform 行 spec 非空」，不判形状——
    // 写路径若不判，垃圾规格（含可执行字段的旧形态）会静默入库（spec §3⑥ 要消灭的正是这个）。
    const spec = parseReportSpec(parsed.data.spec)
    if (!spec.ok) return c.json({ error: spec.code }, 400)
    const org = c.get('tenant').casdoor_org
    // ── 每对象一把锁：与 PUT /reports/:id、DELETE 同键（`${org}/row:${id}`）——同一行的
    //    页门改动 / 删行 / 改规格三类写必须互斥（「先读行分流 + 条件 UPDATE + 陈旧时二次读」
    //    全程同锁，否则两次读之间夹一次并发写会拿到互相矛盾的版本）。
    return await withObjectLock(`${org}/row:${id}`, async () => {
      // 先读行分流（updateSpec 把「不存在/跨租户/陈旧」合流成 null，不给存在性探针）：
      // 非自绘行在这里拦成 409，而不是让 updateSpec 撞库侧跨列 check 炸 500
      // （metabase 行 spec 必须-null 那半边——「非法入参 ⇒ 4xx」的契约位置）。
      const row = await getReport(ctx.pool, org, id)
      if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
      // 资产写权限（#1325）：owner 可改自己报表的规格；管理码照旧。
      const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
      if (denied !== null) return denied
      if (row.renderer !== 'platform') return c.json({ error: 'RENDERER_NOT_SELF_DRAWN' }, 409)
      // ── 页门归属：**已发布行的线上门归快照，草稿编辑不动它**（月报重做 Task 10 后续）─────
      // `required_scope` 在本文件有两个身份，靠「有没有发布指针」分开：
      //  · **未发布行**（`publishedVersionId === null`）：行上的 `required_scope` 就是**预览门**，
      //    没有快照可跟 ⇒ 沿用「改面板 ⇒ 页门跟着重派生」的同一 UPDATE（spec §4.2 / #764 P1
      //    Task 4），不留「新面板 + 旧页门」的可见窗口。
      //  · **已发布行**：线上门是**发布那一刻从面板派生、随快照钉死**的那份
      //    （`data.report_versions.required_scope`，见 domain/report-version.ts）；行上的值只是它
      //    的副本。草稿编辑是「改还没上线的内容」⇒ **只写 spec**（`updateSpec`），绝不回写派生值：
      //    回写会让线上门在草稿改动的瞬间跟着变（已经发出去的链接悄悄换了一道门），且行上与快照
      //    记录的页门不再同源。新页门等下一次发布/回滚时由发布门重新派生。
      // ⚠️ 派生不了时（**多码**）**保持页门原值、规格照存**——「存一份待修的多码草稿」是
      //    正常中间态，拒绝权在**发布门**（POST /reports/:id/publish）。未知指标 / 不可加 /
      //    未接入源不在此列：它们由下面 `validatePanelMetrics` 在**写入时**拒（与 MCP 提报面
      //    同一份判定）；已发布行的草稿编辑同样过这道校验（两条分支都验，发布门只是第二道）。
      const catalog = await loadMergedCatalog(ctx.pool, org)
      const adoptedSources = new Set(c.get(TENANT_SOURCES) ?? [])
      const metrics = validatePanelMetrics(spec.spec, catalog, adoptedSources)
      if (!metrics.ok) {
        // 与 POST 同档：源未接入 ⇒ 403；入参不成立（含 ai_text 的缺数据面板/缺期间）⇒ 400。
        // 后者的 reason 不带 metricId（整份规格不成立，没有单个面板可点名）⇒ 只回 `error`。
        return c.json(
          { error: metrics.reason, ...('metricId' in metrics ? { metricId: metrics.metricId } : {}) },
          metrics.reason === 'METRIC_SOURCE_NOT_ADOPTED' ? 403 : 400,
        )
      }
      let updated: { version: number } | null
      if (row.publishedVersionId === null) {
        // 页门同步派生只对**未发布行**做（已发布行的线上门归快照，见上）。
        const d = deriveRequiredScope(spec.spec, catalog)
        updated = await updateSpecAndScope(
          ctx.pool, org, id, spec.spec, d.ok ? d.requiredScope : row.requiredScope,
          parsed.data.expectedVersion,
        )
      } else {
        updated = await updateSpec(ctx.pool, org, id, spec.spec, parsed.data.expectedVersion)
      }
      if (updated === null) {
        const cur = await getReportVersion(ctx.pool, org, id)
        if (cur === null) return c.json({ error: 'NOT_FOUND' }, 404)
        return c.json({ error: 'STALE_WRITE', currentVersion: cur }, 409)
      }
      // 回带推进后的版本（调用方据此续写下一次，无需再读一次——与 PUT /reports/:id 同契约）
      return c.json({ version: updated.version })
    })
  })

  // ⚠️ 本端点**两种视角**（P5 Task 3 修复轮 Important）：console「打开」走的正是它
  //    （reports/index.tsx → SpecView），所以它对**非编辑者**同样是观看面，必须过渲染闸；
  //    而 owner ∪ data:manage（`canEditAsset`）需要能改规格 ⇒ 拿全量。
  //    判定顺序：canViewAsset（谁能看这份内容）→ canEditAsset 分档 → 渲染闸（口径可见性）。
  r.get('/reports/:id/spec', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const org = c.get('tenant').casdoor_org
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 数据门之二（行级，照 embed-url 的口径）：行上 required_scope 比页门更细——页门未放行的行
    // 对观看者不存在（403 带 need）。规格里的 metricId 可见性另由 /query 的语义裁剪兜底，
    // 但「这份规格存不存在」本身先过行门。
    // 部门门（spec §3.4）：有门才去解析用户部门（无门租户零额外查询，同 GET /reports）
    const specAcl = await loadAssetAcl(ctx.pool, org, row.id)
    const specDepts = (row.requiredDepts ?? []).length > 0 || specAcl.some((a) => a.subjectType === 'dept')
      ? await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      : undefined
    if (!canViewAsset(row, requester, specAcl, specDepts)) {
      return c.json({ error: 'FORBIDDEN', need: row.requiredScope }, 403)
    }
    // 渲染器通道守卫：metabase 行的「内容」在 Metabase 侧，没有可读的 spec（列必为 null）
    // ⇒ 显式 409，与 embed-url/edit-url 的守卫同族。
    if (row.renderer !== 'platform') return c.json({ error: 'RENDERER_NOT_SELF_DRAWN' }, 409)
    // 编辑者：全量（要能继续改规格——占位符会让编辑器不可用）。
    if (canEditAsset(specAcl, requester, MANAGE_SCOPE) || row.spec === null) {
      return c.json({ spec: row.spec, version: row.version, deniedPanels: [] })
    }
    // 观看者：与 published-spec 同一把渲染闸（口径不可见 ⇒ 原位剥成占位符；reveal 整表拒）。
    const render = await reportRenderGate(ctx.pool, requester, org, row.id, row.spec)
    if (render.blocked) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ spec: render.spec, version: row.version, deniedPanels: render.deniedPanels })
  })

  // ── 定义版本：发布 / 下线 / 回滚 / 历史 / 已发布快照 / 草稿（月报重做 Task 10）──────────────
  // 版本语义与五条不变量在 `domain/report-version.ts` 的头注。本层只负责：入参形状、身份、
  // HTTP 码映射、页门裁剪。
  //
  // ⚠️ 两个「版本」别混（设计 §3.3）：
  //   · `data.reports.version`         —— **草稿写入计数器**（`expectedVersion` 那条通路）
  //   · `data.report_versions.version` —— **已发布内容版本号**（`?v=N` / 历史 / 回滚）
  //   发布**不推进**草稿计数器——推了的话「无改动再发布」永远判成有改动（设计 §4.2 第 4 步）。
  const VersionBody = z.object({
    // 与 GateBody 同款上界：值会绑进 SQL 与 `version`（int4）比较，无上界 ⇒ 22003 被兜成 500
    expectedVersion: z.number().int().positive().max(2147483647),
    /** 发布/回滚备注（审计面；存储层再截 200 字符兜底）。 */
    note: z.string().max(200).default(''),
  }).strict()

  /** 路径里的版本号：非正 / 非整数 / 超 int4 ⇒ null（一律 404，同 reportIdOf：不给存在性探针）。 */
  const versionParamOf = (raw: string | undefined): number | null => {
    if (raw === undefined || !/^\d+$/.test(raw)) return null
    const n = Number(raw)
    return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null
  }

  /**
   * 发布类失败 → HTTP 码。**只把「找不到」与「版本陈旧」升格**；其余（规格 / 词表 / 源 /
   * 可加性）都是调用方可修的入参问题 ⇒ 400。⚠️ 渲染器不对也走 400：设计 §4.2 明写
   * `RENDERER_NOT_SELF_DRAWN` 是 400（发布动作打到没有版本通道的 metabase 行 = 用错端点）。
   */
  const statusOfVersionFailure = (reason: PublishErrorReason): 400 | 404 | 409 =>
    reason === 'NOT_FOUND' ? 404 : reason === 'STALE_WRITE' ? 409 : 400

  // 宿主投影的「本租户已接入源」。没投影（`undefined`）按「一个源都没接」处理——
  // 发布是写入动作，fail-closed：未接入源的指标宁可拒发布，也不上线（它的 `/query` 会 403）。
  // 写法是 `new Set(c.get(TENANT_SOURCES) ?? [])`（不抽 helper：各调用点一行，抽了要额外引 Context 类型）。

  // 发布前「谁能看到」预览（R6）：发布是不可逆的可见面变化，点确认前先把门解释清楚。
  // 只解释已配置的门（visibility/scope/dept/ACL），不枚举 Casdoor 成员（运行期解析，量可能很大）。
  r.get('/reports/:id/publish-preview', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    if (report.renderer !== 'platform') return c.json({ error: 'RENDERER_NOT_SELF_DRAWN' }, 409)
    if (report.spec === null) return c.json({ error: 'NO_SPEC' }, 409)
    const parsed = parseReportSpec(report.spec)
    if (!parsed.ok) return c.json({ error: 'INVALID_SPEC', detail: parsed.code }, 400)
    const catalog = await loadMergedCatalog(ctx.pool, org)
    const scope = deriveRequiredScope(parsed.spec, catalog)
    const acl = await loadAssetAcl(ctx.pool, org, id)
    const exposure = summarizeExposure({
      visibility: report.visibility,
      requiredScope: scope.ok ? scope.requiredScope : null,
      requiredDepts: report.requiredDepts ?? [],
      acl,
    })
    return c.json({
      report: {
        id, title: report.title, version: report.version,
        publishedVersion: report.publishedVersion,
      },
      gate: scope.ok
        ? { requiredScope: scope.requiredScope }
        : {
            error: scope.reason,
            detail: 'metricId' in scope ? scope.metricId : scope.scopes.join(','),
          },
      requiredDepts: report.requiredDepts ?? [],
      acl: acl.map((a) => ({ subjectType: a.subjectType, subjectId: a.subjectId, relation: a.relation })),
      exposure,
    })
  })

  r.post('/reports/:id/publish', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    // 资产写权限（#1325）：owner 可发布自己报表；管理码照旧。
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    // ── 发布门（P5 Task 2，spec 2026-11-12 §9.1）：受众 ⊆ 每个面板指标的可见范围 ─────────
    // 位置是契约的一半：**在 `publishVersion` 之前**（任何发布写入之前）——被拒 = 一条版本都不落。
    // `denyUnlessCanEdit` 内部已取过 ACL 但只做判定不回传；这里再取一次（单行查询），
    // 保持那个共享守卫的签名不变（14 个调用点不为本门改形）。
    // Metabase 行没有平台面板 ⇒ 函数内跳过并回 warning（真正的渲染器拒绝仍由
    // publishVersion 的 RENDERER_NOT_SELF_DRAWN 负责）。
    const gate = await reportScopeViolations({
      pool: ctx.pool,
      tenantId: c.get('tenant').id,
      org,
      report,
      acl: await loadAssetAcl(ctx.pool, org, id),
    })
    // 门的 warning 是 `string[]`，而 `publishVersion` 成功回包的 `warnings` 是发布 lint 的
    // `LintIssue[]`——**不合并两种形状**（评审 Minor）。门自己的提示走独立字段 `scopeWarnings`。
    const scopeWarnings = gate?.warnings ?? []
    if (gate !== null && gate.panels.length > 0) {
      return c.json({
        error: 'REPORT_METRIC_SCOPE_MISMATCH',
        panels: gate.panels,
        ...(scopeWarnings.length === 0 ? {} : { scopeWarnings }),
      }, 409)
    }
    const out = await publishVersion(
      ctx.pool, org, id, body.data.expectedVersion,
      requester.userId, body.data.note, new Set(c.get(TENANT_SOURCES) ?? []),
    )
    // 非阻断提示（Metabase 无法判定等）随成功/失败回包带出，调用方/巡检都看得见。
    if (!out.ok) {
      return c.json(
        scopeWarnings.length === 0 ? out : { ...out, scopeWarnings },
        statusOfVersionFailure(out.reason),
      )
    }
    return c.json(scopeWarnings.length === 0 ? out : { ...out, scopeWarnings })
  })

  r.post('/reports/:id/unpublish', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    // 先读行分流：① 不存在 / 跨租户 ⇒ 404；② **本来就没有已发布版本** ⇒ 幂等 200 unchanged
    // （设计 §4.3 末条：没有状态变化就不产生写——尤其不推进草稿计数器）。
    const current = await getReport(ctx.pool, org, id)
    if (current === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 资产写权限（#1325）：owner 可回收自己报表。
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    if (current.publishedVersionId === null) return c.json({ unpublished: true, unchanged: true })
    const ok = await unpublishVersion(ctx.pool, org, id, body.data.expectedVersion)
    if (!ok) {
      // 存储层把「陈旧 / 不存在 / 跨租户」合流成 false ⇒ 再查一次分 404 与 409（与 PUT 页门同口径）
      const cur = await getReportVersion(ctx.pool, org, id)
      if (cur === null) return c.json({ error: 'NOT_FOUND' }, 404)
      return c.json({ error: 'STALE_WRITE', currentVersion: cur }, 409)
    }
    return c.json({ unpublished: true })
  })

  r.post('/reports/:id/versions/:version/rollback', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const version = versionParamOf(c.req.param('version'))
    if (version === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = VersionBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    // 资产写权限（#1325）：owner 可回滚自己报表；管理码照旧。
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    const out = await rollbackVersion(
      ctx.pool, org, id, version, body.data.expectedVersion,
      requester.userId, body.data.note, new Set(c.get(TENANT_SOURCES) ?? []),
    )
    if (!out.ok) return c.json(out, statusOfVersionFailure(out.reason))
    return c.json(out)
  })

  r.get('/reports/:id/versions', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    // 先确认报表存在：直接列版本会把「不存在 / 跨租户」伪装成空历史（等于存在性探针）。
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 资产写权限（#1325）：历史版本属「未公开内容」，只有 owner ∪ 管理码可读。
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    // 列表只给元数据（正文快照走 /versions/:version —— 100 条 × 全量 spec 没有消费方）。
    const rows = await listVersions(ctx.pool, org, id)
    return c.json({
      versions: rows.map((row) => ({
        version: row.version,
        title: row.title,
        publishedAt: row.publishedAt,
        publishedBy: row.publishedBy,
        note: row.note,
        draftVersion: row.draftVersion,
        // 「线上用的是这一版」：比对指针的 id（同一 version 号在别的报表/租户上互不相干）
        isCurrent: row.id === report.publishedVersionId,
      })),
    })
  })

  r.get('/reports/:id/versions/:version', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const version = versionParamOf(c.req.param('version'))
    if (version === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    // 先确认报表存在再判资产写权限（#1325）：历史快照属未公开内容，owner ∪ 管理码可读。
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    // 存储层每条 SQL 都带 org ⇒ 跨租户与不存在同形（null ⇒ 404，不给存在性探针）。
    const row = await getVersion(ctx.pool, org, id, version)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 完整快照（含 spec）：供 review / 回滚确认。spec 原样返回——回填行未过当前白名单，
    // 「原样展示给人看」比「解析失败就 500」正确（要上线的走回滚，那里会重新校验）。
    return c.json({
      version: row.version, title: row.title, spec: row.spec, requiredScope: row.requiredScope,
      draftVersion: row.draftVersion, publishedAt: row.publishedAt, publishedBy: row.publishedBy,
      note: row.note,
    })
  })

  r.get('/reports/:id/published-spec', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const rawVersion = c.req.query('v')
    let version: number | undefined
    if (rawVersion !== undefined) {
      const parsedVersion = versionParamOf(rawVersion)
      if (parsedVersion === null) return c.json({ error: 'NOT_FOUND' }, 404)
      version = parsedVersion
    }
    const org = c.get('tenant').casdoor_org
    // ① 先在**本 org**里确认报表存在：不存在 / 跨租户一律 404（不给存在性探针）。
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // ①.5 资产面（spec 2026-11-01 §4.2：「列表/详情、导出/嵌入 URL **全部走 canViewAsset**」）。
    //     快照门管「已发布内容该给谁」，资产面管「这条资产该给谁」——两道都过才放行。
    //     `restricted` 行（新建默认）只有 owner/ACL 受让人可读；不过同样 404（不泄露存在性）。
    const assetAcl = await loadAssetAcl(ctx.pool, org, id)
    const assetDepts = assetAcl.some((a) => a.subjectType === 'dept')
      ? await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      : undefined
    // 粗门（scope/depts）由**下面的快照**判，资产面只看 visibility + ACL（见 canViewVersionedContent）。
    if (!canViewVersionedContent(report, requester, assetAcl, assetDepts)) {
      return c.json({ error: 'NOT_FOUND' }, 404)
    }
    // ② 再确认**有已发布版本**（下线总闸在存储层：`published_version_id is null` ⇒ 含 `?v=N`
    //    一律 null ⇒ NOT_PUBLISHED）。必须先到这一步，判权才有对象可依。
    const snapshot = await getPublishedSpec(ctx.pool, org, id, version)
    if (snapshot === null) return c.json({ error: 'NOT_PUBLISHED' }, 404)
    // ③ 页门**跟着快照走**（月报重做 Task 10 后续）：独立链接渲染的是这一版快照的内容，门也必须
    //    是**那一版**记下的 `required_scope`，不是当前行的 `visibleTo`——`?v=N` 钉住旧定义时，
    //    行上的页门可能已被后续发布改过（甚至变成 null），拿它判权会让旧链接越过本该有的门。
    //    ⚠️ 不通过同样回 **404**（与①同形）：403 会泄露「这个 id 已发布、且有一道你过不去的门」。
    if (snapshot.requiredScope !== null && !requester.hasScope(snapshot.requiredScope)) {
      return c.json({ error: 'NOT_FOUND' }, 404)
    }
    // ④ 部门门同样跟快照走（spec §3.4）：`?v=N` 钉住旧定义时判的是**那一版**记下的部门集。
    //    有门才解析用户部门（与上面同一惰性取法）；不通过同样回 404（不泄露门的存在）。
    if ((snapshot.requiredDepts ?? []).length > 0) {
      const depts = await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      if (!deptGatePasses(snapshot.requiredDepts, depts)) return c.json({ error: 'NOT_FOUND' }, 404)
    }
    // ⑤ 渲染闸（P5 Task 3，spec §9.2/§9.3）：报表门过了，面板里的**指标**还各有可见范围。
    //    不可见面板在原位替换为 `{ index, denied: true }`（不带数据字段），并回 `deniedPanels`；
    //    任一被拒指标 `reveal='report'` ⇒ 整表 404（与 not-found 同形，防「总数 − 其他」反推）。
    const render = await reportRenderGate(ctx.pool, requester, org, id, snapshot.spec)
    if (render.blocked) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ...snapshot, spec: render.spec, deniedPanels: render.deniedPanels })
  })

  r.get('/reports/:id/draft', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 资产写权限（#1325）：草稿是未公开内容，owner ∪ 管理码可读可改。
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    // 管理面（data:manage）：**不裁** visibleTo——页门未放行的草稿对管理员必须可见可改
    // （同 GET /reports/manage）。metabase 行的内容在 Metabase 侧，没有可读的 spec 列。
    if (report.renderer !== 'platform') return c.json({ error: 'RENDERER_NOT_SELF_DRAWN' }, 409)
    const published = report.publishedVersion === null
      ? null
      : await getVersion(ctx.pool, org, id, report.publishedVersion)
    return c.json({
      spec: report.spec,
      version: report.version,
      publishedVersion: report.publishedVersion,
      publishedAt: published?.publishedAt ?? null,
      // 「发布后又改过草稿没有」：唯一判据是草稿计数器越过了**那一版发布时**记下的
      // `draft_version`。⚠️ 别用「spec 与快照不等」判——jsonb 键序 / 旧白名单归一会让同内容
      // 看起来不同（稳定序列化只在发布幂等判据里用，且对象是解析后的 spec）。
      hasUnpublishedChanges:
        report.publishedVersionId !== null
        && report.version > (report.publishedDraftVersion ?? 0),
    })
  })

  // ── 审阅面（R2）：草稿 vs 已发布 + 说明书 + lint ────────────────────────────────────
  // 只读 spec 与词表，不查数：审阅人看的不是「结果对不对」，而是「改了什么、用了哪些口径、
  // 结构是否自洽」。授权口径同「改规格」：owner ∪ data:manage（非判权人给 404，不给探针）。
  r.get('/reports/:id/review', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const org = c.get('tenant').casdoor_org
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
    if (denied !== null) return denied
    if (report.renderer !== 'platform') return c.json({ error: 'RENDERER_NOT_SELF_DRAWN' }, 409)
    if (report.spec === null) return c.json({ error: 'NO_SPEC' }, 409)
    const parsed = parseReportSpec(report.spec)
    if (!parsed.ok) return c.json({ error: 'INVALID_SPEC', detail: parsed.code }, 400)
    const published = await getPublishedSpec(ctx.pool, org, id)
    const catalog = await loadMergedCatalog(ctx.pool, org)
    const review = buildReportReview(
      parsed.spec, published?.spec ?? null, catalog,
      report.title, published?.title ?? null,
    )
    return c.json({
      report: {
        id, title: report.title, version: report.version,
        publishedVersion: published?.version ?? null,
        publishedAt: published?.publishedAt ?? null,
      },
      ...review,
    })
  })

  // ── AI 文本（`ai_text`；设计 2026-10-26 §4；计划 Task 7）────────────────────────────
  // JSON 与 SSE 共用**同一份**上下文解析，差异只在「校验时机」（JSON 可重生成一次，SSE 只能
  // 整段 `replace`——都是 narrative.ts 的职责，路由不重复实现）。三条路由层硬约束：
  //  ① **页门跟快照走**（同 `GET /published-spec`）：已发布用**那一版**的 `required_scope`；
  //     `version` 钉旧版时也判旧版的门——行上的门可能已被后续发布改过。过不去同样 404。
  //  ② 草稿预览（`preview:'draft'`）是**未发布内容** ⇒ 只有 `data:manage`；其余人 404。
  //  ③ 事实包只经 `buildFacts`（→ `runQuery`，与 `/query` 同源）；**禁止**在这里另开 SQL。
  type NarrativeContextOk = {
    requester: Requester
    facts: FactBundle
    focus: AiTextPanel['focus']
    specKey: string
    model: (StreamingChatModel & { id?: string }) | null
  }

  /** 观看面内容的**共享解析**：身份 → 报表 → 资产面/快照门 → 规格。
   *  叙述（narrative）与计算凭证（receipt）共用这一份，避免两处各写一遍 ACL。 */
  type ViewSpecOk = {
    requester: Requester
    report: NonNullable<Awaited<ReturnType<typeof getReport>>>
    spec: ReportSpec
    specKey: string
    title: string
  }
  type ViewSpecErr = {
    error: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'NOT_PUBLISHED' | 'NO_SPEC' | 'RENDERER_NOT_SELF_DRAWN'
  }

  async function loadViewableSpec(
    c: Context<ModuleVars>, id: string, body: { version?: number; preview?: 'draft' },
  ): Promise<ViewSpecOk | ViewSpecErr> {
    const requester = requesterOf(c)
    if (requester === null) return { error: 'UNAUTHENTICATED' }
    const org = c.get('tenant').casdoor_org
    const report = await getReport(ctx.pool, org, id)
    if (report === null) return { error: 'NOT_FOUND' }
    // 资产面先于渲染器判定：restricted 行对非受让人一律 404（否则 RENDERER_NOT_SELF_DRAWN
    // 之类的非 404 会给非受让人当存在性探针用）。判据与 published-spec 同一份 canViewAsset。
    const acl = await loadAssetAcl(ctx.pool, org, id)
    const depts = acl.some((a) => a.subjectType === 'dept')
      ? await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      : undefined
    if (!canViewVersionedContent(report, requester, acl, depts)) return { error: 'NOT_FOUND' }
    if (report.renderer !== 'platform') return { error: 'RENDERER_NOT_SELF_DRAWN' }

    if (body.preview === 'draft') {
      // 草稿 = 未发布内容（同 `GET /reports/:id/draft` 的分档）：owner ∪ 管理码才可预览，其余 404。
      if (!canEditAsset(acl, requester, MANAGE_SCOPE)) return { error: 'NOT_FOUND' }
      if (report.spec === null) return { error: 'NO_SPEC' }
      return { requester, report, spec: report.spec, specKey: `draft:${report.version}`, title: report.title }
    }
    const snapshot = body.version !== undefined
      ? await getPublishedSpec(ctx.pool, org, id, body.version)
      : await getPublishedSpec(ctx.pool, org, id)
    if (snapshot === null) return { error: 'NOT_PUBLISHED' }
    if (snapshot.requiredScope !== null && !requester.hasScope(snapshot.requiredScope)) {
      return { error: 'NOT_FOUND' }
    }
    // 部门门同样跟快照走（spec §3.4）：内容是报表的一部分，门不过就没有内容可看。
    if ((snapshot.requiredDepts ?? []).length > 0) {
      const snapshotDepts = await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      if (!deptGatePasses(snapshot.requiredDepts, snapshotDepts)) return { error: 'NOT_FOUND' }
    }
    // 渲染闸（P5 Task 3）：叙述/计算凭证与 spec 读面**共用同一个观看者门**。
    //   · `reveal='report'` 的指标不可见 ⇒ 整表拒（不能从 AI 文本 / 计算凭证绕开）；
    //   · 其余被拒面板 ⇒ 用 `factsSpecOf` 把它们换成**空文本面板**：事实装配天然跳过 text，
    //     被拒口径的**标题**不会经 `missing.push(p.title)` 进 LLM prompt，也不再多打一次必被
    //     403 的 `/query`。回包不返回这份 specs（只用于内部事实装配）。
    const render = await reportRenderGate(ctx.pool, requester, org, id, snapshot.spec)
    if (render.blocked) return { error: 'NOT_FOUND' }
    return {
      requester, report,
      spec: render.deniedPanels.length === 0 ? snapshot.spec : factsSpecOf(render.spec),
      specKey: `published:${snapshot.version}`, title: snapshot.title,
    }
  }

  async function loadNarrativeContext(
    c: Context<ModuleVars>, id: string, body: z.infer<typeof NarrativeBody>,
  ): Promise<NarrativeContextOk | NarrativeContextErr> {
    const v = await loadViewableSpec(c, id, body)
    if ('error' in v) return { error: v.error }
    const panel = v.spec.panels[body.panelIndex]
    if (panel === undefined || panel.chart !== 'ai_text') return { error: 'NOT_AI_TEXT_PANEL' }

    const facts = await buildFacts(
      {
        pool: ctx.pool,
        org: c.get('tenant').casdoor_org,
        requester: v.requester,
        // `[]` = 「本租户一个源都没接」（宿主投影了空集），与「宿主没投影」同形——事实包
        // 的源裁剪输入必须显式给（见 `FactsDeps.adoptedSources`）。
        adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
        execute: ctx.execute,
        ...(ctx.exploreExec === undefined ? {} : { exploreExec: ctx.exploreExec }),
        reportTitle: v.title,
        specKey: v.specKey,
      },
      v.spec,
      body.panelIndex,
      body.period,
      body.branchNum,
    )

    // 未配 LLM ⇒ null（模板回退，`fallback:true`）——不是错误路径。
    const cfg = llmFromEnv()
    const model = ctx.llm !== undefined
      ? ctx.llm()
      : cfg === null ? null : { ...openAiCompatModel(cfg), id: cfg.model }
    return { requester: v.requester, facts, focus: panel.focus, specKey: v.specKey, model }
  }

  r.post('/reports/:id/narrative', async (c) => {
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = NarrativeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const started = Date.now()
    try {
      const n = await loadNarrativeContext(c, id, body.data)
      if ('error' in n) return c.json(n, narrativeErrorStatus(n))
      const out = await generateNarrative({
        pool: ctx.pool,
        org: c.get('tenant').casdoor_org,
        reportId: id,
        specKey: n.specKey,
        panelIndex: body.data.panelIndex,
        facts: n.facts,
        focus: n.focus,
        userId: n.requester.userId,
        model: n.model,
        // 失败原因只进日志（#1083：此前没接线，回退在生产里完全不可诊断）。
        log: (m) => console.warn(`[data/narrative] ${id} ${m}`),
      })
      // 运行台账（R5）：best-effort，不阻塞响应。
      void recordNarrativeRun(ctx.pool, {
        org: c.get('tenant').casdoor_org, reportId: id, focus: n.focus,
        mode: n.facts.dailyReview?.mode ?? 'day', model: n.model?.id ?? null,
        promptVersion: NARRATIVE_PROMPT_VERSION,
        outcome: out.cached ? 'cached' : out.fallback ? 'fallback' : 'ok',
        reason: out.fallback ? 'template_fallback' : null,
        durationMs: Date.now() - started,
      })
      return c.json(out)
    } catch (e) {
      console.error(`[data/narrative] ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
      // 详情**不回显**（可能含上游请求片段/凭证）；只截断进 body 给排障，完整原因在日志。
      return c.json(
        { error: 'NARRATIVE_FAILED', detail: e instanceof Error ? e.message.slice(0, 200) : undefined },
        502,
      )
    }
  })

  r.post('/reports/:id/narrative/stream', async (c) => {
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = NarrativeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    let n: NarrativeContextOk | NarrativeContextErr
    try {
      n = await loadNarrativeContext(c, id, body.data)
    } catch (e) {
      return c.json(
        { error: 'NARRATIVE_FAILED', detail: e instanceof Error ? e.message.slice(0, 200) : undefined },
        502,
      )
    }
    if ('error' in n) return c.json(n, narrativeErrorStatus(n))

    const started = Date.now()
    const streamOrg = c.get('tenant').casdoor_org
    let outcome: NarrativeOutcome = 'error'
    let outcomeReason: string | null = 'stream_failed'
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const send = (ev: NarrativeEvent) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
        try {
          for await (const ev of streamNarrative({
            pool: ctx.pool,
            org: c.get('tenant').casdoor_org,
            reportId: id,
            specKey: n.specKey,
            panelIndex: body.data.panelIndex,
            facts: n.facts,
            focus: n.focus,
            userId: n.requester.userId,
            model: n.model,
            log: (m) => console.warn(`[data/narrative] ${id} ${m}`),
          })) {
            if (ev.type === 'done') {
              outcome = ev.fallback ? 'fallback' : ev.cached ? 'cached' : 'ok'
              outcomeReason = ev.fallback ? 'template_fallback' : null
            } else if (ev.type === 'error') {
              outcome = 'error'
              outcomeReason = ev.reason
            } else if (ev.type === 'replace') {
              outcomeReason = ev.reason === 'number_check' ? 'number_check' : 'llm_failed'
            }
            send(ev)
          }
        } catch (e) {
          console.error(`[data/narrative] ${id} stream failed: ${e instanceof Error ? e.message : String(e)}`)
          // 流已开（200 已发）⇒ 只能用事件收敛状态，改不了状态码。
          send({ type: 'error', reason: 'NARRATIVE_FAILED' })
        } finally {
          await recordNarrativeRun(ctx.pool, {
            org: streamOrg, reportId: id, focus: n.focus,
            mode: n.facts.dailyReview?.mode ?? 'day', model: n.model?.id ?? null,
            promptVersion: NARRATIVE_PROMPT_VERSION,
            outcome, reason: outcomeReason,
            durationMs: Date.now() - started,
          })
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        // 关掉 nginx 一类反代的响应缓冲：不关的话 delta 会被攒成一次性大块（「流式」名存实亡）。
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  })

  // 叙事质量面板数据（R5）：回退率 / 分布 / p95。管理面（观测口径，不是业务数据）。
  r.get('/reports/narrative-stats', async (c) => {
    if (requesterOf(c) === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const raw = Number(c.req.query('days') ?? '7')
    const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.trunc(raw))) : 7
    return c.json(await narrativeStats(ctx.pool, c.get('tenant').casdoor_org, days))
  })

  // ── 计算凭证（R1）──────────────────────────────────────────────────────────────────
  // 只服务 **kpi 面板**：凭证回答「这一个数怎么来的」。取数只经 runQuery（授权/掩码/审计
  // 与 /query 同链）；组成（按日）只对可加指标给，比率不给——宁缺，不给误导性组成。
  const ReceiptBody = z.object({
    panelIndex: z.number().int().min(0),
    period: PeriodSchema,
    branchNum: z.string().min(1).max(64).optional(),
    version: z.number().int().positive().optional(),
    preview: z.literal('draft').optional(),
    /** 用户手工算出的数；给了才做差异分解（不影响凭证本身）。 */
    userValue: z.number().finite().optional(),
  }).strict()

  type ReceiptErr = { error: string; status: 400 | 403 | 404 | 409 | 502; detail?: string }

  type ReceiptTarget = {
    requester: Requester
    org: string
    panel: Extract<ReportSpec['panels'][number], { chart: 'kpi' }>
    range: DateRange
    args: Record<string, unknown>
    metric: NonNullable<Awaited<ReturnType<typeof loadMergedCatalog>>[number]>
  }

  /** 凭证/明细导出的共享装配：ACL → 面板 → 窗口 → 指标。只做解析，不取数。 */
  async function receiptTarget(
    c: Context<ModuleVars>, id: string, body: z.infer<typeof ReceiptBody>,
  ): Promise<{ ok: true; target: ReceiptTarget } | { ok: false; error: ReceiptErr }> {
    const v = await loadViewableSpec(c, id, body)
    if ('error' in v) {
      const status = v.error === 'UNAUTHENTICATED' ? 403
        : (v.error === 'NOT_FOUND' || v.error === 'NOT_PUBLISHED') ? 404 : 400
      return { ok: false, error: { error: v.error, status } }
    }
    const panel = v.spec.panels[body.panelIndex]
    if (panel === undefined || panel.chart !== 'kpi') {
      return { ok: false, error: { error: 'PANEL_NOT_KPI', status: 400 } }
    }
    let range: DateRange
    try {
      range = periodRangeOf(body.period, new Date())
    } catch {
      return { ok: false, error: { error: 'INVALID_PERIOD', status: 400 } }
    }
    const org = c.get('tenant').casdoor_org
    const metric = (await loadMergedCatalog(ctx.pool, org)).find((m) => m.id === panel.metricId)
    if (metric === undefined) return { ok: false, error: { error: 'METRIC_NOT_FOUND', status: 404 } }
    return {
      ok: true,
      target: {
        requester: v.requester, org, panel, range,
        args: panelArgsOf(panel, range, body.branchNum), metric,
      },
    }
  }

  /** 取数依赖：凭证/导出共用一份（授权/掩码/审计与 /query 同链）。 */
  const receiptDeps = (c: Context<ModuleVars>): QueryDeps => ({
    pool: ctx.pool,
    execute: ctx.execute,
    adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
  })

  async function receiptOf(
    c: Context<ModuleVars>, id: string, body: z.infer<typeof ReceiptBody>,
  ): Promise<{ ok: true; receipt: ReportReceipt } | { ok: false; error: ReceiptErr }> {
    const t = await receiptTarget(c, id, body)
    if (!t.ok) return t
    const { target } = t
    const out = await buildReportReceipt(
      receiptDeps(c), target.org, target.requester,
      {
        panel: target.panel,
        range: target.range,
        args: target.args,
        ...(body.branchNum === undefined ? {} : { branchNum: body.branchNum }),
        ...(body.userValue === undefined ? {} : { userValue: body.userValue }),
        metric: target.metric,
      },
    )
    if (!out.ok) {
      return {
        ok: false,
        error: out.reason === 'denied'
          ? { error: 'FORBIDDEN', status: 403, detail: out.detail }
          : { error: 'QUERY_FAILED', status: 502 },
      }
    }
    return { ok: true, receipt: out.receipt }
  }

  r.post('/reports/:id/receipt', async (c) => {
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = ReceiptBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    try {
      const out = await receiptOf(c, id, body.data)
      if (!out.ok) return c.json({ error: out.error.error, ...(out.error.detail === undefined ? {} : { detail: out.error.detail }) }, out.error.status)
      return c.json(out.receipt)
    } catch (e) {
      console.error(`[data/receipt] ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
      return c.json({ error: 'RECEIPT_FAILED' }, 502)
    }
  })

  r.post('/reports/:id/receipt/export', async (c) => {
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = ReceiptBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const out = await receiptOf(c, id, body.data)
    if (!out.ok) return c.json({ error: out.error.error, ...(out.error.detail === undefined ? {} : { detail: out.error.detail }) }, out.error.status)
    // 没有按日组成（比率/不可加）⇒ 不导出：导出「没有组成」的凭证只会让人以为能复算。
    if (out.receipt.series === null) return c.json({ error: 'NO_SERIES' }, 409)
    const filename = `receipt-${out.receipt.metric.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${out.receipt.window.from}_${out.receipt.window.to}.csv`
    return c.body(receiptCsv(out.receipt), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    })
  })

  // 明细**行**导出（R1 收尾）：按日组成够按期对账，逐笔核对要下钻行。
  // 只复用 runDetailQuery（授权/掩码/审计/行数闸都在它里面）；分页硬上限见 domain。
  r.post('/reports/:id/receipt/detail', async (c) => {
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = ReceiptBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const t = await receiptTarget(c, id, body.data)
    if (!t.ok) return c.json({ error: t.error.error, ...(t.error.detail === undefined ? {} : { detail: t.error.detail }) }, t.error.status)
    const out = await exportDetailCsv(
      receiptDeps(c), t.target.org, t.target.requester, t.target.panel.metricId, t.target.args,
    )
    if (!out.ok) {
      const status = out.reason === 'not_supported' ? 409 : out.reason === 'denied' ? 403 : 502
      const error = out.reason === 'not_supported' ? 'DETAIL_NOT_AVAILABLE'
        : out.reason === 'denied' ? 'FORBIDDEN' : 'QUERY_FAILED'
      return c.json({ error, ...(out.detail === undefined ? {} : { detail: out.detail }) }, status)
    }
    const filename = `detail-${t.target.panel.metricId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${t.target.range.from}_${t.target.range.to}.csv`
    return c.body(out.out.csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      // 导出不完整时必须可辨（前端据此提示「只导出了前 N 行」）。
      'x-row-count': String(out.out.rows),
      'x-truncated': String(out.out.truncated),
    })
  })

  // ── 编辑页入口（spec §3⑦：把 Metabase 编辑页经反代搬进后台）─────────────────────────
  // 判定只能在这里做（登记表只有模块能读）；签一枚 120s 一次性票据，身份由**专用入口**的反代替换
  // 成它自己的 host-only Cookie（平台会话 Cookie 不设 Domain、不扩散）。
  r.get('/reports/:id/edit-url', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    // ⚠️ fail-closed（评审 I-3）：缺配/形状不对一律 503——**不许** `?? ''` 用空密钥签票据，
    //    也不许把非 https 或带尾斜杠的 origin 直接拼进 URL。
    const proxyOrigin = process.env.MB_PROXY_PUBLIC_ORIGIN?.trim().replace(/\/+$/, '')
    const sessionSecret = process.env.PLATFORM_SESSION_SECRET ?? ''
    if (!proxyOrigin || !proxyOrigin.startsWith('https://') || sessionSecret.length < 32) {
      return c.json({ error: 'EDIT_PROXY_UNCONFIGURED' }, 503)
    }
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 资产写权限（#1325）：owner 可编辑自己报表；管理码照旧。
    const denied = await denyUnlessCanEdit(c, ctx.pool, requester, c.get('tenant').casdoor_org, id)
    if (denied !== null) return denied
    // platform 自绘行没有 Metabase dashboard（metabaseId=0 是哨兵）⇒ 没有可编辑的页
    if (row.renderer === 'platform') return c.json({ error: 'RENDERER_NOT_EDITABLE' }, 409)
    // 票据只绑 org + 单张 dashboard（不绑用户）：代理侧只按这两个维度授权，用户维度由本端点的
    // `data:manage` 页门把关。残余风险（同租户成员截获票据后 120s 内使用）由「短 TTL + 一次性
    // nonce + 入口即清 t + no-referrer」共同压缩——见 Task 3 与 spec §3⑦。
    const t = signEditHandoff(
      { org: requester.orgId, did: row.metabaseId, nonce: randomUUID() },
      sessionSecret,
    )
    return c.json({ url: `${proxyOrigin}/handoff?t=${t}` })
  })

  r.get('/reports/:id/embed-url', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const org = c.get('tenant').casdoor_org
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const row = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
    if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 数据门之二（行级）：行上 required_scope 比页门更细；部门门在此叠加（spec §3.4）
    const embedAcl = await loadAssetAcl(ctx.pool, org, row.id)
    const embedDepts = (row.requiredDepts ?? []).length > 0 || embedAcl.some((a) => a.subjectType === 'dept')
      ? await userDeptClosure(ctx.pool, c.get('tenant').id, deptNamesOf(requester))
      : undefined
    if (!canViewAsset(row, requester, embedAcl, embedDepts)) {
      return c.json({ error: 'FORBIDDEN', need: row.requiredScope }, 403)
    }

    // 渲染器通道守卫：platform 行没有 Metabase dashboard（metabaseId=0 是哨兵），给它签 token
    // = 签一张**指向不存在 dashboard 的死链**。显式 409，等平台自绘渲染通路（计划 4）接上后
    // 由前端按 renderer 走另一条观看通道。
    if (row.renderer === 'platform') {
      return c.json({ error: 'RENDERER_NOT_EMBEDDABLE' }, 409)
    }

    // ★★ 安全论断的落点：locked.tenant 恒 = 调用者身份里的 org。
    //    · 查询串/请求体里的 tenant **从不读取**（本 handler 里没有任何 c.req.query('tenant')）；
    //    · 展开顺序也钉死：平台值放**最后**，即便库里被手工塞了一条带 tenant 的 embed_params
    //      也覆盖不了平台值（纵深防御，不只靠写入侧的那道 400）。
    //    为什么取 requester.orgId 而不是 c.get('tenant').casdoor_org：锁进 token 的是
    //    「以哪个租户的视角看数据」，必须以**调用者身份**的 org 为准，绝不展示身份之外 org 的数据。
    const locked = { ...row.embedParams, [TENANT_SLUG]: requester.orgId }
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
    // ⚠️ 这里**不查** `metabaseFromEnv()`（#494）：自绘行根本不碰 Metabase，cfg 检查下沉到
    //    renderer 分支内（惰性取，真要归档才要它）——与 POST 的「先判分支、再查环境」同序。
    //    修前顺序反了：cfg 检查在 id 解析之前，「自绘可用 + Metabase 未配」的私有化形态里
    //    自绘报表建得出来、一按回收就 503（回收功能整体不可用）。由 routes 测试
    //    「不设 DATA_METABASE_* 时自绘行仍可删」钉住。
    const id = reportIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 登记侧版本（写保护，spec §3③）：DELETE 走**查询串**（无 body）——`?expectedVersion=N`。
    // 缺/非正整数 ⇒ 400（fail-closed：不接受「省略 = 强制删」）。**先验参再落库**：非法的版本
    // 是调用方缺陷，不该先花一次查询；与 PUT 的「body 先 parse 再查库」同序。
    const expectedVersion = Number(c.req.query('expectedVersion'))
    if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const org = c.get('tenant').casdoor_org
    // ── 每对象一把锁（spec §3③）：DELETE 是「JS 比较版本 + 无条件删行」（Task 3 的已知窗口）——
    //    「读版本 → 比较 → 删行」三步同锁后，与 PUT 的「条件 UPDATE」互斥。键与 PUT 同源
    //    （`${org}/row:${id}`）：同一行的删与改必须串行。
    return await withObjectLock(`${org}/row:${id}`, async () => {
      const row = await getReport(ctx.pool, org, id)
      if (row === null) return c.json({ error: 'NOT_FOUND' }, 404)
      // 资产写权限（#1325）：owner 可删自己报表；管理码照旧。
      const denied = await denyUnlessCanEdit(c, ctx.pool, requester, org, id)
      if (denied !== null) return denied
      // ⚠️ **版本判定必须发生在 `archiveDashboard` 之前**（Task 3 硬约束）：本端点是「先归档、再删行」
      //    的两步序列（顺序见下），版本守卫若挪到归档后，被拒的请求**已经改过 Metabase** ——
      //    「拒」就只剩一个响应码。由 routes/reports.test.ts 的「陈旧 ⇒ 409 且 mb.state.calls 为空」钉住。
      //    版本取**这一行**（`row.version`，本次请求唯一一次读）而不是再发一次 getReportVersion：
      //    两次读之间夹一次并发写就会拿到两个版本号，单一读是更强的判据。
      if (row.version !== expectedVersion) {
        return c.json({ error: 'STALE_WRITE', currentVersion: row.version }, 409)
      }

      // renderer=platform（终审修复 3）：没有 Metabase dashboard 可归档（metabaseId=0 是哨兵，
      // 拿它发 PUT 只会 404 ⇒ 删除恒 502）——跳过归档，登记行删除照旧。
      // cfg 检查在 renderer 判定**之后**（#494）：metabase 行没配 Metabase 才 503（配置状态
      // 排在 404/400/409 这些「调用方缺陷/行状态」之后，与 POST/PUT 的先验参再查环境同序）。
      if (row.renderer !== 'platform') {
        const cfg = metabaseFromEnv()
        if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
        const deps = metabaseDeps(cfg)
        try {
          // 先归档、再删行。顺序不能倒：只删登记行而把 dashboard 留在可嵌入集里 ⇒ 它恒出现在
          // 对账的 unregistered 差集里（一条永远消不掉的噪声）。反过来先归档、删行失败 ⇒
          // 登记行还在，对账会把它报成 missingInMetabase（可恢复的、显式可见的状态）。
          // M-1：本顺序由 routes/reports.test.ts 的「先归档后删行」用例 + 变异回归钉住。
          // ⚠️ 归档只按 id（不按名）：id 就是创建时那次 `dashboardName(org, title)` upsert 的返回值，
          //    命名空间一致性由 POST 那一处保证（少一处口径就留一条串味路径）。
          await archiveDashboard(deps, row.metabaseId)
        } catch (err) {
          if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
          throw err
        }
      }
      await deleteReport(ctx.pool, org, row.id)
      return c.body(null, 204)
    })
  })

  r.post('/reports/reconcile', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const cfg = metabaseFromEnv()
    if (!cfg) return c.json({ error: 'METABASE_UNCONFIGURED' }, 503)
    const org = c.get('tenant').casdoor_org
    const rows = await listReports(ctx.pool, org)
    // 登记侧取**全部租户**的并集（I-2）：只算本 org 会把别人的 dashboard 恒报成本租户未登记。
    const allRows = await listAllReports(ctx.pool)
    const deps = metabaseDeps(cfg)
    let embeddable: { id: number; name: string }[]
    try {
      // 正规可观测面（spec §6.5）：**别看 iframe**——报表被 unpublish 后嵌入方显示什么
      // 官方没有任何说明，属不可观测面。
      embeddable = await listEmbeddableDashboards(deps)
    } catch (err) {
      if (err instanceof MetabaseError) return c.json({ error: 'METABASE_ERROR' }, 502)
      throw err
    }

    // ── 差集①：本 org 的登记行指向的 dashboard 在可嵌入集里找不到（按 id 求差，判据本来是对的）。
    // renderer=platform 的行**不进差集**（终审修复 3，与下方回读循环同款守卫）：它的 metabaseId=0
    // 是哨兵不是真 id，比对只会产出一条永远消不掉的 missingInMetabase 噪声。
    const embeddableIds = new Set(embeddable.map((d) => d.id))
    const missingInMetabase = rows
      .filter((r) => r.renderer !== 'platform' && !embeddableIds.has(r.metabaseId))
      .map((r) => ({ id: r.id, title: r.title, metabaseId: r.metabaseId }))

    // ── 差集②：可嵌入集里**不属于任何 org 的任何一行 metabase_id** 的（I-2 的新判据）。
    // 旧判据按 `title` 集合求差，两个结构性缺陷：同名孤儿看不见（名字命中了本 org 的 title）、
    // 多租户下把别人的 dashboard 恒报成本租户未登记（ok:false 与 ok:true 两种假绿各占一半）。
    // 新判据与 title 无关、与「谁在跑对账」无关 ⇒ **正交、无假绿**。
    const registeredIds = new Set(allRows.map((r) => r.metabaseId))
    const unregisteredAll = embeddable
      .filter((d) => !registeredIds.has(d.id))
      .map((d) => ({ metabaseId: d.id, name: d.name }))
    // 两分：名字能解出 `(org, title)` ⇒ 归属确定、消除动作确定（重跑 POST 按全等命中接管；
    // 若是已登记行的重复副本则归档该 id）＝**能自愈**；解不出（人在 Metabase 侧直接建的、或
    // 本改动前的无前缀遗留）⇒ 平台无从判定归属 ＝**需人看**。
    const unregistered = {
      recoverable: unregisteredAll.filter((d) => parseDashboardName(d.name) !== null),
      needsHuman: unregisteredAll.filter((d) => parseDashboardName(d.name) === null),
    }

    // ── 差集③（RR9② + spec §7 待办 2 的加厚）：「锁参三件套」这族约定只能靠机械防线，
    // 失效模式全是静默的（页面照常显示**未过滤**的数据）。同一循环判两件事：
    //   ③a 锁没锁：回读 `embedding_params.tenant === 'locked'`，不满足落 `tenantUnlocked`；
    //   ③b 锁了但**绑不到**：① dashboard 没声明 slug=tenant 的参数（没声明 ⇒ 锁值无处挂），
    //      或 ② **任一**带 {{tenant}} 模板标签的卡没有映射挂到 tenant 参数上（单卡粒度，
    //      人裁 2026-09-29：半绑定也报）⇒ 落 `tenantUnbound`。
    // 两判用**同一次** readDashboardContent 回读（别多发请求）。
    // 只读**本 org** 的行：它是「我们登记的报表锁没锁住」的自检；跨 org 读会把别人的行内状态
    // 暴露给本租户（而 unregistered 的跨 org 读是**必需**的——不取全局并集就有假阳性）。
    const tenantUnlocked: { id: string; title: string; metabaseId: number }[] = []
    const tenantUnbound: { id: string; title: string; metabaseId: number }[] = []
    // 按行降级（计划 2）：一行回读失败（上游对**这一个** dashboard 说不行）只落 contentUnreadable，
    // 不再让整单 502——对账的存在意义就是把「哪里坏了」**显式报出来**，一行坏拖死全租户的报告
    // 恰是相反。只有非 MetabaseError（代码缺陷等）才继续往上抛。
    const contentUnreadable: { id: string; title: string; metabaseId: number }[] = []
    for (const r of rows) {
      // renderer=platform（终审修复 3）：平台自绘，没有 Metabase dashboard（metabaseId=0 是哨兵，
      // 凡读它之前先判 renderer——Task 2 的承诺）。整体跳过：拿哨兵比对可嵌入集会把它报成
      // missingInMetabase 的永久噪声，回读也会 404。
      if (r.renderer === 'platform') continue
      // 已经报成 missingInMetabase 的行不重复报（回读也只会 404）
      if (!embeddableIds.has(r.metabaseId)) continue
      let content: Awaited<ReturnType<typeof readDashboardContent>>
      try {
        content = await readDashboardContent(deps, r.metabaseId)
      } catch (err) {
        if (err instanceof MetabaseError) {
          contentUnreadable.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
          continue
        }
        throw err
      }
      const params = content.embeddingParams
      if (params[TENANT_SLUG] !== 'locked') {
        tenantUnlocked.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
        continue
      }
      // ① 参数没声明 或 ② 任一卡带 tenant 标签但**没映射** ⇒ 锁了但绑不到。
      //    ② 是**单卡粒度**（人裁 2026-09-29）：半绑定——两张 tenant 卡只映射一张——也要报；
      //    dashboard 粒度的 anyMapped（"有一张映射了就不报"）会漏检它，未映射那张卡在嵌入语境
      //    拿不到 tenant 值、静默显示未过滤数据——正是本任务要抓的失效家族。
      const declared = content.parameters.some((p) => p['slug'] === TENANT_SLUG)
      // 「映射到 tenant」**在这里判**（不在 metabase.ts）：比 parameter_id，而不是"有没有映射"
      // ——挂了别个参数（如 region）的卡用「有映射」判会得 true ⇒ 假绿（Task 3 已清除该启发式，
      // 不许回来）。metabase.ts 是纯 HTTP 客户端，不该知道平台的参数命名约定。
      const isTenantMapped = (d: { parameterMappings?: unknown[] }) =>
        (d.parameterMappings ?? []).some(
          (m) => (m as { parameter_id?: unknown }).parameter_id === TENANT_PARAM_ID,
        )
      const unboundCards = content.dashcards.filter(
        (d) => d.cardId !== null && (content.cardTags[d.cardId] ?? []).includes(TENANT_SLUG) && !isTenantMapped(d),
      )
      if (!declared || unboundCards.length > 0) {
        tenantUnbound.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
      }
    }

    const ok = missingInMetabase.length === 0
      && unregistered.recoverable.length === 0
      && unregistered.needsHuman.length === 0
      && tenantUnlocked.length === 0
      && tenantUnbound.length === 0
      && contentUnreadable.length === 0

    // 差集非空 ⇒ 打一条可检索的告警行：对账结果只在响应体里返回的话，只有**主动去调**的人
    // 才看得见（这正是 #M3c 那条「配了但不对，在请求路径上不可观测」的病）。
    if (!ok) {
      console.warn(
        `[data.reports] 对账差集 org=${org} `
        + `missingInMetabase=${missingInMetabase.length} `
        + `unregistered=${unregistered.recoverable.length}自愈+${unregistered.needsHuman.length}需人看 `
        + `tenantUnlocked=${tenantUnlocked.length} `
        + `tenantUnbound=${tenantUnbound.length} `
        + `contentUnreadable=${contentUnreadable.length}`,
      )
    }
    return c.json({
      ok,
      registered: rows.length,
      embeddable: embeddable.length,
      missingInMetabase,
      tenantUnlocked,
      tenantUnbound,
      contentUnreadable,
      unregistered,
    })
  })
}
