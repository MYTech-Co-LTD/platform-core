// report-version.ts — 报表**定义版本**的发布/下线/回滚/历史（月报重做 Task 9；设计
// docs/superpowers/specs/2026-10-26-report-versioning-and-standalone-design.md §3–§5）。
//
// 两个「版本」别混（设计 §3.3）：
//   · `data.reports.version`            —— **草稿**写入计数器（写保护 `expectedVersion`）
//   · `data.report_versions.version`    —— 已**发布**内容版本号（1,2,3…；`?v=N`/历史/回滚）
//   · `data.report_versions.draft_version` —— 发布那一刻的草稿计数器（判「有未发布改动」）
//
// 五条不变量（回退任何一条先回设计）：
//   ① **append-only**：`report_versions` 只插入、不更新、不删除；回滚 = 把旧快照**再发布成新版本**，
//      旧行一律保留。`data.reports.published_version_id` 只是「线上用哪一版」的指针。
//   ② **expectedVersion fail-closed**：发布/回滚/下线都要求调用方回带草稿版本，不匹配即
//      `STALE_WRITE`，且**一条版本都不落**（校验全在同事务/锁内）。
//   ③ **对象锁**：与 `routes/reports.ts` 同一把键 `${org}/row:${id}`——同行的页门改动 / 改规格 /
//      发布 / 下线 / 回滚必须互斥。进程内锁（见 object-lock.ts 的边界说明），多副本靠
//      `(org, report_id, version)` 唯一键兜底（撞键重读 max 重试一次，仍冲突 ⇒ STALE_WRITE）。
//   ④ **租户隔离**：每条 SQL 都带 `org`；跨租户与不存在同形（null / NOT_FOUND），不给存在性探针。
//   ⑤ **写入侧校验**：发布/回滚都重新跑 `parseReportSpec` + `deriveRequiredScope` +
//      `validatePanelMetrics`——快照引用的指标可能已删/改 scope/源下线，旧快照不能免检上线。
//
// 版本是**定义版本**，不是数据快照：`?v=N` 用 vN 的定义查**当前**湖里的数据。
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { loadMergedCatalog } from './metric-store'
import { withObjectLock } from './object-lock'
import { deriveRequiredScope, validatePanelMetrics } from './report-scope'
import { parseReportSpec } from './report-spec'
import type { ReportSpec } from './report-spec'
import { getReport } from './report-store'

/** 下线后的页门（设计 §4.3：挂回「草稿预览档」，只有管理员看得见）。 */
const UNPUBLISHED_SCOPE = 'data:manage'
/** 历史列表上限（设计 §4.5：最多 100 条）。 */
const MAX_VERSIONS = 100
/** 备注列宽上限（路由层也会裁，存储层兜底：外部输入 ⇒ 截断而不是报错）。 */
const MAX_NOTE = 200

/** 一行不可变版本快照（`data.report_versions`）。 */
export interface VersionRow {
  id: string
  org: string
  reportId: string
  /** 已发布内容版本号（1,2,3…，租户内按 report 单调）。 */
  version: number
  /** 发布时的标题快照。 */
  title: string
  /**
   * 发布时的规格快照（jsonb 原样）。
   *
   * 故意是 `unknown` 而不是 `ReportSpec`：正常发布通路写入的都是 `parseReportSpec` 的产物，
   * 但迁移 022 的**回填行**来自旧数据、未经过当前 schema 归一。消费方要渲染/回滚前必须先
   * `parseReportSpec`——把它标成 `ReportSpec` 会让「没解析就渲染」在类型上看起来合法。
   */
  spec: unknown
  /** 发布时的页门快照（`null` = 拿到模块即可见）。 */
  requiredScope: string | null
  /** 发布时的 `data.reports.version`（判「发布后草稿又改过」）。 */
  draftVersion: number
  /** 发布时间（ISO 8601 UTC）。 */
  publishedAt: string
  /** 发布人（用户 id；迁移回填为 `'migration'`）。 */
  publishedBy: string
  /** 发布备注。 */
  note: string
}

