// tenant-declaration-write.ts — 租户新建声明（W8 P1）的判定链（HTTP 管理面入口的域层）。
//
// 与 L2 写路径（metric-write.ts）分开：租户声明**不是**语义层的结构化树，而是与 L1 同形的
// 「声明条目」。所以校验用 L1 同一套：`semanticsYamlPieceIssues`（apply 的重校验尺）+
// `compileTenantDeclaration`（同源推导）。**不收 SQL**、不引入自由表达式语法。
import type { Pool } from 'pg'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Requester } from './authz'
import { compileTenantDeclaration } from './declaration-compiler'
import type { DeclarationIssue } from './declaration-compiler'
import { writeMetricAudit } from './metric-audit-store'
import {
  confirmOverrideDeclaration as confirmOverrideDeclarationStore,
  deleteOverrideDeclaration as deleteOverrideDeclarationStore,
  insertTenantDeclaration,
  loadPlatformCatalog,
  selectMetricSnapshot,
} from './metric-store'
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
 */
export async function createTenantDeclaration(
  deps: TenantDeclarationDeps,
  org: string,
  requester: Requester,
  entry: unknown,
): Promise<TenantDeclarationOutcome> {
  const yamlText = readCurrentSemanticsYaml()
  if (yamlText === null) {
    return { ok: false, http: 500, error: 'SEMANTICS_YAML_UNAVAILABLE' }
  }
  const doc = parseYaml(yamlText) as { metrics?: unknown[]; entities?: Record<string, unknown> } | null
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.metrics)) {
    return { ok: false, http: 500, error: 'SEMANTICS_YAML_UNPARSEABLE' }
  }
  const e = (entry ?? {}) as Record<string, unknown>
  const name = typeof e.name === 'string' ? e.name : ''

  // ② 撞 L1（YAML 侧先说清楚；DB 侧同判据再兜一次）
  const catalog = await loadPlatformCatalog(deps.pool)
  if (name !== '' && (catalog.some((m) => m.id === name) || doc.metrics.some((m) => (m as { name?: unknown })?.name === name))) {
    return { ok: false, http: 409, error: 'ID_RESERVED_BY_L1' }
  }

  // ③ 与 apply 同一把尺：把新条目拼进现行文件后重校验
  const piece = stringifyYaml({ ...doc, metrics: [...doc.metrics, e] })
  const pieceIssues = semanticsYamlPieceIssues(piece, yamlText)
  if (pieceIssues.length > 0) {
    return { ok: false, http: 400, error: 'DECLARATION_INVALID', extra: { issues: pieceIssues } }
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
    return { ok: false, http: 400, error: 'DECLARATION_INVALID', extra: { issues: compiled.issues } }
  }
  const d = compiled.compiled

  // ⑤ 同 org 同 id 已存在 ⇒ 409（不静默改既有口径；修改是另一条语义）
  const exists = await deps.pool.query(
    'select 1 from data.metrics where org = $1 and id = $2',
    [org, d.id],
  )
  if ((exists.rowCount ?? 0) > 0) return { ok: false, http: 409, error: 'ID_EXISTS' }

  // ⑥ 插入 + 审计同事务
  const inserted = await withTx(deps.pool, async (c) => {
    const ok = await insertTenantDeclaration(c, org, d, entry, requester.userId)
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
): Promise<TenantDeclarationOutcome> {
  const yamlText = readCurrentSemanticsYaml()
  if (yamlText === null) return { ok: false, http: 500, error: 'SEMANTICS_YAML_UNAVAILABLE' }
  const doc = parseYaml(yamlText) as { metrics?: unknown[]; entities?: Record<string, unknown> } | null
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.metrics)) {
    return { ok: false, http: 500, error: 'SEMANTICS_YAML_UNPARSEABLE' }
  }
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

  // 覆盖不跑 `semanticsYamlPieceIssues`：被覆盖的是**已存在的 L1 id**（不是向仓库新增声明），
  // 而该校验器的名字白名单会拒绝测试/保留前缀的既有 id。覆盖的判据由编译器（形状/关系/
  // 掩码/实体/tier）+ L1 存在性 + grain 同形三条承担。
  const allowedRelations = new Set<string>()
  for (const m of catalog) {
    try { allowedRelations.add(parseL1Select(m.selectSql).relation) } catch { /* 坏 L1 不授权 */ }
  }
  const entities = new Set(Object.keys(doc.entities ?? {}))
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
    return { ok: false, http: 400, error: 'DECLARATION_INVALID', extra: { issues: compiled.issues } }
  }
  const d = compiled.compiled

  const exists = await deps.pool.query('select 1 from data.metrics where org = $1 and id = $2', [org, d.id])
  if ((exists.rowCount ?? 0) > 0) return { ok: false, http: 409, error: 'OVERRIDE_EXISTS' }

  const inserted = await withTx(deps.pool, async (c) => {
    const ok = await insertTenantDeclaration(c, org, d, entry, requester.userId, { overrideOf: id })
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
