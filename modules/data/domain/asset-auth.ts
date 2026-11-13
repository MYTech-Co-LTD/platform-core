// asset-auth.ts — 资产级授权（spec 2026-11-01-mobile-first-business-surface-design.md §4）。
//
// 两件事，两个函数，**各自只有一份实现**（PC/移动/列表/详情/导出/嵌入 URL 全走它们）：
//   · `canViewAsset` —— 谁能看这条资产的内容
//   · `canEditAsset` —— 谁能改这条资产的配置（含共享设置）
// 业界对照（Google Drive / GitHub / Notion）：**可看 ≠ 可改**，且 owner 是"可改"的默认持有者；
// 管理员可代管但必须留审计。把三者混成一个"权限"判断，是这类系统最常见的越权来源。
//
// 三维度别混（本域已有两维，本文件加一维）：
//   · ACL（本文件）      —— 谁被点名/按部门/按权限码授予了访问
//   · `visibility`       —— 默认可见面（tenant = 沿用旧粗门；restricted = 只有 ACL 里的人）
//   · `required_scope`   —— **内容门**：在本域 NULL 还兼「已发布」语义（report-store 头注）
import type { Pool } from 'pg'
import { deptGatePasses } from './dept-gate'
import { metricVisibleWithDept, type DeptContext } from './metric-visibility'
import type { ReportSpec, TextPanel } from './report-spec'
import { metricIdsOf } from './report-scope'

export type AclSubjectType = 'user' | 'dept' | 'scope'
export type AclRelation = 'owner' | 'viewer'

export interface AclRow {
  subjectType: AclSubjectType
  subjectId: string
  relation: AclRelation
}

/** 判定所需的资产形状（比 ReportRow 更窄：只要可见性三要素）。 */
export interface AssetVisibility {
  visibility: 'tenant' | 'restricted'
  /** 内容门：NULL = 全模块可见（且在本域兼「已发布」语义） */
  requiredScope: string | null
  requiredDepts: string[] | null
}

export interface AuthRequester {
  userId: string
  hasScope(code: string): boolean
}

/** 该资产的所有者（可能是历史资产：没有任何 owner 行）。 */
export function ownerOf(acl: readonly AclRow[]): string | null {
  const row = acl.find((a) => a.relation === 'owner' && a.subjectType === 'user')
  return row?.subjectId ?? null
}

export function isOwner(acl: readonly AclRow[], userId: string): boolean {
  return acl.some((a) => a.relation === 'owner' && a.subjectType === 'user' && a.subjectId === userId)
}

/**
 * 能否**看**这条资产。
 *
 * 顺序固定：ACL（owner/viewer 三类受让方）→ `visibility` → 旧内容门。
 * 三个判断点都 fail-closed：
 *   · 部门受让方在 `userDepts === undefined`（未解析）时**不算命中**——「不知道你在哪个部门」
 *     不等于「你在」；
 *   · `restricted` 且 ACL 无命中 ⇒ 拒（不回落旧粗门，否则"默认私有"形同虚设）；
 *   · 旧粗门的部门门在 `userDepts === undefined` 时同样拒（沿用既有口径）。
 */
export function canViewAsset(
  row: AssetVisibility,
  requester: AuthRequester,
  acl: readonly AclRow[],
  userDepts: ReadonlySet<string> | undefined,
): boolean {
  if (isOwner(acl, requester.userId)) return true
  for (const a of acl) {
    if (a.relation !== 'viewer') continue
    if (a.subjectType === 'user' && a.subjectId === requester.userId) return true
    if (a.subjectType === 'scope' && requester.hasScope(a.subjectId)) return true
    if (a.subjectType === 'dept' && userDepts !== undefined && userDepts.has(a.subjectId)) return true
  }
  if (row.visibility === 'restricted') return false
  // 旧粗门（历史资产）：与改造前逐字一致
  if (row.requiredScope !== null && !requester.hasScope(row.requiredScope)) return false
  if (userDepts === undefined && (row.requiredDepts ?? []).length > 0) return false
  return deptGatePasses(row.requiredDepts, userDepts ?? new Set())
}