export interface PublishOutcome {
  ok: true
  /** 本次（或 unchanged 时既有的）已发布版本号。 */
  publishedVersion: number
  publishedAt: string
  requiredScope: string | null
  /** 内容与最新快照一致且指针就在它上面 ⇒ 不新建版本（设计 §4.2 第 4 步）。 */
  unchanged?: boolean
}

export type PublishErrorReason =
  | 'NOT_FOUND'
  | 'STALE_WRITE'
  | 'RENDERER_NOT_SELF_DRAWN'
  | 'NO_SPEC'
  | 'INVALID_SPEC'
  | 'UNKNOWN_PANEL_METRIC'
  | 'CONFLICTING_PANEL_SCOPES'
  | 'CHART_REQUIRES_ADDITIVE'
  | 'KPI_NOT_TOTALABLE'
  | 'METRIC_SOURCE_NOT_ADOPTED'
  | 'AI_TEXT_REQUIRES_DATA_PANEL'
  | 'AI_TEXT_REQUIRES_PERIOD'

export type PublishError = { ok: false; reason: PublishErrorReason; detail?: string }
export type PublishResult = PublishOutcome | PublishError

/** 已发布快照的读面（`GET /reports/:id/published-spec` 的正体）。 */
export interface PublishedSpec {
  title: string
  spec: ReportSpec
  version: number
  requiredScope: string | null
  publishedAt: string
}

/** 锁内条件更新没命中：抛出去让事务回滚，外层转 `STALE_WRITE`（不让版本行被单独提交）。 */
class StaleWriteError extends Error {}

/** 唯一键冲突（多副本并发发布撞 `(org, report_id, version)`）——重试一次后仍撞即 STALE_WRITE。 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505'
}

/** 与 `routes/reports.ts` 同键（改这里必须同步改那里，否则锁不到同一行）。 */
function rowLockKey(org: string, id: string): string {
  return `${org}/row:${id}`
}

async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

/**
 * 稳定序列化（对象键排序）：幂等比较的判据。
 *
 * 为什么不用裸 `JSON.stringify`：快照从 jsonb 读回时键序不保证与写入时一致，裸比会把
 * 「同一个 spec」判成不同 ⇒ 每次重复发布都多造一个空版本（设计 §4.2 第 4 步要消灭的正是它）。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function toVersionRow(row: Record<string, unknown>): VersionRow {
  return {
    id: row.id as string,
    org: row.org as string,
    reportId: row.report_id as string,
    version: row.version as number,
    title: row.title as string,
    spec: row.spec,
    requiredScope: row.required_scope as string | null,
    draftVersion: row.draft_version as number,
    publishedAt: toIso(row.published_at),
    publishedBy: row.published_by as string,
    note: row.note as string,
  }
}

const VERSION_COLS = `id, org, report_id, version, title, spec, required_scope,
       draft_version, published_at, published_by, note`

/** 历史版本（`version desc`，最多 100 条；设计 §4.5）。跨租户 = 空数组。 */
export async function listVersions(
  pool: Pool, org: string, id: string, limit = MAX_VERSIONS,
): Promise<VersionRow[]> {
  const r = await pool.query(
    `select ${VERSION_COLS}
       from data.report_versions
      where org = $1 and report_id = $2
      order by version desc
      limit $3`,
    [org, id, Math.min(Math.max(limit, 1), MAX_VERSIONS)],
  )
  return r.rows.map(toVersionRow)
}

/** 单个版本快照（含 spec）。跨租户 / 不存在 ⇒ null。 */
export async function getVersion(
  pool: Pool, org: string, id: string, version: number,
): Promise<VersionRow | null> {
  const r = await pool.query(
    `select ${VERSION_COLS}
       from data.report_versions
      where org = $1 and report_id = $2 and version = $3`,
    [org, id, version],
  )
  return r.rowCount === 0 ? null : toVersionRow(r.rows[0])
}

