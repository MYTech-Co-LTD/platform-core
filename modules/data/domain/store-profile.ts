// domain/store-profile.ts — 门店画像：门店级品牌 + 等级（#2924）
// 正典：docs/superpowers/specs/2026-11-27-store-profile-brand-level-design.md
//
// 归属：data 共享主数据（跨模块只读走 data.v_store_profile / data.v_store_level_registry）。
// 写面只给 `data:store`；售后门店页签只是这份数据的一个 UI。
//
// 与 brand_assignment 的边界：
//   · 门店级品牌在这里（store_profile.brand_code）；
//   · 商品级覆盖仍在 brand_assignment(subject_type='product')。
//   057 迁移已把旧的 store 级 brand_assignment 行复制进来并删除；本文件不再写 brand_assignment。
//
// 锁语义：手工编辑/导入写 manual + locked=true；导入默认不覆盖 locked 字段，
// overrideLocked=true 才覆盖（一次显式决定，不是默认）。

import type { Pool, PoolClient } from 'pg'

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

export type StoreProfileError =
  | 'INVALID_BODY'
  | 'INVALID_STORE'
  | 'INVALID_BRAND'
  | 'INVALID_LEVEL'
  | 'INVALID_CODE'
  | 'NOT_FOUND'
  | 'DUP_CODE'
  | 'TOO_MANY_ROWS'

export type StoreProfileResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: StoreProfileError; detail?: string }

const err = <T>(code: StoreProfileError, detail?: string): StoreProfileResult<T> =>
  detail === undefined ? { ok: false, code } : { ok: false, code, detail }

export interface StoreProfileView {
  storeCode: string
  storeName: string
  brandCode: string | null
  brandName: string | null
  brandSource: string
  levelCode: string | null
  levelName: string | null
  levelSource: string
  updatedAt: string | null
}

export interface StoreProfileWriteInput {
  /** 缺省 = 保持不变；null = 清空；字符串 = 置为该 code。 */
  brandCode?: string | null
  levelCode?: string | null
}

export interface StoreProfileImportRowInput {
  storeCode?: unknown
  brandCode?: unknown
  levelCode?: unknown
}

export interface StoreProfileImportInput {
  dryRun: boolean
  overrideLocked: boolean
  rows: StoreProfileImportRowInput[]
}

export type ImportRowStatus = 'ok' | 'skipped' | 'error' | 'duplicate'

export interface StoreProfileImportRowResult {
  row: number
  storeCode: string
  status: ImportRowStatus
  /** 机器可读原因：STORE_NOT_FOUND / BRAND_NOT_FOUND / LEVEL_NOT_FOUND / LOCKED / DUPLICATE / INVALID_* */
  code?: string
  brandFrom?: string | null
  brandTo?: string | null
  levelFrom?: string | null
  levelTo?: string | null
  changed?: boolean
}

export interface StoreProfileImportResult {
  dryRun: boolean
  total: number
  applied: number
  skipped: number
  errors: number
  duplicates: number
  rows: StoreProfileImportRowResult[]
}

export interface StoreLevelView {
  code: string
  name: string
  sort: number
  enabled: boolean
  source: string
  updatedAt: string | null
}

export interface StoreLevelCreateInput {
  code?: unknown
  name?: unknown
  sort?: unknown
  enabled?: unknown
}

export interface StoreLevelUpdateInput {
  name?: unknown
  sort?: unknown
  enabled?: unknown
}

interface ProfileRow {
  brand_code: string | null
  brand_source: string
  brand_locked: boolean
  level_code: string | null
  level_source: string
  level_locked: boolean
}

