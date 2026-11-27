// store-profile.test.ts — 门店画像域层（#2924）：单店编辑 / 批量导入 / 等级字典。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import {
  createStoreLevel,
  importStoreProfiles,
  updateStoreLevel,
  updateStoreProfile,
} from './store-profile'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = `org-store-profile-${Math.random().toString(36).slice(2, 8)}`
const ACTOR = 'alice'

let pool: Pool

describePg('store-profile（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    await clean()
    await pool.query(
      `insert into data.dim_branch(org, code, name, enable, source_book, snapshot)
       values ($1,'S1','一店',true,'3120',current_date),
              ($1,'S2','二店',true,'3120',current_date)`,
      [ORG],
    )
    await pool.query(
      `insert into data.brand_registry(org, code, name) values
         ($1,'xiongmao','熊喵'), ($1,'pptd','品品甜')`,
      [ORG],
    )
    await pool.query(
      `insert into data.store_level_registry(org, code, name, sort) values
         ($1,'A','一级',1), ($1,'B','二级',2)`,
      [ORG],
    )
  })

  afterAll(async () => {
    await clean().catch(() => {})
    await pool.end().catch(() => {})
  })

  async function clean(): Promise<void> {
    await pool.query('delete from data.store_profile_audit where org = $1', [ORG])
    await pool.query('delete from data.store_profile where org = $1', [ORG])
    await pool.query('delete from data.brand_assignment where org = $1', [ORG])
    await pool.query('delete from data.brand_registry where org = $1', [ORG])
    await pool.query('delete from data.store_level_registry where org = $1', [ORG])
    await pool.query('delete from data.dim_branch where org = $1', [ORG])
  }

  async function profileOf(storeCode: string) {
    const r = await pool.query(
      'select * from data.store_profile where org = $1 and store_code = $2', [ORG, storeCode])
    return r.rows[0] as {
      brand_code: string | null; brand_source: string; brand_locked: boolean
      level_code: string | null; level_source: string; level_locked: boolean
    } | undefined
  }

  async function auditActions(): Promise<string[]> {
    const r = await pool.query(
      'select action from data.store_profile_audit where org = $1 order by id', [ORG])
    return r.rows.map((x: { action: string }) => x.action)
  }

  it('★ 单店编辑：品牌/等级落库、来源 manual、锁定、审计；null 清空', async () => {
    const r = await updateStoreProfile({ pool }, ORG, ACTOR, 'S1', {
      brandCode: 'xiongmao', levelCode: 'A',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({
      storeCode: 'S1', storeName: '一店',
      brandCode: 'xiongmao', brandName: '熊喵', brandSource: 'manual',
      levelCode: 'A', levelName: '一级', levelSource: 'manual',
    })
    expect(await profileOf('S1')).toMatchObject({
      brand_code: 'xiongmao', brand_source: 'manual', brand_locked: true,
      level_code: 'A', level_source: 'manual', level_locked: true,
    })
    expect(await auditActions()).toContain('profile.update')

    // 只清品牌：等级保持不变（PUT 缺省字段 = 保持不变）
    const cleared = await updateStoreProfile({ pool }, ORG, ACTOR, 'S1', { brandCode: null })
    expect(cleared.ok && cleared.value.brandCode).toBe(null)
    expect(cleared.ok && cleared.value.levelCode).toBe('A')
  })

  it('单店编辑：未知门店/品牌/等级逐个拒绝', async () => {
    expect(await updateStoreProfile({ pool }, ORG, ACTOR, 'NOPE', { brandCode: 'xiongmao' }))
      .toMatchObject({ ok: false, code: 'INVALID_STORE' })
    expect(await updateStoreProfile({ pool }, ORG, ACTOR, 'S1', { brandCode: 'nope' }))
      .toMatchObject({ ok: false, code: 'INVALID_BRAND' })
    expect(await updateStoreProfile({ pool }, ORG, ACTOR, 'S1', { levelCode: 'Z' }))
      .toMatchObject({ ok: false, code: 'INVALID_LEVEL' })
    // 空 body 也不该被当成「清空」
    expect(await updateStoreProfile({ pool }, ORG, ACTOR, 'S1', {}))
      .toMatchObject({ ok: false, code: 'INVALID_BODY' })
  })

  it('★ 批量导入：dry-run 不写、逐行错误；apply 事务落库 + 批次审计', async () => {
    // 先给 S1 一个手工锁定值
    await updateStoreProfile({ pool }, ORG, ACTOR, 'S1', { brandCode: 'xiongmao', levelCode: 'A' })
    const rows = [
      { storeCode: 'S1', brandCode: 'pptd', levelCode: 'B' }, // locked ⇒ 跳过
      { storeCode: 'S2', brandCode: 'pptd', levelCode: 'B' }, // ok
      { storeCode: 'NOPE', brandCode: 'pptd', levelCode: 'B' }, // STORE_NOT_FOUND
      { storeCode: 'S2', brandCode: 'pptd', levelCode: 'A' }, // duplicate（后者覆盖）
    ]

    const dry = await importStoreProfiles({ pool }, ORG, ACTOR, {
      dryRun: true, overrideLocked: false, rows,
    })
    expect(dry.ok).toBe(true)
    if (!dry.ok) return
    expect(dry.value).toMatchObject({ dryRun: true, total: 4, skipped: 1, errors: 1, duplicates: 1 })
    const byRow = (n: number) => dry.value.rows.find((x) => x.row === n)!
    expect(byRow(1)).toMatchObject({ status: 'skipped', code: 'LOCKED' })
    expect(byRow(2)).toMatchObject({ status: 'duplicate', code: 'DUPLICATE' })
    expect(byRow(3)).toMatchObject({ status: 'error', code: 'STORE_NOT_FOUND' })
    expect(byRow(4).status).toBe('ok')
    expect(byRow(4).code).toBeUndefined()
    // dry-run 不写：S2 没有 profile
    expect(await profileOf('S2')).toBeUndefined()

    const applied = await importStoreProfiles({ pool }, ORG, ACTOR, {
      dryRun: false, overrideLocked: false, rows,
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value).toMatchObject({ dryRun: false, skipped: 1, errors: 1, duplicates: 1 })
    // S1 的锁定值没被覆盖
    expect(await profileOf('S1')).toMatchObject({ brand_code: 'xiongmao', level_code: 'A' })
    // S2 取后者（level A）
    expect(await profileOf('S2')).toMatchObject({
      brand_code: 'pptd', brand_source: 'manual', brand_locked: true,
      level_code: 'A', level_source: 'manual', level_locked: true,
    })
    expect(await auditActions()).toContain('profile.import')
  })

  it('批量导入：overrideLocked 才覆盖手工值；__clear__ 清空', async () => {
    const r = await importStoreProfiles({ pool }, ORG, ACTOR, {
      dryRun: false, overrideLocked: true,
      rows: [{ storeCode: 'S1', brandCode: 'pptd', levelCode: 'B' }],
    })
    expect(r.ok).toBe(true)
    expect(await profileOf('S1')).toMatchObject({
      brand_code: 'pptd', brand_locked: true, level_code: 'B', level_locked: true,
    })
    const clear = await importStoreProfiles({ pool }, ORG, ACTOR, {
      dryRun: false, overrideLocked: true,
      rows: [{ storeCode: 'S1', brandCode: '__clear__' }],
    })
    expect(clear.ok).toBe(true)
    expect(await profileOf('S1')).toMatchObject({
      brand_code: null, brand_source: 'manual', level_code: 'B', // 未提供 level ⇒ 保持
    })
  })

  it('批量导入：空 rows / 超上限拒绝', async () => {
    expect(await importStoreProfiles({ pool }, ORG, ACTOR, { dryRun: true, overrideLocked: false, rows: [] }))
      .toMatchObject({ ok: false, code: 'INVALID_BODY' })
    const rows = Array.from({ length: 5001 }, (_, i) => ({ storeCode: `X${i}`, brandCode: 'xiongmao' }))
    expect(await importStoreProfiles({ pool }, ORG, ACTOR, { dryRun: true, overrideLocked: false, rows }))
      .toMatchObject({ ok: false, code: 'TOO_MANY_ROWS' })
  })

  it('★ 等级字典：create / duplicate / update / 禁用不删 / 未知码', async () => {
    const created = await createStoreLevel({ pool }, ORG, ACTOR, { code: 'C', name: '三级', sort: 3 })
    expect(created.ok).toBe(true)
    expect(created.ok && created.value).toMatchObject({ code: 'C', name: '三级', sort: 3, enabled: true })

    expect(await createStoreLevel({ pool }, ORG, ACTOR, { code: 'C', name: '重复' }))
      .toMatchObject({ ok: false, code: 'DUP_CODE' })
    expect(await createStoreLevel({ pool }, ORG, ACTOR, { code: '__bad__', name: 'x' }))
      .toMatchObject({ ok: false, code: 'INVALID_CODE' })

    const updated = await updateStoreLevel({ pool }, ORG, ACTOR, 'C', {
      name: '三级（停用）', enabled: false,
    })
    expect(updated.ok).toBe(true)
    expect(updated.ok && updated.value).toMatchObject({ code: 'C', name: '三级（停用）', enabled: false })
    const still = await pool.query(
      'select enabled from data.store_level_registry where org = $1 and code = $2', [ORG, 'C'])
    expect(still.rows[0].enabled).toBe(false) // 禁用是软停，不是删除

    expect(await updateStoreLevel({ pool }, ORG, ACTOR, 'Z', { name: 'x' }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await updateStoreLevel({ pool }, ORG, ACTOR, 'C', {}))
      .toMatchObject({ ok: false, code: 'INVALID_BODY' })
    expect(await auditActions()).toEqual(expect.arrayContaining(['level.create', 'level.update']))
  })
})
