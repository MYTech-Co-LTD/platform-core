// identity-links.test.ts — platform.identity_link 宿主侧读写层（账户统一设计 §1.2）（TDD）
//
// 真 PG（同 auth-wechat-oa.test.ts 约定）+ runMigrations 全量迁移；未提供 DATABASE_URL 时
// DB 用例整体跳过。覆盖存储契约六件：
//  ① normalizePhone 纯函数：取数字、13 位 86 前缀去 86、恰好 11 位才返回
//  ② upsertLink 冲突时**原地更新**（单行可变）：同键两次 upsert 同一行（id 不变），
//     不产生第二行；active 首绑盖 bound_at，非 active 重绑不抹
//  ③ findActiveLink 跨 provider（provider 不限）且只认 status='active'
//  ④ listActiveExternalIds 只列该账户的 active 外部 id（pending 不列）
//  ⑤ listCandidatesByPhone 只数 active、跨 provider distinct casdoor_name
//  ⑥ mutateLink：revoke 记 revoked_by/revoked_at；**org 不对取不到**（null）；
//     patch 只动带来的字段（换绑 casdoor_name 不碰 status）
//
// org 一例一号（o1/o2/o3/o4/o5）：identity_link 无 FK、org 是纯 text，用例间互不踩；
// upsert 幂等 ⇒ 重复跑同一库结果不变。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrate'
import {
  findActiveLink,
  findLinkByExternal,
  listActiveExternalIds,
  listCandidatesByPhone,
  mutateLink,
  normalizePhone,
  upsertLink,
} from './identity-links'

const dbUrl = process.env.DATABASE_URL

// 纯函数、不需要 DB ⇒ 刻意放在 describe.skipIf 之外（无 DATABASE_URL 时这几条仍跑）。
describe('normalizePhone（纯函数）', () => {
  it('11 位手机号原样返回；+86 前缀去之；座机/乱码返 null', () => {
    expect(normalizePhone('13800001111')).toBe('13800001111')
    expect(normalizePhone('+86 138-0000-1111')).toBe('13800001111')
    expect(normalizePhone('8613800001111')).toBe('13800001111') // 无分隔符的 86+11 位
    expect(normalizePhone('010-1234')).toBeNull() // 座机：去完非 11 位
    expect(normalizePhone('abc')).toBeNull() // 乱码：去完 0 位
  })
})