interface NormalizedImportRow {
  index: number
  storeCode: string
  brandProvided: boolean
  brandCode: string | null
  levelProvided: boolean
  levelCode: string | null
  /** 解析阶段就失败：不参与重复去重/查库。 */
  parseError?: { code: string; status: 'error' }
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_IMPORT_ROWS = 5000
const CLEAR_SENTINEL = '__clear__'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asText(v: unknown): string | null {
  return typeof v === 'string' ? v.trim() : null
}

/** 导入的字段：空/缺省 = 保持不变；null / `__clear__` = 清空。 */
interface ImportField {
  provided: boolean
  value: string | null
  invalid?: true
}

function parseImportField(raw: unknown): ImportField {
  if (raw === undefined) return { provided: false, value: null }
  if (raw === null) return { provided: true, value: null }
  if (typeof raw !== 'string') return { provided: false, value: null, invalid: true }
  const v = raw.trim()
  if (v === '') return { provided: false, value: null }
  if (v === CLEAR_SENTINEL) return { provided: true, value: null }
  if (v.length > 64) return { provided: false, value: null, invalid: true }
  return { provided: true, value: v }
}

async function storeExists(q: Queryable, org: string, storeCode: string): Promise<boolean> {
  const r = await q.query('select 1 from data.dim_branch where org = $1 and code = $2', [org, storeCode])
  return r.rows.length > 0
}

async function brandExists(q: Queryable, org: string, code: string): Promise<boolean> {
  const r = await q.query('select 1 from data.brand_registry where org = $1 and code = $2', [org, code])
  return r.rows.length > 0
}

async function levelExists(q: Queryable, org: string, code: string): Promise<boolean> {
  const r = await q.query('select 1 from data.store_level_registry where org = $1 and code = $2', [org, code])
  return r.rows.length > 0
}

async function readProfile(q: Queryable, org: string, storeCode: string): Promise<ProfileRow> {
  const r = await q.query(
    `select brand_code, brand_source, brand_locked, level_code, level_source, level_locked
       from data.store_profile where org = $1 and store_code = $2`,
    [org, storeCode],
  )
  return (r.rows[0] as ProfileRow | undefined) ?? {
    brand_code: null, brand_source: '', brand_locked: false,
    level_code: null, level_source: '', level_locked: false,
  }
}

async function profileView(q: Queryable, org: string, storeCode: string): Promise<StoreProfileView | null> {
  const r = await q.query(
    `select store_code, store_name, brand_code, brand_name, brand_source,
            level_code, level_name, level_source, updated_at
       from data.v_store_profile where org = $1 and store_code = $2`,
    [org, storeCode],
  )
  const row = r.rows[0] as {
    store_code: string; store_name: string
    brand_code: string | null; brand_name: string | null; brand_source: string
    level_code: string | null; level_name: string | null; level_source: string
    updated_at: Date | string | null
  } | undefined
  if (row === undefined) return null
  return {
    storeCode: row.store_code,
    storeName: row.store_name,
    brandCode: row.brand_code,
    brandName: row.brand_name,
    brandSource: row.brand_source,
    levelCode: row.level_code,
    levelName: row.level_name,
    levelSource: row.level_source,
    updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
  }
}

async function writeAudit(
  client: Pick<PoolClient, 'query'>, org: string, actor: string, action: string,
  storeCode: string, detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into data.store_profile_audit(org, actor, action, store_code, detail)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [org, actor, action, storeCode, JSON.stringify(detail)],
  )
}

async function upsertProfile(
  client: Pick<PoolClient, 'query'>, org: string, storeCode: string,
  next: {
    brandCode: string | null; brandSource: string; brandLocked: boolean
    levelCode: string | null; levelSource: string; levelLocked: boolean
  },
): Promise<void> {
  await client.query(
    `insert into data.store_profile(
       org, store_code, brand_code, brand_source, brand_locked,
       level_code, level_source, level_locked, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (org, store_code) do update set
       brand_code = excluded.brand_code,
       brand_source = excluded.brand_source,
       brand_locked = excluded.brand_locked,
       level_code = excluded.level_code,
       level_source = excluded.level_source,
       level_locked = excluded.level_locked,
       updated_at = now()`,
    [
      org, storeCode,
      next.brandCode, next.brandSource, next.brandLocked,
      next.levelCode, next.levelSource, next.levelLocked,
    ],
  )
}

// ── 单个门店画像编辑 ────────────────────────────────────────────────