/**
 * 发布当前草稿为一个新的不可变版本（设计 §4.2）。
 *
 * `adoptedSources` = 本租户已接入的源系统（宿主投影）；传给 `validatePanelMetrics` 做源裁剪。
 * 未接入源的指标**不许发布**——它的 `/query` 会 403，报表会「看起来正常、点进去炸」。
 */
export async function publishVersion(
  pool: Pool, org: string, id: string, expectedVersion: number,
  userId: string, note: string, adoptedSources: ReadonlySet<string>,
): Promise<PublishResult> {
  return withObjectLock(rowLockKey(org, id), async () => {
    const cur = await getReport(pool, org, id)
    if (cur === null) return { ok: false, reason: 'NOT_FOUND' }
    if (cur.renderer !== 'platform') return { ok: false, reason: 'RENDERER_NOT_SELF_DRAWN' }
    if (cur.spec === null) return { ok: false, reason: 'NO_SPEC' }
    if (cur.version !== expectedVersion) return { ok: false, reason: 'STALE_WRITE' }

    // 重新解析而不是信任库里的对象：`spec` 列是 jsonb，历史写入可能来自更早的白名单
    // （含可执行字段的旧形态）——发布是「上线定义」的动作，必须再过一遍白名单。
    const parsed = parseReportSpec(cur.spec)
    if (!parsed.ok) return { ok: false, reason: 'INVALID_SPEC', detail: parsed.code }

    const catalog = await loadMergedCatalog(pool, org)
    const scope = deriveRequiredScope(parsed.spec, catalog)
    if (!scope.ok) {
      return {
        ok: false,
        reason: scope.reason,
        detail: 'metricId' in scope ? scope.metricId : scope.scopes.join(','),
      }
    }
    const validated = validatePanelMetrics(parsed.spec, catalog, adoptedSources)
    if (!validated.ok) {
      // ai_text 的结构闸没有 metricId 可点名（问题在整份规格），`in` 收窄后按空 detail 处理。
      return { ok: false, reason: validated.reason, detail: 'metricId' in validated ? validated.metricId : undefined }
    }

    const attempt = async (): Promise<PublishOutcome> => withTx(pool, async (c) => {
      const latest = await c.query(
        `select id, version, title, spec, required_scope, draft_version, published_at
           from data.report_versions
          where org = $1 and report_id = $2
          order by version desc
          limit 1`,
        [org, id],
      )
      const last = latest.rows[0] as {
        id: string; version: number; title: string; spec: unknown
        required_scope: string | null; draft_version: number; published_at: unknown
      } | undefined

      // 「无改动再发布」：内容逐字相同 + 草稿计数器未动 + **指针正在它上面**。
      // 指针这一条不能省：下线后再发布同样内容，必须真的恢复发布（设计 §4.3/§4.4），
      // 否则 unchanged 会让报表停在「未发布」而调用方拿到 success。
      if (
        last !== undefined
        && cur.publishedVersionId === last.id
        && last.title === cur.title
        && stableStringify(last.spec) === stableStringify(parsed.spec)
        && last.required_scope === scope.requiredScope
        && last.draft_version === cur.version
      ) {
        return {
          ok: true,
          publishedVersion: last.version,
          publishedAt: toIso(last.published_at),
          requiredScope: scope.requiredScope,
          unchanged: true,
        }
      }

      const version = (last?.version ?? 0) + 1
      const vid = randomUUID()
      const inserted = await c.query(
        `insert into data.report_versions
           (id, org, report_id, version, title, spec, required_scope, draft_version, published_by, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning published_at`,
        [vid, org, id, version, cur.title, JSON.stringify(parsed.spec),
          scope.requiredScope, cur.version, userId, note.slice(0, MAX_NOTE)],
      )
      // 条件更新 + 计数校验：`version = $5` 命不中 ⇒ 抛出回滚（不能把已插入的快照提交出去）。
      const updated = await c.query(
        `update data.reports
            set published_version_id = $1, required_scope = $2, updated_at = now()
          where org = $3 and id = $4 and version = $5`,
        [vid, scope.requiredScope, org, id, expectedVersion],
      )
      if ((updated.rowCount ?? 0) === 0) throw new StaleWriteError()
      return {
        ok: true,
        publishedVersion: version,
        publishedAt: toIso(inserted.rows[0].published_at),
        requiredScope: scope.requiredScope,
      }
    })

    try {
      return await attempt()
    } catch (e) {
      if (e instanceof StaleWriteError) return { ok: false, reason: 'STALE_WRITE' }
      if (!isUniqueViolation(e)) throw e
      // 多副本并发：别人抢先占了同一个 `version`。设计 §4.2 要求「重读 max 重试一次」。
      try {
        return await attempt()
      } catch (retryError) {
        if (retryError instanceof StaleWriteError) return { ok: false, reason: 'STALE_WRITE' }
        if (isUniqueViolation(retryError)) return { ok: false, reason: 'STALE_WRITE' }
        throw retryError
      }
    }
  })
}