/**
 * 版本化内容（`published-spec` / AI 文本）的资产面判定：**粗门由那一版快照判**，
 * 这里只判 `visibility` 与 ACL。
 *
 * 为什么不能直接用 `canViewAsset(row, …)`：行上的 `requiredScope` / `requiredDepts` 是
 * **草稿/下一次发布**的门；`?v=N` 的契约是「旧链接按那一版的门判，不因后来改门失效」。
 * 用行上当前值会让旧版链接被新门误杀（测试 `★ 发布后门随快照走` 即此判据）。
 *
 * 仍复用 `canViewAsset`（单一实现），只是把粗门置空——不是第二份判定逻辑。
 */
export function canViewVersionedContent(
  row: AssetVisibility,
  requester: AuthRequester,
  acl: readonly AclRow[],
  userDepts?: ReadonlySet<string>,
): boolean {
  return canViewAsset(
    { ...row, requiredScope: null, requiredDepts: null }, requester, acl, userDepts,
  )
}

// ── 渲染闸（P5 Task 3，spec 2026-11-12 §9.2/§9.3）────────────────────────────
// 过了 `canViewVersionedContent` 只说明「这份报表该给这个人」；面板里的**指标**还有自己的
// 可见范围（部门归属 / 显式共享，P2 的 `metricVisibleWithDept`）。两者是两把尺子：
// 报表发布门（P5 Task 2）拦「受众比指标宽」的发布；本闸负责**发布之后**的漂移与历史行——
// 以及「这个人过了报表门、但过不了某个口径」的观看期裁剪。
//
// 语义只有三条：
//   ① 不可见指标所在面板 ⇒ 在**回包**里替换成占位符 `{ index, denied: true }`（不带任何数据
//      字段：metricId/chart/title/args 全剥），其余面板原样；
//   ② 被拒指标里任一条 `reveal='report'` ⇒ 整表拒（调用方回 404），防「总数 − 其他」反推；
//   ③ 词表里**查不到**的指标（归档 / 陈旧行 / 未同步）同样按被拒处理（fail-closed，
//      reason `metric_unknown`）——否则「指标被删了」会变成「面板原样展示 + 不触发 reveal」。
//
// ⚠️ `reveal` 目前**只有读侧**：变更单 payload 与 L1 sync 声明都还没有这个字段，生产恒
//    `'panel'`（测试直改库）。写入面待 **P6**（变更单 payload 或 sync 声明）落——这是产品
//    缺口，不是本函数的判定缺口。

/** 渲染闸所需的最小指标形状（`MetricRow` 结构性满足——不拖整个存储行进来）。 */
export interface RenderGateMetric {
  id: string
  ownerDept?: string | null
  visibleDepts?: string[] | null
  reveal?: 'panel' | 'report'
}

/** 被降级的面板占位符：**只有** index/denied，没有任何数据字段（不泄露 metricId/图型/标题）。 */
export interface DeniedPanelRef {
  index: number
  denied: true
}

/** 观看面规格：面板位可能是降级占位符。 */
export type ViewableSpec = Omit<ReportSpec, 'panels'> & {
  panels: Array<ReportSpec['panels'][number] | DeniedPanelRef>
}

/** 面板被降级的原因（审计/巡检可解释；`metric_unknown` 是 fail-closed 的存在性失败）。 */
export type RenderGateDenialReason = 'metric_invisible' | 'metric_unknown'

export interface RenderGateDenial {
  index: number
  reason: RenderGateDenialReason
}

export interface RenderGateResult {
  /** true ⇒ 整表拒（任一被拒指标 `reveal='report'`）；调用方回与 not-found 同形的 404。 */
  blocked: boolean
  /** 被降级面板的下标（升序）。 */
  deniedPanels: number[]
  /** 与 `deniedPanels` 一一对应的原因。 */
  denials: RenderGateDenial[]
  /** 已按观看者降级的规格（`blocked` 时调用方不应使用）。 */
  spec: ViewableSpec
}

/** 词表索引（id → 行）。列表页同一请求要跑多份报表 ⇒ 建**一次**复用，别逐行重建 Map。 */
export function indexRenderCatalog(
  catalog: ReadonlyArray<RenderGateMetric>,
): ReadonlyMap<string, RenderGateMetric> {
  return new Map(catalog.map((m) => [m.id, m]))
}

/**
 * 按观看者的部门上下文逐面板降级规格。**纯函数**（判定只走 `metricVisibleWithDept`，
 * 不另写第二份可见性实现）；词表与部门上下文由调用方一次加载后传入。
 *
 * `catalog` 可以是行数组（单报表路径）或**预先建好的索引 Map**（列表页请求级构建一次）——
 * 两种输入走同一份判定，不给调用方留第二套实现。
 *
 * 面板含多个指标时（kpi 分母）**任一不可见即整格降级**——分母不可见时展示比率同样泄露口径。
 *
 * 词表里找不到的指标 **fail-closed 降级**（reason `metric_unknown`）：发布快照可能引用已被
 * 删除 / 归档的口径，保留面板等于「看不到判定、却照常把口径摆出来」；且它不会触发 reveal
 * 判定（没有行可读），必须按最保守档处理。
 */
