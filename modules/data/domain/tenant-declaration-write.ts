// tenant-declaration-write.ts — 租户新建声明（W8 P1）的判定链（HTTP 管理面入口的域层）。
//
// 与 L2 写路径（metric-write.ts）分开：租户声明**不是**语义层的结构化树，而是与 L1 同形的
// 「声明条目」。所以校验用 L1 同一套：`semanticsYamlPieceIssues`（apply 的重校验尺）+
// `compileTenantDeclaration`（同源推导）。**不收 SQL**、不引入自由表达式语法。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_TIER_SCOPE } from './authz'
import type { Requester } from './authz'
import { sqlMentionsColumn } from './mask'
import { compileTenantDeclaration } from './declaration-compiler'
import type { CompiledTenantDeclaration, DeclarationIssue } from './declaration-compiler'
import { writeMetricAudit } from './metric-audit-store'
import {
  confirmOverrideDeclaration as confirmOverrideDeclarationStore,
  deleteOverrideDeclaration as deleteOverrideDeclarationStore,
  insertTenantDeclaration,
  loadPlatformCatalog,
  selectMetricSnapshot,
} from './metric-store'
import type { MetricReveal, MetricRow } from './metric-store'
import { loadRelationColumns } from './private-measure'
import { readCurrentSemanticsYaml, semanticsYamlPieceIssues } from './pipelines/propose-metric'
import { parseL1Select } from './semantic-compiler'

export interface TenantDeclarationDeps {
  /** 平台库（data.metrics 在这张库）。 */
  pool: Pool
  /** 数据面（列存在性；缺省 = 跳过该道，其余校验不降级）。 */
  warehouse?: Pool
}

export type TenantDeclarationOutcome =
  | { ok: true; id: string }
  | { ok: false; http: 400 | 403 | 404 | 409 | 500; error: string; extra?: Record<string, unknown> }

/** TenantDeclarationOutcome 的败支（编译段失败只产败支，调用方原样透传给 HTTP 面）。 */
type TenantDeclarationRejection = Exclude<TenantDeclarationOutcome, { ok: true }>

const issueExtra = (issues: DeclarationIssue[]): Record<string, unknown> => ({ issues })

/** 事务包裹（审计与变更同生共死；同 metric-write.ts 的口径）。 */
async function withTx<T>(pool: Pool, fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * 契约列敏感度（`<domain>.<table>.<column>` → sensitivity）。与
 * `scripts/check-column-scope-monotonicity.mjs` 的 `loadSensitivity` **同一事实源格式**；
 * 运行期需要它来给租户声明套默认整值掩码（与 L1 sync 的 `applyDefaultMaskTier` 同一条规则）。
 * 进程内缓存：契约随部署变化，写路径不需要每次重读。
 */
let sensitivityCache: Map<string, string> | null = null
function sensitivityMap(): Map<string, string> {
  if (sensitivityCache !== null) return sensitivityCache
  const m = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) { walk(full); continue }
      if (!ent.name.endsWith('.json') || ent.name.startsWith('_')) continue
      try {
        const doc = JSON.parse(readFileSync(full, 'utf8')) as {
          domain?: unknown; table?: unknown; columns?: Array<{ name?: unknown; sensitivity?: unknown }>
        }
        if (typeof doc.domain !== 'string' || typeof doc.table !== 'string' || !Array.isArray(doc.columns)) continue
        for (const c of doc.columns) {
          if (typeof c.name !== 'string') continue
          m.set(`${doc.domain}.${doc.table}.${c.name}`, typeof c.sensitivity === 'string' ? c.sensitivity : 'none')
        }
      } catch { /* 坏契约由门禁报，这里跳过 */ }
    }
  }
  try { walk(join(REPO_ROOT, 'contracts')) } catch { /* 无 contracts 目录（测试树）⇒ 空表 */ }
  sensitivityCache = m
  return m
}

/** 写前可执行性：warehouse 可用时跑 `EXPLAIN`（只出计划，不扫数据；pg_duckdb 实测支持）。 */
async function explainOrReject(
  deps: TenantDeclarationDeps, selectSql: string, groupBy: string,
): Promise<TenantDeclarationOutcome | null> {
  if (deps.warehouse === undefined) return null
  // ⚠️ 必须补上 `GROUP BY`：L1/租户声明的 select_sql 形状**不含** GROUP BY（授权层在查询期拼），
  // 直接 EXPLAIN 裸 select_sql 会因「非聚合列不在 GROUP BY」假失败（2026-11-09 真机烟测暴露）。
  const sql = groupBy === '' ? selectSql : `${selectSql} group by ${groupBy}`
  try {
    await deps.warehouse.query(`explain ${sql}`)
    return null
  } catch (e) {
    return { ok: false, http: 400, error: 'SQL_NOT_EXECUTABLE', extra: { detail: (e as Error).message.slice(0, 300) } }
  }
}