/**
 * 下线当前发布（设计 §4.3）：指针置空 + 页门挂回 `data:manage`。
 *
 * 不删版本——历史全保留；`published_version_id` 为空就是「所有独立链接一并失效」的总闸。
 * 返回是否真命中条件更新（false = 陈旧版本 / 跨租户 / id 不存在，路由层再查一次分 404/409）。
 * 草稿计数器**+1**：页门变了，写保护的读侧契约要前进（与 PUT 页门同口径）。
 */
export async function unpublishVersion(
  pool: Pool, org: string, id: string, expectedVersion: number,
): Promise<boolean> {
  return withObjectLock(rowLockKey(org, id), async () => {
    const r = await pool.query(
      `update data.reports
          set published_version_id = null, required_scope = $3, version = version + 1, updated_at = now()
        where org = $1 and id = $2 and version = $4`,
      [org, id, UNPUBLISHED_SCOPE, expectedVersion],
    )
    return (r.rowCount ?? 0) > 0
  })
}

/**
 * 回滚到历史版本（设计 §4.4）：把 vN 的 `title/spec` 复制成**新草稿**（`version+1`），
 * 再用**当前词表**重新校验后发布为 `max+1` 的新版本——旧版本全部保留（append-only），
 * 永不修改/删除历史行。
 *
 * 为什么要重新校验而不是直接复制 `required_scope`：旧快照引用的指标可能已删除 / 改 scope /
 * 所属源已下线；原样上线就是「链接继续可用但面板 403」的假成功。
 */