export function applyPanelRenderGate(
  spec: ReportSpec,
  catalog: ReadonlyArray<RenderGateMetric> | ReadonlyMap<string, RenderGateMetric>,
  deptCtx: DeptContext | undefined,
): RenderGateResult {
  const byId = Array.isArray(catalog)
    ? indexRenderCatalog(catalog)
    : catalog as ReadonlyMap<string, RenderGateMetric>
  const deniedPanels: number[] = []
  const denials: RenderGateDenial[] = []
  let blocked = false
  const panels = spec.panels.map((panel, index): ReportSpec['panels'][number] | DeniedPanelRef => {
    let reason: RenderGateDenialReason | null = null
    for (const metricId of metricIdsOf(panel)) {
      const metric = byId.get(metricId)
      if (metric === undefined) {
        // 存在性失败优先于可见性：没有行就无从判 reveal，按最保守档整格降级。
        reason = 'metric_unknown'
        continue
      }
      if (metricVisibleWithDept(metric, deptCtx)) continue
      if (reason !== 'metric_unknown') reason = 'metric_invisible'
      // 泄露策略只在**不可见且指标真实存在**时生效：可见的人照常看到整表。
      if (metric.reveal === 'report') blocked = true
    }
    if (reason === null) return panel
    deniedPanels.push(index)
    denials.push({ index, reason })
    // 占位符只带位置：回包不能出现任何可反推口径的数据字段。
    return { index, denied: true }
  })
  return {
    blocked,
    deniedPanels,
    denials,
    spec: { ...spec, panels },
  }
}

/**
 * 空文本面板的**常量**（P5 CI 修复2）：显式标注为 `TextPanel` 具体变体，而不是让
 * `panels.map(...)` 在 `ReportSpec['panels']` 联合体上做推断——不同 TS/依赖解析环境下
 * 联合体推断的收敛结果不一致（CI 报 TS2322，本地干净）。类型写死到具体变体即消除差异。
 */
const BLANK_TEXT_PANEL: TextPanel = { chart: 'text', content: '', span: 12, format: 'plain' }

/**
 * 把降级占位符换成**空文本面板**（无标题 / 无 metricId），供叙述 / 计算凭证的事实装配使用。
 *
 * 为什么不是直接喂 `ViewableSpec`：`buildFacts` 按 `chart !== 'text'` 识别数据面板，占位符
 * 没有 chart 会被当成数据面板并炸在 `p.args` 上；而**保留原面板**又会让 `missing.push(p.title)`
 * 把被拒口径的标题带进 LLM prompt（P5-T3 修复轮 Important）。空文本面板两头都满足：
 * 所有消费方（buildFacts / 根因 pickCandidates / 日报 baseArgsOf）天然跳过 text，
 * 被拒面板只剩 `deniedPanels` 里的下标。
 *
 * ⚠️ 仅用于服务端内部（叙述/凭证），**不**作为 HTTP 回包返回。
 */
export function factsSpecOf(spec: ViewableSpec): ReportSpec {
  return {
    ...spec,
    panels: spec.panels.map((p): ReportSpec['panels'][number] =>
      ('denied' in p ? BLANK_TEXT_PANEL : p)),
  }
}

/**
 * 能否**改配置**（共享设置 / 门 / 删除）。
 * **不看 viewer**：被点名可看 ≠ 可改配置；只有 owner 与模块管理码持有者可以。
 */
export function canEditAsset(
  acl: readonly AclRow[],
  requester: AuthRequester,
  manageScope: string,
): boolean {
  return isOwner(acl, requester.userId) || requester.hasScope(manageScope)
}

/** 管理码代管他人资产时，审计必须能看出"这是管理员动作"（spec §4.2）。 */
export function isAdminOverride(
  acl: readonly AclRow[],
  requester: AuthRequester,
  manageScope: string,
): boolean {
  return !isOwner(acl, requester.userId) && requester.hasScope(manageScope)
}

// ── 存储 ────────────────────────────────────────────────────────────────────

