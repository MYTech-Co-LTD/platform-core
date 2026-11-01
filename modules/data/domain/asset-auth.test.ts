// asset-auth.test.ts — 资产级授权（spec 2026-11-01 §4）
//
// 纯函数部分穷举判据；存储部分（owner/viewer 落库、幂等、审计）走真 PG。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import {
  canEditAsset, canViewAsset, ensureOwner, isAdminOverride, isOwner,
  loadAssetAcl, replaceViewers, writeAssetAudit,
  type AclRow,
} from './asset-auth'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

const req = (userId: string, scopes: string[] = []) => ({
  userId,
  hasScope: (code: string) => scopes.includes(code),
})
const row = (over: Partial<{ visibility: 'tenant' | 'restricted'; requiredScope: string | null; requiredDepts: string[] | null }> = {}) => ({
  visibility: 'restricted' as const,
  requiredScope: null,
  requiredDepts: null,
  ...over,
})
const ownerRow = (user: string): AclRow => ({ subjectType: 'user', subjectId: user, relation: 'owner' })
const viewer = (t: AclRow['subjectType'], id: string): AclRow => ({ subjectType: t, subjectId: id, relation: 'viewer' })

describe('canViewAsset', () => {
  it('★ owner 恒可见（即使是 restricted 且无 viewer）', () => {
    expect(canViewAsset(row(), req('alice'), [ownerRow('alice')], undefined)).toBe(true)
  })

  it('★ restricted + 非 owner + 无 grant ⇒ 拒（**不回落旧粗门**）', () => {
    // 旧粗门允许「所有拿到本模块的人」；restricted 的意义就是不看它
    expect(canViewAsset(row({ requiredScope: null }), req('bob', ['data:query']), [ownerRow('alice')], undefined))
      .toBe(false)
  })

  it('★ 三类受让方都生效：点名 / 部门（在闭包内）/ 权限码', () => {
    const acl = [ownerRow('alice'), viewer('user', 'bob'), viewer('dept', '57'), viewer('scope', 'data:query')]
    expect(canViewAsset(row(), req('bob'), acl, undefined)).toBe(true)
    expect(canViewAsset(row(), req('carol'), acl, new Set(['49', '57']))).toBe(true)
    expect(canViewAsset(row(), req('dave', ['data:query']), acl, undefined)).toBe(true)
  })

  it('★ 部门受让方在"部门未解析"时**不算命中**（fail-closed）', () => {
    const acl = [ownerRow('alice'), viewer('dept', '57')]
    expect(canViewAsset(row(), req('carol'), acl, undefined)).toBe(false)
    expect(canViewAsset(row(), req('carol'), acl, new Set(['57']))).toBe(true)
  })

  it('history: visibility=tenant ⇒ 行为与改造前一致（旧粗门 + 部门门）', () => {
    const acl = [ownerRow('alice')]
    // requiredScope=null（本域兼"已发布"）⇒ 拿到模块的人可见
    expect(canViewAsset(row({ visibility: 'tenant' }), req('bob', ['data:query']), acl, undefined)).toBe(true)
    // 有内容门 ⇒ 要有码
    expect(canViewAsset(row({ visibility: 'tenant', requiredScope: 'data:query' }), req('bob'), acl, undefined)).toBe(false)
    expect(canViewAsset(row({ visibility: 'tenant', requiredScope: 'data:query' }), req('bob', ['data:query']), acl, undefined)).toBe(true)
    // 部门门：未解析 ⇒ 拒
    expect(canViewAsset(row({ visibility: 'tenant', requiredDepts: ['57'] }), req('bob', ['data:query']), acl, undefined)).toBe(false)
    expect(canViewAsset(row({ visibility: 'tenant', requiredDepts: ['57'] }), req('bob', ['data:query']), acl, new Set(['57']))).toBe(true)
  })

  it('★ viewer 不给编辑权（可看 ≠ 可改）', () => {
    const acl = [ownerRow('alice'), viewer('user', 'bob')]
    expect(canEditAsset(acl, req('bob'), 'data:manage')).toBe(false)
    expect(canEditAsset(acl, req('alice'), 'data:manage')).toBe(true)
    expect(canEditAsset(acl, req('admin', ['data:manage']), 'data:manage')).toBe(true)
  })

  it('isAdminOverride 区分"owner 自己改"与"管理员代管"', () => {
    const acl = [ownerRow('alice')]
    expect(isAdminOverride(acl, req('alice', ['data:manage']), 'data:manage')).toBe(false)
    expect(isAdminOverride(acl, req('admin', ['data:manage']), 'data:manage')).toBe(true)
    expect(isAdminOverride(acl, req('bob'), 'data:manage')).toBe(false)
  })

  it('isOwner / ownerOf 边界：历史资产无 owner 行', () => {
    expect(isOwner([], 'alice')).toBe(false)
  })
})

describePg('asset-auth 存储', () => {
  const ORG = 'org-asset-auth'
  const ASSET = 'asset-1'
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await pool.query('delete from data.asset_acl where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from data.asset_audit where org=$1', [ORG]).catch(() => {})
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query('delete from data.asset_acl where org=$1', [ORG])
    await pool.query('delete from data.asset_audit where org=$1', [ORG])
  })

  it('ensureOwner 幂等：同名 upsert 不抢所有权', async () => {
    await ensureOwner(pool, ORG, ASSET, 'alice')
    await ensureOwner(pool, ORG, ASSET, 'bob')   // 第二个人来"创建同名"
    const acl = await loadAssetAcl(pool, ORG, ASSET)
    expect(acl).toEqual([{ subjectType: 'user', subjectId: 'alice', relation: 'owner' }])
  })

  it('replaceViewers 是**整体覆盖**：第二次 PUT 删掉第一次的', async () => {
    await ensureOwner(pool, ORG, ASSET, 'alice')
    await replaceViewers(pool, ORG, ASSET, [viewer('user', 'bob'), viewer('dept', '57')], 'alice')
    expect((await loadAssetAcl(pool, ORG, ASSET)).filter((a) => a.relation === 'viewer')).toHaveLength(2)
    await replaceViewers(pool, ORG, ASSET, [viewer('scope', 'data:query')], 'alice')
    const acl = await loadAssetAcl(pool, ORG, ASSET)
    expect(acl.filter((a) => a.relation === 'viewer')).toEqual([
      { subjectType: 'scope', subjectId: 'data:query', relation: 'viewer' },
    ])
    // owner 不受 viewer 覆盖影响
    expect(acl.some((a) => a.relation === 'owner')).toBe(true)
  })

  it('审计落库：by_admin 标记可查', async () => {
    await writeAssetAudit(pool, {
      org: ORG, assetId: ASSET, actor: 'admin', action: 'acl.update',
      detail: { viewers: 1 }, byAdmin: true,
    })
    const { rows } = await pool.query(
      'select actor, action, by_admin from data.asset_audit where org=$1', [ORG],
    )
    expect(rows[0]).toMatchObject({ actor: 'admin', action: 'acl.update', by_admin: true })
  })
})