export async function updateStoreProfile(
  deps: { pool: Pool }, org: string, actor: string, storeCodeRaw: string, input: StoreProfileWriteInput,
): Promise<StoreProfileResult<StoreProfileView>> {
  const storeCode = storeCodeRaw.trim()
  if (storeCode === '' || storeCode.length > 128) return err('INVALID_BODY')
  if (input.brandCode === undefined && input.levelCode === undefined) return err('INVALID_BODY')

  const client = await deps.pool.connect()
  try {
    await client.query('begin')
    if (!await storeExists(client, org, storeCode)) {
      await client.query('rollback')
      return err('INVALID_STORE', storeCode)
    }
    if (input.brandCode !== undefined && input.brandCode !== null && !await brandExists(client, org, input.brandCode)) {
      await client.query('rollback')
      return err('INVALID_BRAND', input.brandCode)
    }
    if (input.levelCode !== undefined && input.levelCode !== null && !await levelExists(client, org, input.levelCode)) {
      await client.query('rollback')
      return err('INVALID_LEVEL', input.levelCode)
    }

    const before = await readProfile(client, org, storeCode)
    const brandProvided = input.brandCode !== undefined
    const levelProvided = input.levelCode !== undefined
    const next = {
      brandCode: brandProvided ? input.brandCode! : before.brand_code,
      brandSource: brandProvided ? 'manual' : before.brand_source,
      brandLocked: brandProvided ? true : before.brand_locked,
      levelCode: levelProvided ? input.levelCode! : before.level_code,
      levelSource: levelProvided ? 'manual' : before.level_source,
      levelLocked: levelProvided ? true : before.level_locked,
    }
    await upsertProfile(client, org, storeCode, next)
    await writeAudit(client, org, actor, 'profile.update', storeCode, {
      storeCode,
      brandFrom: before.brand_code, brandTo: next.brandCode,
      levelFrom: before.level_code, levelTo: next.levelCode,
    })
    await client.query('commit')

    const view = await profileView(deps.pool, org, storeCode)
    if (view === null) return err('INVALID_STORE', storeCode)
    return { ok: true, value: view }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── 批量导入（CSV 由 console 解析成 rows；这里只收 JSON）────────────────

export async function importStoreProfiles(
  deps: { pool: Pool }, org: string, actor: string, input: StoreProfileImportInput,
): Promise<StoreProfileResult<StoreProfileImportResult>> {
  if (!Array.isArray(input.rows) || input.rows.length === 0) return err('INVALID_BODY')
  if (input.rows.length > MAX_IMPORT_ROWS) return err('TOO_MANY_ROWS', String(MAX_IMPORT_ROWS))

  const normalized: NormalizedImportRow[] = input.rows.map((raw, index) => {
    const row = isRecord(raw) ? raw : {}
    const storeCode = asText(row.storeCode) ?? ''
    const brand = parseImportField(row.brandCode)
    const level = parseImportField(row.levelCode)
    const base: NormalizedImportRow = {
      index,
      storeCode,
      brandProvided: brand.provided,
      brandCode: brand.provided ? brand.value : null,
      levelProvided: level.provided,
      levelCode: level.provided ? level.value : null,
    }
    if (storeCode === '' || storeCode.length > 128) {
      base.parseError = { code: 'INVALID_STORE', status: 'error' }
    } else if (brand.invalid === true) {
      base.parseError = { code: 'INVALID_BRAND', status: 'error' }
    } else if (level.invalid === true) {
      base.parseError = { code: 'INVALID_LEVEL', status: 'error' }
    } else if (!base.brandProvided && !base.levelProvided) {
      base.parseError = { code: 'NO_FIELDS', status: 'error' }
    }
    return base
  })

  // 重复 storeCode：后者覆盖并计入 warning；前一行标 duplicate、不做任何写入。
  const lastIndex = new Map<string, number>()
  for (const r of normalized) {
    if (r.parseError === undefined) lastIndex.set(r.storeCode, r.index)
  }

  const storeCodes = [...new Set(
    normalized.filter((r) => r.parseError === undefined).map((r) => r.storeCode),
  )]
  const brandCodes = [...new Set(
    normalized
      .filter((r) => r.parseError === undefined && r.brandProvided && r.brandCode !== null)
      .map((r) => r.brandCode as string),
  )]
  const levelCodes = [...new Set(
    normalized
      .filter((r) => r.parseError === undefined && r.levelProvided && r.levelCode !== null)
      .map((r) => r.levelCode as string),
  )]

  const run = async (q: Pool | PoolClient, forUpdate: boolean): Promise<StoreProfileImportResult> => {
    const stores = new Set<string>(
      (await q.query(
        'select code from data.dim_branch where org = $1 and code = any($2::text[])',
        [org, storeCodes],
      )).rows.map((r: { code: string }) => r.code),
    )
    const brands = new Set<string>(
      brandCodes.length === 0 ? [] : (await q.query(
        'select code from data.brand_registry where org = $1 and code = any($2::text[])',
        [org, brandCodes],
      )).rows.map((r: { code: string }) => r.code),
    )
    const levels = new Set<string>(
      levelCodes.length === 0 ? [] : (await q.query(
        'select code from data.store_level_registry where org = $1 and code = any($2::text[])',
        [org, levelCodes],
      )).rows.map((r: { code: string }) => r.code),
    )
    const existing = new Map<string, ProfileRow>()
    if (storeCodes.length > 0) {
      const rows = await q.query(
        `select store_code, brand_code, brand_source, brand_locked,
                level_code, level_source, level_locked
           from data.store_profile where org = $1 and store_code = any($2::text[])
          ${forUpdate ? 'for update' : ''}`,
        [org, storeCodes],
      )
      for (const row of rows.rows as Array<ProfileRow & { store_code: string }>) {
        existing.set(row.store_code, row)
      }
    }

    const results: StoreProfileImportRowResult[] = []
    let applied = 0
    let skipped = 0
    let errors = 0
    let duplicates = 0

    for (const r of normalized) {
      const base: StoreProfileImportRowResult = {
        row: r.index + 1,
        storeCode: r.storeCode,
        status: 'ok',
      }
      if (r.parseError !== undefined) {
        results.push({ ...base, status: r.parseError.status, code: r.parseError.code })
        errors += 1
        continue
      }
      if (lastIndex.get(r.storeCode) !== r.index) {
        results.push({ ...base, status: 'duplicate', code: 'DUPLICATE' })
        duplicates += 1
        continue
      }
      if (!stores.has(r.storeCode)) {
        results.push({ ...base, status: 'error', code: 'STORE_NOT_FOUND' })
        errors += 1
        continue
      }
      if (r.brandProvided && r.brandCode !== null && !brands.has(r.brandCode)) {
        results.push({ ...base, status: 'error', code: 'BRAND_NOT_FOUND' })
        errors += 1
        continue
      }
      if (r.levelProvided && r.levelCode !== null && !levels.has(r.levelCode)) {
        results.push({ ...base, status: 'error', code: 'LEVEL_NOT_FOUND' })
        errors += 1
        continue
      }

      const before = existing.get(r.storeCode) ?? {
        brand_code: null, brand_source: '', brand_locked: false,
        level_code: null, level_source: '', level_locked: false,
      }
      const nextBrand = r.brandProvided ? r.brandCode : before.brand_code
      const nextLevel = r.levelProvided ? r.levelCode : before.level_code

      const lockedBrand = r.brandProvided && before.brand_locked && nextBrand !== before.brand_code && !input.overrideLocked
      const lockedLevel = r.levelProvided && before.level_locked && nextLevel !== before.level_code && !input.overrideLocked
      if (lockedBrand || lockedLevel) {
        results.push({
          ...base, status: 'skipped', code: 'LOCKED',
          brandFrom: before.brand_code, brandTo: nextBrand,
          levelFrom: before.level_code, levelTo: nextLevel,
          changed: false,
        })
        skipped += 1
        continue
      }

      const next = {
        brandCode: nextBrand,
        brandSource: r.brandProvided ? 'manual' : before.brand_source,
        brandLocked: r.brandProvided ? true : before.brand_locked,
        levelCode: nextLevel,
        levelSource: r.levelProvided ? 'manual' : before.level_source,
        levelLocked: r.levelProvided ? true : before.level_locked,
      }
      const changed = nextBrand !== before.brand_code || nextLevel !== before.level_code

      if (!input.dryRun) {
        await upsertProfile(q as PoolClient, org, r.storeCode, next)
        existing.set(r.storeCode, {
          brand_code: next.brandCode, brand_source: next.brandSource, brand_locked: next.brandLocked,
          level_code: next.levelCode, level_source: next.levelSource, level_locked: next.levelLocked,
        })
      }

      results.push({
        ...base, status: 'ok',
        brandFrom: before.brand_code, brandTo: nextBrand,
        levelFrom: before.level_code, levelTo: nextLevel,
        changed,
      })
      applied += 1
    }

    return {
      dryRun: input.dryRun,
      total: normalized.length,
      applied,
      skipped,
      errors,
      duplicates,
      rows: results,
    }
  }

  if (input.dryRun) {
    return { ok: true, value: await run(deps.pool, false) }
  }

  const client = await deps.pool.connect()
  try {
    await client.query('begin')
    const result = await run(client, true)
    const errorRows = result.rows
      .filter((r) => r.status === 'error' || r.status === 'duplicate')
      .slice(0, 20)
      .map((r) => ({ row: r.row, storeCode: r.storeCode, code: r.code }))
    await writeAudit(client, org, actor, 'profile.import', '', {
      rows: result.total, applied: result.applied, skipped: result.skipped,
      errors: result.errors, duplicates: result.duplicates,
      overrideLocked: input.overrideLocked, errorRows,
    })
    await client.query('commit')
    return { ok: true, value: result }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ── 等级字典 ────────────────────────────────────────────────────────

function levelView(row: {
  code: string; name: string; sort: number; enabled: boolean; source: string; updated_at: Date | string | null
}): StoreLevelView {
  return {
    code: row.code,
    name: row.name,
    sort: Number(row.sort),
    enabled: row.enabled,
    source: row.source,
    updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString(),
  }
}

function parseLevelName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v === '' || v.length > 100 ? null : v
}

function parseSort(raw: unknown): number | null {
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) return null
  if (raw < -1_000_000 || raw > 1_000_000) return null
  return raw
}

export async function createStoreLevel(
  deps: { pool: Pool }, org: string, actor: string, input: StoreLevelCreateInput,
): Promise<StoreProfileResult<StoreLevelView>> {
  const code = asText(input.code) ?? ''
  if (!CODE_RE.test(code)) return err('INVALID_CODE')
  const name = parseLevelName(input.name)
  if (name === null) return err('INVALID_BODY')
  const sort = parseSort(input.sort)
  if (sort === null) return err('INVALID_BODY')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return err('INVALID_BODY')
  const enabled = input.enabled ?? true

  const client = await deps.pool.connect()
  try {
    await client.query('begin')
    const inserted = await client.query(
      `insert into data.store_level_registry(org, code, name, sort, enabled, source)
       values ($1, $2, $3, $4, $5, 'manual')
       on conflict (org, code) do nothing
       returning code, name, sort, enabled, source, updated_at`,
      [org, code, name, sort, enabled],
    )
    if (inserted.rows.length === 0) {
      await client.query('rollback')
      return err('DUP_CODE', code)
    }
    await writeAudit(client, org, actor, 'level.create', '', { code, name, sort, enabled })
    await client.query('commit')
    return { ok: true, value: levelView(inserted.rows[0]) }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function updateStoreLevel(
  deps: { pool: Pool }, org: string, actor: string, codeRaw: string, input: StoreLevelUpdateInput,
): Promise<StoreProfileResult<StoreLevelView>> {
  const code = codeRaw.trim()
  if (!CODE_RE.test(code)) return err('NOT_FOUND', code)
  if (input.name === undefined && input.sort === undefined && input.enabled === undefined) {
    return err('INVALID_BODY')
  }
  if (input.name !== undefined && parseLevelName(input.name) === null) return err('INVALID_BODY')
  if (input.sort !== undefined && parseSort(input.sort) === null) return err('INVALID_BODY')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return err('INVALID_BODY')

  const client = await deps.pool.connect()
  try {
    await client.query('begin')
    const before = await client.query(
      `select code, name, sort, enabled, source, updated_at
         from data.store_level_registry where org = $1 and code = $2 for update`,
      [org, code],
    )
    if (before.rows.length === 0) {
      await client.query('rollback')
      return err('NOT_FOUND', code)
    }
    const row = before.rows[0] as {
      code: string; name: string; sort: number; enabled: boolean; source: string; updated_at: Date | string | null
    }
    const name = input.name === undefined ? row.name : parseLevelName(input.name)!
    const sort = input.sort === undefined ? Number(row.sort) : parseSort(input.sort)!
    const enabled = input.enabled === undefined ? row.enabled : input.enabled
    const updated = await client.query(
      `update data.store_level_registry
          set name = $3, sort = $4, enabled = $5, updated_at = now()
        where org = $1 and code = $2
        returning code, name, sort, enabled, source, updated_at`,
      [org, code, name, sort, enabled],
    )
    await writeAudit(client, org, actor, 'level.update', '', {
      code,
      from: { name: row.name, sort: Number(row.sort), enabled: row.enabled },
      to: { name, sort, enabled },
    })
    await client.query('commit')
    return { ok: true, value: levelView(updated.rows[0]) }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