export async function rollbackVersion(
  pool: Pool, org: string, id: string, version: number, expectedVersion: number,
  userId: string, note: string, adoptedSources: ReadonlySet<string>,
): Promise<PublishResult> {
  return withObjectLock(rowLockKey(org, id), async () => {
    const cur = await getReport(pool, org, id)
    if (cur === null) return { ok: false, reason: 'NOT_FOUND' }
    if (cur.renderer !== 'platform') return { ok: false, reason: 'RENDERER_NOT_SELF_DRAWN' }
    const target = await getVersion(pool, org, id, version)
    if (target === null) return { ok: false, reason: 'NOT_FOUND' }
    if (cur.version !== expectedVersion) return { ok: false, reason: 'STALE_WRITE' }

    const parsed = parseReportSpec(target.spec)
    if (!parsed.ok) return { ok: false, reason: 'INVALID_SPEC', detail: parsed.code }

    const catalog = await loadMergedCatalog(pool, org)
    const scope = deriveRequiredScope(parsed.spec, catalog)
    if (!scope.ok) {
      return {
        ok: false,
        reason: scope.reason,
        detail: 'metricId' in scope ? scope.metricId : scope.scopes.join(','),
      }
    }
    const validated = validatePanelMetrics(parsed.spec, catalog, adoptedSources)
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, detail: 'metricId' in validated ? validated.metricId : undefined }
    }

    const rollbackNote = note.trim() === '' ? `rollback from v${version}` : note

    try {
      return await withTx(pool, async (c) => {
        const latest = await c.query(
          'select coalesce(max(version), 0) as max_version from data.report_versions where org = $1 and report_id = $2',
          [org, id],
        )
        const newVersion = Number(latest.rows[0].max_version) + 1
        const newDraftVersion = expectedVersion + 1
        const vid = randomUUID()

        const inserted = await c.query(
          `insert into data.report_versions
             (id, org, report_id, version, title, spec, required_scope, draft_version, published_by, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning published_at`,
          [vid, org, id, newVersion, target.title, JSON.stringify(parsed.spec),
            scope.requiredScope, newDraftVersion, userId, rollbackNote.slice(0, MAX_NOTE)],
        )

        // 草稿跟着回滚到旧内容（设计 §4.4：回滚后编辑面看到的就是 vN 的定义），
        // 指针同步指向新版本——同一条 UPDATE 落，没有「新草稿 + 旧指针」的窗口。
        const updated = await c.query(
          `update data.reports
              set title = $1, spec = $2, required_scope = $3,
                  published_version_id = $4, version = version + 1, updated_at = now()
            where org = $5 and id = $6 and version = $7`,
          [target.title, JSON.stringify(parsed.spec), scope.requiredScope, vid, org, id, expectedVersion],
        )
        if ((updated.rowCount ?? 0) === 0) throw new StaleWriteError()
        return {
          ok: true as const,
          publishedVersion: newVersion,
          publishedAt: toIso(inserted.rows[0].published_at),
          requiredScope: scope.requiredScope,
        }
      })
    } catch (e) {
      if (e instanceof StaleWriteError) return { ok: false, reason: 'STALE_WRITE' }
      if (isUniqueViolation(e)) return { ok: false, reason: 'STALE_WRITE' }
      throw e
    }
  })
}

/**
 * 读已发布快照（设计 §5）：
 *   · 不给 `version` ⇒ 当前发布那一版；
 *   · 给 `version`   ⇒ 钉住历史版本 vN（**仍要求报表处于已发布状态**——下线是总闸）；
 *   · 未发布 / 已下线 / 版本不存在 / 快照不可解析 ⇒ `null`（路由层一律 404 NOT_PUBLISHED，
 *     跨租户同样 404，不给存在性探针）。
 *
 * 快照不可解析时返回 null 而不是把垃圾喂给渲染器：写入侧保证可解析，回填行若不可解析
 * 宁可 404（console 会回退草稿预览），也不让独立链接炸在客户端。
 */
export async function getPublishedSpec(
  pool: Pool, org: string, id: string, version?: number,
): Promise<PublishedSpec | null> {
  const r = await pool.query(
    `select v.title, v.spec, v.version, v.required_scope, v.published_at
       from data.reports r
       join data.report_versions v
         on v.org = r.org and v.report_id = r.id
      where r.org = $1 and r.id = $2
        and r.published_version_id is not null
        and (
          ($3::integer is null and v.id = r.published_version_id)
          or ($3::integer is not null and v.version = $3)
        )
      limit 1`,
    [org, id, version ?? null],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0] as {
    title: string; spec: unknown; version: number
    required_scope: string | null; published_at: unknown
  }
  const parsed = parseReportSpec(row.spec)
  if (!parsed.ok) return null
  return {
    title: row.title,
    spec: parsed.spec,
    version: row.version,
    requiredScope: row.required_scope,
    publishedAt: toIso(row.published_at),
  }
}