/** `reads`（契约列全名数组）必填；命中的敏感列若无按列掩码 ⇒ 套默认整值掩码（同 L1 sync）。 */
function applyTenantDefaultMask(
  e: Record<string, unknown>, d: { selectSql: string; masks: import('./authz').MaskSpec[] | null },
): TenantDeclarationOutcome | null {
  const reads = Array.isArray(e.reads) ? e.reads.map(String) : null
  if (reads === null) return { ok: false, http: 400, error: 'READS_REQUIRED' }
  const sens = sensitivityMap()
  const sensitive = reads.filter((k) => (sens.get(k) ?? 'none') !== 'none')
  if (sensitive.length === 0) return null
  const hasColumnMask = (d.masks ?? []).some((m) => m.column !== null && sqlMentionsColumn(d.selectSql, m.column))
  if (!hasColumnMask) {
    d.masks = [...(d.masks ?? []), { column: null, kind: 'nullify', grantedBy: DEFAULT_TIER_SCOPE }]
  }
  return null
}

export type NewDeclarationCompileOutcome =
  | { ok: true; compiled: CompiledTenantDeclaration; catalog: MetricRow[] }
  | { ok: false; /** 失败以败支形态透传（500 YAML / 409 撞 L1 / 400 DECLARATION_INVALID）。 */ outcome: TenantDeclarationRejection }

/**
 * 新建声明的**编译段**（P5 Task 1 从 createTenantDeclaration 抽出并导出）：
 * ① 现行 YAML 可读 → ② 名字不撞 L1 → ③ `semanticsYamlPieceIssues`（与 apply 同一把尺：
 * 路径白名单/形状/关系白名单）→ ④ `compileTenantDeclaration`（派生 + 掩码/实体/tier；
 * 有 warehouse 时含列存在性）。
 * 抽出动机：变更单试算必须与写路径用**同一把尺**——两处各拼一份上下文就是两把尺，
 * 漂了就是「试算一个形状、生效另一个形状」。
 */
export async function compileNewDeclaration(
  deps: TenantDeclarationDeps, entry: unknown,
): Promise<NewDeclarationCompileOutcome> {
  const yamlText = readCurrentSemanticsYaml()
  if (yamlText === null) {
    return { ok: false, outcome: { ok: false, http: 500, error: 'SEMANTICS_YAML_UNAVAILABLE' } }
  }
  const doc = parseYaml(yamlText) as { metrics?: unknown[]; entities?: Record<string, unknown> } | null
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.metrics)) {
    return { ok: false, outcome: { ok: false, http: 500, error: 'SEMANTICS_YAML_UNPARSEABLE' } }
  }
  const e = (entry ?? {}) as Record<string, unknown>
  const name = typeof e.name === 'string' ? e.name : ''

  // ② 撞 L1（YAML 侧先说清楚；DB 侧同判据再兜一次）
  const catalog = await loadPlatformCatalog(deps.pool)
  if (name !== '' && (catalog.some((m) => m.id === name) || doc.metrics.some((m) => (m as { name?: unknown })?.name === name))) {
    return { ok: false, outcome: { ok: false, http: 409, error: 'ID_RESERVED_BY_L1' } }
  }

  // ③ 与 apply 同一把尺：把新条目拼进现行文件后重校验
  const piece = stringifyYaml({ ...doc, metrics: [...doc.metrics, e] })
  const pieceIssues = semanticsYamlPieceIssues(piece, yamlText)
  if (pieceIssues.length > 0) {
    return { ok: false, outcome: { ok: false, http: 400, error: 'DECLARATION_INVALID', extra: { issues: pieceIssues } } }
  }

  // ④ 编译（含 B11 关系白名单 / 掩码 / 实体 / tier）
  const allowedRelations = new Set<string>()
  for (const m of catalog) {
    try { allowedRelations.add(parseL1Select(m.selectSql).relation) } catch { /* 坏 L1 不授权 */ }
  }
  const entities = new Set(Object.keys(doc.entities ?? {}))
  // 列存在性需要先拿到 relation；拿不到（expression 坏）交给编译器报，不在这里重复判。
  const preloaded = new Map<string, ReadonlySet<string>>()
  let colsOf: ((relation: string) => ReadonlySet<string> | null) | undefined
  if (deps.warehouse !== undefined) {
    const warehouse = deps.warehouse
    colsOf = (relation) => {
      // 编译器是同步的；这里一次只查一个 relation，交给调用方预热的简单做法：
      // 见下方 `preloaded`（同步闭包返回已加载结果）。
      return preloaded.get(relation) ?? null
    }
    const rel = (() => {
      const expr = typeof e.expression === 'string' ? e.expression : ''
      const m = expr.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)/)
      return m?.[1] ?? null
    })()
    if (rel !== null) {
      try {
        const cols = await loadRelationColumns(warehouse, rel)
        preloaded.set(rel, new Set(cols.map((c) => c.name)))
      } catch {
        // relation 名不合法/表不存在 ⇒ 编译器会通过 allowedRelations 报；列检查跳过即可
      }
    }
  }
  const compiled = compileTenantDeclaration(e, {
    allowedRelations,
    entities,
    ...(colsOf === undefined ? {} : { columnsOf: colsOf }),
  })
  if (!compiled.ok) {
    return { ok: false, outcome: { ok: false, http: 400, error: 'DECLARATION_INVALID', extra: { issues: compiled.issues } } }
  }
  return { ok: true, compiled: compiled.compiled, catalog }
}