describe.skipIf(!dbUrl)('identity_link 读写层（真 PG）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })

  afterAll(async () => {
    await pool.end()
  })

  it('upsertLink 冲突时原地更新（单行可变）', async () => {
    const first = await upsertLink(pool, {
      org: 'o1', provider: 'wechat-oa', externalId: 'oA', casdoorName: 'u1',
      phone: '13800001111', boundVia: 'auto', status: 'active', sourceApprovalId: 7,
    })
    const second = await upsertLink(pool, {
      org: 'o1', provider: 'wechat-oa', externalId: 'oA', casdoorName: 'u2',
      phone: '13800001111', boundVia: 'manual', status: 'pending', sourceApprovalId: 8,
    })
    // 单行可变的硬证据：两次 upsert 是**同一行**（id 不变），库里也只有这一行
    expect(second.id).toBe(first.id)
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from platform.identity_link where provider='wechat-oa' and org='o1' and external_id='oA'",
    )
    expect(rows[0]!.n).toBe(1)
    const row = await findLinkByExternal(pool, 'o1', 'wechat-oa', 'oA')
    expect(row?.casdoorName).toBe('u2')
    expect(row?.status).toBe('pending')
    expect(row?.boundVia).toBe('manual')
    expect(row?.sourceApprovalId).toBe(8)
    // active 首绑盖了 bound_at；后续 pending 重绑不抹（历史时点留给 audit，行上只留最近绑定）
    const { rows: ts } = await pool.query<{ bound_at: Date | null }>(
      "select bound_at from platform.identity_link where provider='wechat-oa' and org='o1' and external_id='oA'",
    )
    expect(ts[0]!.bound_at).not.toBeNull()
    // 未绑定的键 → null（而不是抛错）
    expect(await findLinkByExternal(pool, 'o1', 'wechat-oa', 'no-such-openid')).toBeNull()
  })

  it('findActiveLink 跨 provider 命中且只认 active', async () => {
    // 同一外部身份 oB 在两渠道各一行：wechat-oa 行 pending（非正式态）、wecom 行 active
    await upsertLink(pool, {
      org: 'o2', provider: 'wechat-oa', externalId: 'oB', casdoorName: 'u_pending',
      phone: null, boundVia: null, status: 'pending', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'o2', provider: 'wecom', externalId: 'oB', casdoorName: 'u_wecom',
      phone: null, boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    // provider 不限：wechat-oa 的 pending 挡不住 wecom 的 active ⇒ 命中 wecom 的账户
    expect(await findActiveLink(pool, 'o2', 'oB')).toEqual({ casdoorName: 'u_wecom' })
    // 只有 pending 行的外部身份 ⇒ null（pending 不是正式态）
    expect(await findActiveLink(pool, 'o2', 'oB2')).toBeNull()
    await upsertLink(pool, {
      org: 'o2', provider: 'wechat-oa', externalId: 'oB2', casdoorName: 'u_only_pending',
      phone: null, boundVia: null, status: 'pending', sourceApprovalId: null,
    })
    expect(await findActiveLink(pool, 'o2', 'oB2')).toBeNull()
    // 不存在的外部身份 ⇒ null
    expect(await findActiveLink(pool, 'o2', 'no-such')).toBeNull()
  })

  it('listActiveExternalIds 只列该账户的 active 外部 id', async () => {
    await upsertLink(pool, {
      org: 'o5', provider: 'wechat-oa', externalId: 'oF', casdoorName: 'u5',
      phone: null, boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'o5', provider: 'wecom', externalId: 'oG', casdoorName: 'u5',
      phone: null, boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'o5', provider: 'wechat-oa', externalId: 'oH', casdoorName: 'u5',
      phone: null, boundVia: null, status: 'pending', sourceApprovalId: null,
    })
    // active 的两个渠道都列，pending 不列
    expect([...await listActiveExternalIds(pool, 'o5', 'u5')].sort()).toEqual(['oF', 'oG'])
    expect(await listActiveExternalIds(pool, 'o5', 'nobody')).toEqual([])
  })

  it('listCandidatesByPhone 只数 active、跨 provider 去重', async () => {
    await upsertLink(pool, {
      org: 'o3', provider: 'wechat-oa', externalId: 'oC', casdoorName: 'u3',
      phone: '13900002222', boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'o3', provider: 'wecom', externalId: 'oD', casdoorName: 'u3',
      phone: '13900002222', boundVia: 'manual', status: 'active', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'o3', provider: 'wechat-oa', externalId: 'oE', casdoorName: 'u4',
      phone: '13900002222', boundVia: null, status: 'revoked', sourceApprovalId: null,
    })
    // 同账户（u3）跨两 provider 各一行 ⇒ distinct 后只有一个候选；revoked 的 u4 不数
    expect(await listCandidatesByPhone(pool, 'o3', '13900002222')).toEqual(['u3'])
    expect(await listCandidatesByPhone(pool, 'o3', 'no-such-phone')).toEqual([])
  })

  it('mutateLink revoke 记 revoked_by/at；他 org 的 id 取不到（null）', async () => {
    const link = await upsertLink(pool, {
      org: 'o4', provider: 'wechat-oa', externalId: 'oR', casdoorName: 'u6',
      phone: null, boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    const revoked = await mutateLink(pool, 'o4', link.id, { status: 'revoked', revokedBy: 'boss1' })
    expect(revoked?.status).toBe('revoked')
    const { rows } = await pool.query<{ revoked_at: Date | null; revoked_by: string | null }>(
      'select revoked_at, revoked_by from platform.identity_link where id=$1',
      [link.id],
    )
    expect(rows[0]!.revoked_at).not.toBeNull()
    expect(rows[0]!.revoked_by).toBe('boss1')

    // 他 org 拿同一个 id ⇒ 取不到（null），且原行不被改
    expect(await mutateLink(pool, 'org-other', link.id, { status: 'disputed' })).toBeNull()
    const { rows: untouched } = await pool.query<{ status: string }>(
      'select status from platform.identity_link where id=$1',
      [link.id],
    )
    expect(untouched[0]!.status).toBe('revoked')
    // 本 org 但 id 不存在 ⇒ null
    expect(await mutateLink(pool, 'o4', 999999999, { status: 'disputed' })).toBeNull()

    // patch 只动带来的字段：换绑 casdoor_name 不碰 status
    const rebound = await mutateLink(pool, 'o4', link.id, { casdoorName: 'u6-new' })
    expect(rebound?.casdoorName).toBe('u6-new')
    expect(rebound?.status).toBe('revoked')
  })
})