const fromRow = (r: { subject_type: string; subject_id: string; relation: string }): AclRow => ({
  subjectType: r.subject_type as AclSubjectType,
  subjectId: r.subject_id,
  relation: r.relation as AclRelation,
})

/** 单条资产的 ACL（详情/编辑判定）。 */
export async function loadAssetAcl(pool: Pool, org: string, assetId: string): Promise<AclRow[]> {
  const { rows } = await pool.query(
    'select subject_type, subject_id, relation from data.asset_acl where org = $1 and asset_id = $2',
    [org, assetId],
  )
  return rows.map(fromRow)
}

/** 批量取（列表页一次查询，避免 N+1）。 */
export async function loadAssetAcls(
  pool: Pool, org: string, assetIds: readonly string[],
): Promise<Map<string, AclRow[]>> {
  const out = new Map<string, AclRow[]>()
  if (assetIds.length === 0) return out
  const { rows } = await pool.query(
    `select asset_id, subject_type, subject_id, relation
       from data.asset_acl
      where org = $1 and asset_id = any($2::text[])`,
    [org, [...assetIds]],
  )
  for (const r of rows as Array<{ asset_id: string; subject_type: string; subject_id: string; relation: string }>) {
    const list = out.get(r.asset_id) ?? []
    list.push(fromRow(r))
    out.set(r.asset_id, list)
  }
  return out
}

/** 资产级管理动作审计（spec §4.2）。by_admin=true 表示"不是 owner 的管理员代管"。 */
export async function writeAssetAudit(
  pool: Pool,
  e: { org: string; assetId: string; actor: string; action: string; detail?: unknown; byAdmin?: boolean },
): Promise<void> {
  await pool.query(
    `insert into data.asset_audit(org, asset_id, actor, action, detail, by_admin)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [e.org, e.assetId, e.actor, e.action, JSON.stringify(e.detail ?? {}), e.byAdmin === true],
  )
}

/** 新资产落所有者。**幂等**：已有人持有 owner 行时不改（同一标题 upsert 不抢所有权）。 */
export async function ensureOwner(pool: Pool, org: string, assetId: string, owner: string): Promise<void> {
  // **一个资产只有一个 owner**：冲突键含 subject_id，`do nothing` 拦不住"第二个人"——
  // 必须用 not exists 显式表达"已有 owner 就不写"（否则同名 upsert 会造出两个所有者）。
  await pool.query(
    `insert into data.asset_acl(org, asset_id, subject_type, subject_id, relation, granted_by)
     select $1, $2, 'user', $3, 'owner', $3
      where not exists (
        select 1 from data.asset_acl where org = $1 and asset_id = $2 and relation = 'owner'
      )`,
    [org, assetId, owner],
  )
}

/**
 * 整体替换 viewer 集合（PUT /acl 的语义：**幂等覆盖**，不是增量）。
 * owner 行不受影响——所有权转移是独立动作（spec §4.4）。
 */
export async function replaceViewers(
  pool: Pool, org: string, assetId: string, viewers: readonly AclRow[], actor: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      "delete from data.asset_acl where org = $1 and asset_id = $2 and relation = 'viewer'",
      [org, assetId],
    )
    for (const v of viewers) {
      await client.query(
        `insert into data.asset_acl(org, asset_id, subject_type, subject_id, relation, granted_by)
         values ($1, $2, $3, $4, 'viewer', $5)
         on conflict do nothing`,
        [org, assetId, v.subjectType, v.subjectId, actor],
      )
    }
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * 转移所有权（spec §4.4）：`owner` 行整体换人（旧 owner 不再保留任何特权）。
 *
 * 为什么单独一个动作而不是"再加一个 owner 行"：多个 owner 会让「谁负责」失去单一答案；
 * 业界（Drive/GitHub）转移就是把唯一 owner 换人，**旧 owner 若仍需访问**应作为 viewer 显式加回。
 * 审计由调用方写（带 byAdmin）——本函数只管行状态。
 */
export async function transferOwner(
  pool: Pool, org: string, assetId: string, nextOwner: string, actor: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      "delete from data.asset_acl where org = $1 and asset_id = $2 and relation = 'owner'",
      [org, assetId],
    )
    await client.query(
      `insert into data.asset_acl(org, asset_id, subject_type, subject_id, relation, granted_by)
       values ($1, $2, 'user', $3, 'owner', $4)`,
      [org, assetId, nextOwner, actor],
    )
    await client.query('commit')
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