/**
 * 新建一条租户声明。`entry` 是 YAML 条目等价的 JSON 对象（`name` 即指标 id）。
 *
 * 校验顺序（全部在写库之前）：
 *   ① 现行 YAML 可读（不可读 ⇒ 500，不在坏基线上写）
 *   ② 名字不撞 L1（撞 ⇒ 409；覆盖走 P2 的专用入口）
 *   ③ `semanticsYamlPieceIssues`（与 apply 同一把尺：路径白名单/形状/关系白名单）
 *   ④ `compileTenantDeclaration`（派生 + 掩码/实体/tier 校验；有 warehouse 时含列存在性）
 *   ⑤ 本 org 同 id 未存在（存在 ⇒ 409）
 *   ⑥ 插入 + `metric_audit`（同一事务）
 * ①②③④ 收在 compileNewDeclaration（变更单 declaration 档试算复用同一段，P5 Task 1）。
 */
export async function createTenantDeclaration(
  deps: TenantDeclarationDeps,
  org: string,
  requester: Requester,
  entry: unknown,
  /**
   * P6 Task 4：`reveal` 是**行属性**（不在声明形状里，编译器不认）= payload 顶层随单透传；
   * 缺席 ⇒ 列默认 `panel`（本入口只新建，没有更新分支）。HTTP 直写面已退役（410），
   * 目前唯一调用方是变更单采纳（adoptChange 从 payload 顶层解出）。
   */
  opts?: { reveal?: MetricReveal },
): Promise<TenantDeclarationOutcome> {
  const pre = await compileNewDeclaration(deps, entry)
  if (!pre.ok) return pre.outcome
  const d = pre.compiled
  const e = (entry ?? {}) as Record<string, unknown>
  const maskIssue = applyTenantDefaultMask(e, d)
  if (maskIssue !== null) return maskIssue
  const sqlIssue = await explainOrReject(deps, d.selectSql, d.groupBy)
  if (sqlIssue !== null) return sqlIssue

  // ⑤ 同 org 同 id 已存在 ⇒ 409（不静默改既有口径；修改是另一条语义）
  const exists = await deps.pool.query(
    'select 1 from data.metrics where org = $1 and id = $2',
    [org, d.id],
  )
  if ((exists.rowCount ?? 0) > 0) return { ok: false, http: 409, error: 'ID_EXISTS' }

  // ⑥ 插入 + 审计同事务
  const inserted = await withTx(deps.pool, async (c) => {
    const ok = await insertTenantDeclaration(c, org, d, entry, requester.userId, { reveal: opts?.reveal })
    if (!ok) return false
    await writeMetricAudit(c, {
      org,
      metricId: d.id,
      action: 'create',
      userId: requester.userId,
      channel: requester.channel,
      keyId: requester.keyId,
      before: null,
      after: {
        title: d.title,
        description: d.description,
        subjectColumn: d.subjectColumn,
        selectSql: d.selectSql,
        groupBy: d.groupBy,
        params: d.params,
        certified: 'draft',
      },
    })
    return true
  })
  if (!inserted) return { ok: false, http: 409, error: 'ID_EXISTS' }
  return { ok: true, id: d.id }
}

// ── P2：覆盖平台口径（草稿 → 确认 → 生效；D6）──────────────────────────────────

export type OverrideCompileOutcome =
  | { ok: true; compiled: CompiledTenantDeclaration; /** 平台目录（调用方免二次加载）。 */ catalog: MetricRow[] }
  | { ok: false; /** 失败以败支形态透传（500 YAML / 400 DECLARATION_INVALID）。 */ outcome: TenantDeclarationRejection }

/**
 * override 声明的**编译段**（P1 Task 7 从 createOverrideDeclaration 抽出并导出）：
 * YAML 实体集 + L1 关系白名单 + （有 warehouse 时）列预热 → `compileTenantDeclaration`。
 * 抽出动机：变更单试算（metric-change-preview）要与写路径用**同一把编译尺**——两处各拼一份
 * 上下文就是两把尺，漂了就是「试算一个形状、生效另一个形状」。
 * 只编译、不复刻「对行」判据（L1 存在性 / grain 同形 / scope 降档 / 撞行）——那些留在
 * createOverrideDeclaration（采纳期深校验）；试算面用同一编译尺但少那几道，正是
 * 「先试后断」的语义：grain 不同形的单要能立、能试算、在采纳时被透传的 400 拒掉。
 */
export async function compileOverrideDeclaration(
  deps: TenantDeclarationDeps, entry: unknown, preloadedCatalog?: MetricRow[],
): Promise<OverrideCompileOutcome> {
  const yamlText = readCurrentSemanticsYaml()
  if (yamlText === null) {
    return { ok: false, outcome: { ok: false, http: 500, error: 'SEMANTICS_YAML_UNAVAILABLE' } }
  }
  const doc = parseYaml(yamlText) as { metrics?: unknown[]; entities?: Record<string, unknown> } | null
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.metrics)) {
    return { ok: false, outcome: { ok: false, http: 500, error: 'SEMANTICS_YAML_UNPARSEABLE' } }
  }
  const catalog = preloadedCatalog ?? (await loadPlatformCatalog(deps.pool))
  // 覆盖不跑 `semanticsYamlPieceIssues`：被覆盖的是**已存在的 L1 id**（不是向仓库新增声明），
  // 而该校验器的名字白名单会拒绝测试/保留前缀的既有 id。覆盖的判据由编译器（形状/关系/
  // 掩码/实体/tier）+ L1 存在性 + grain 同形三条承担。
  const allowedRelations = new Set<string>()
  for (const m of catalog) {
    try { allowedRelations.add(parseL1Select(m.selectSql).relation) } catch { /* 坏 L1 不授权 */ }
  }
  const entities = new Set(Object.keys(doc.entities ?? {}))
  const e = (entry ?? {}) as Record<string, unknown>
  const preloaded = new Map<string, ReadonlySet<string>>()
  let colsOf: ((relation: string) => ReadonlySet<string> | null) | undefined
  if (deps.warehouse !== undefined) {
    const warehouse = deps.warehouse
    colsOf = (relation) => preloaded.get(relation) ?? null
    const expr = typeof e.expression === 'string' ? e.expression : ''
    const rel = expr.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null
    if (rel !== null) {
      try {
        const cols = await loadRelationColumns(warehouse, rel)
        preloaded.set(rel, new Set(cols.map((c) => c.name)))
      } catch { /* 表不存在 ⇒ 编译器按关系白名单报 */ }
    }
  }
  const compiled = compileTenantDeclaration(e, {
    allowedRelations, entities, ...(colsOf === undefined ? {} : { columnsOf: colsOf }),
  })
  if (!compiled.ok) {
    return {
      ok: false,
      outcome: { ok: false, http: 400, error: 'DECLARATION_INVALID', extra: { issues: compiled.issues } },
    }
  }
  return { ok: true, compiled: compiled.compiled, catalog }
}

/**
 * 新建/重建一条**草稿**覆盖。`entry.name` 必须等于被覆盖的 L1 id；
 * grain 必须与 L1 行同形（否则覆盖后合计/下钻语义断裂）。
 * 草稿不生效（`loadMergedCatalog` 只认 certified 的覆盖行）；确认走 `confirmOverride`。
 */
export async function createOverrideDeclaration(
  deps: TenantDeclarationDeps,
  org: string,
  requester: Requester,
  id: string,
  entry: unknown,
  /** P6 Task 4：同 createTenantDeclaration——`reveal` 随 payload 顶层，缺席 = 列默认 `panel`。 */
  opts?: { reveal?: MetricReveal },
): Promise<TenantDeclarationOutcome> {
  const e = (entry ?? {}) as Record<string, unknown>
  if (e.name !== id) return { ok: false, http: 400, error: 'NAME_MISMATCH' }

  const catalog = await loadPlatformCatalog(deps.pool)
  const l1 = catalog.find((m) => m.id === id)
  if (l1 === undefined) return { ok: false, http: 404, error: 'NOT_FOUND' }

  // grain 同形（L1 的 groupBy 是唯一事实源）
  const grain = Array.isArray(e.grain) ? e.grain.map(String) : []
  const l1Grain = l1.groupBy.split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (grain.join(',') !== l1Grain.join(',')) {
    return { ok: false, http: 400, error: 'GRAIN_MISMATCH', extra: { expected: l1Grain, got: grain } }
  }

  // 编译段（与变更单试算同一把尺，见 compileOverrideDeclaration 头注；catalog 传入免二次加载）。
  // 刻意放在 name/L1/grain 三道**之后**：对行判据优先于编译尺——覆盖不存在的 L1 必须如实 404，
  // 不能被编译器的形状报错（DECLARATION_INVALID）遮住。
  const pre = await compileOverrideDeclaration(deps, entry, catalog)
  if (!pre.ok) return pre.outcome
  const d = pre.compiled

  const maskIssue = applyTenantDefaultMask(e, d)
  if (maskIssue !== null) return maskIssue
  const sqlIssue = await explainOrReject(deps, d.selectSql, d.groupBy)
  if (sqlIssue !== null) return sqlIssue
  // 覆盖不得**降低**平台口径的门：L1 有 required_scope ⇒ 覆盖必须同码（否则等于给没有该码的人开门）。
  if (l1.requiredScope !== null && d.requiredScope !== l1.requiredScope) {
    return { ok: false, http: 400, error: 'SCOPE_DOWNGRADE', extra: { expected: l1.requiredScope, got: d.requiredScope } }
  }

  const exists = await deps.pool.query('select 1 from data.metrics where org = $1 and id = $2', [org, d.id])
  if ((exists.rowCount ?? 0) > 0) return { ok: false, http: 409, error: 'OVERRIDE_EXISTS' }

  const inserted = await withTx(deps.pool, async (c) => {
    const ok = await insertTenantDeclaration(c, org, d, entry, requester.userId,
      { overrideOf: id, reveal: opts?.reveal })
    if (!ok) return false
    await writeMetricAudit(c, {
      org, metricId: d.id, action: 'create', userId: requester.userId,
      channel: requester.channel, keyId: requester.keyId, before: null,
      after: {
        title: d.title, description: d.description, subjectColumn: d.subjectColumn,
        selectSql: d.selectSql, groupBy: d.groupBy, params: d.params, certified: 'draft',
      },
    })
    return true
  })
  if (!inserted) return { ok: false, http: 409, error: 'OVERRIDE_EXISTS' }
  return { ok: true, id: d.id }
}

/** 确认覆盖（草稿→certified）。确认后该 org 的读取改用本口径。 */
export async function confirmOverrideDeclaration(
  deps: TenantDeclarationDeps, org: string, requester: Requester, id: string,
): Promise<TenantDeclarationOutcome> {
  const before = await selectMetricSnapshot(deps.pool, org, id)
  if (before === null) return { ok: false, http: 404, error: 'NOT_FOUND' }
  const done = await withTx(deps.pool, async (c) => {
    const ok = await confirmOverrideDeclarationStore(c, org, id, requester.userId)
    if (!ok) return false
    await writeMetricAudit(c, {
      org, metricId: id, action: 'certify', userId: requester.userId,
      channel: requester.channel, keyId: requester.keyId,
      before, after: { ...before, certified: 'certified' },
    })
    return true
  })
  if (!done) return { ok: false, http: 404, error: 'NOT_FOUND' }
  return { ok: true, id }
}

/** 删除覆盖（回落到平台 L1 口径）。 */
export async function deleteOverrideDeclaration(
  deps: TenantDeclarationDeps, org: string, requester: Requester, id: string,
): Promise<TenantDeclarationOutcome> {
  const before = await selectMetricSnapshot(deps.pool, org, id)
  if (before === null) return { ok: false, http: 404, error: 'NOT_FOUND' }
  const done = await withTx(deps.pool, async (c) => {
    const ok = await deleteOverrideDeclarationStore(c, org, id)
    if (!ok) return false
    await writeMetricAudit(c, {
      org, metricId: id, action: 'delete', userId: requester.userId,
      channel: requester.channel, keyId: requester.keyId, before, after: null,
    })
    return true
  })
  if (!done) return { ok: false, http: 404, error: 'NOT_FOUND' }
  return { ok: true, id }
}
