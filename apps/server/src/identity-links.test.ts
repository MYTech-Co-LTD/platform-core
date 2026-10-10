// identity-links.test.ts — platform.identity_link 宿主侧读写层 + IdentityLinks 服务（账户统一设计 §1.2/§2）（TDD）
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
// IdentityLinks 服务（Task 6，设计稿 §2 三层供给的自动匹配 + 人工修正）：
//  ⑦ maskPhone 纯函数：前 3 后 2 中间 ****；短串全遮；null 透传
//  ⑧ matchOnApplication：唯一命中即绑（active+auto）/ 多命中 pending+candidates /
//    未命中 ensureUser 建草稿+pending / 已 active 幂等不改行 / 手机号无效同未命中族
//  ⑨ confirm/rebind/revoke/dispute：confirm/rebind 先 casdoor 验户（null ⇒ LINK_TARGET_MISSING）、
//    状态机与 audit 同事务落行（action=identity.link.*，detail 带 id/from/to/actor）、
//    **disputed 落 disputed_at**（DDL 该列此前无写通路——评审裁决必验）
//  ⑩ describeOwn/listForOrg 视图：phone 只出掩码、createdAt ISO、status 过滤
//
// org 一例一号（存储层 o1/o2/o3/o4/o5、服务层 m1…）：identity_link 无 FK、org 是纯 text，
// 用例间互不踩；upsert 幂等 ⇒ 重复跑同一库结果不变。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrate'
import {
  createIdentityLinks,
  findActiveLink,
  findLinkByExternal,
  listActiveExternalIds,
  listCandidatesByPhone,
  maskPhone,
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
  it('maskPhone：前 3 后 2 中间 ****；短串全遮（规则会露光）；null 透传', () => {
    expect(maskPhone('13800001111')).toBe('138****11')
    expect(maskPhone(null)).toBeNull()
    expect(maskPhone('abc')).toBe('****') // 长度 <6 时「前3后2」会把整串露出来 ⇒ 全遮
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

// Casdoor 替身：形状照 casdoor-client.ts 实测（getUser 回 {name,roles,isAdmin}、不存在返 null；
// ensureUser 只传 5 字段、建号副作用由替身记录）。服务只依赖这两个方法。
function fakeCasdoorFor(ensured: string[], missingUsers: string[] = []) {
  return (org: string) => ({
    getUser: async (name: string) =>
      missingUsers.includes(name) ? null : { name, roles: [] as string[], isAdmin: false },
    ensureUser: async (name: string) => {
      ensured.push(`${org}/${name}`)
    },
  })
}

describe.skipIf(!dbUrl)('IdentityLinks 服务（真 PG）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })

  afterAll(async () => {
    await pool.end()
  })

  it('唯一命中 ⇒ active+bound_via=auto，返回 {state:"active"}', async () => {
    // 置信池：m1 里 alice 的 active 行占住手机号
    await upsertLink(pool, {
      org: 'm1', provider: 'wechat-oa', externalId: 'w-a', casdoorName: 'alice',
      phone: '13700001111', boundVia: 'manual', status: 'active', sourceApprovalId: null,
    })
    const ensured: string[] = []
    const svc = createIdentityLinks(pool, fakeCasdoorFor(ensured))
    const r = await svc.matchOnApplication({
      org: 'm1', provider: 'wechat-oa', externalId: 'w-b', phone: '137 0000 1111', approvalId: 11,
    })
    expect(r).toEqual({ state: 'active' })
    const row = await findLinkByExternal(pool, 'm1', 'wechat-oa', 'w-b')
    expect(row?.status).toBe('active')
    expect(row?.boundVia).toBe('auto')
    expect(row?.casdoorName).toBe('alice')
    expect(row?.phone).toBe('13700001111') // 归一后的强键落行
    expect(row?.sourceApprovalId).toBe(11)
    expect(ensured).toEqual([]) // 命中即绑，不建草稿
  })

  it('多命中 ⇒ pending + 返回 candidates（不绑）', async () => {
    await upsertLink(pool, {
      org: 'm2', provider: 'wechat-oa', externalId: 'w-c1', casdoorName: 'carol',
      phone: '13600002222', boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'm2', provider: 'wecom', externalId: 'w-c2', casdoorName: 'cathy',
      phone: '13600002222', boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    const svc = createIdentityLinks(pool, fakeCasdoorFor([]))
    const r = await svc.matchOnApplication({
      org: 'm2', provider: 'wechat-oa', externalId: 'w-n', phone: '13600002222', approvalId: 12,
    })
    expect(r.state).toBe('multi')
    expect([...r.candidates!].sort()).toEqual(['carol', 'cathy'])
    const row = await findLinkByExternal(pool, 'm2', 'wechat-oa', 'w-n')
    expect(row?.status).toBe('pending')
    expect(row?.boundVia).toBeNull() // 不自动绑
    expect(row?.phone).toBe('13600002222')
    expect(['carol', 'cathy']).toContain(row?.casdoorName) // 行上先落首个候选作机器建议
  })

  it('未命中 ⇒ ensureUser(externalId) 建草稿 + pending，返回 {state:"draft"}', async () => {
    const ensured: string[] = []
    const svc = createIdentityLinks(pool, fakeCasdoorFor(ensured))
    const r = await svc.matchOnApplication({
      org: 'm3', provider: 'wechat-oa', externalId: 'w-d', phone: '13500003333', approvalId: 13,
    })
    expect(r).toEqual({ state: 'draft' })
    expect(ensured).toEqual(['m3/w-d']) // 草稿 Casdoor user 名 = externalId，建在**本 org**
    const row = await findLinkByExternal(pool, 'm3', 'wechat-oa', 'w-d')
    expect(row?.status).toBe('pending')
    expect(row?.casdoorName).toBe('w-d')
    expect(row?.boundVia).toBeNull()
    expect(row?.sourceApprovalId).toBe(13)
  })

  it('已 active 的 openid 重复提交申请 ⇒ 幂等返回 {state:"active"}，不改行', async () => {
    await upsertLink(pool, {
      org: 'm4', provider: 'wechat-oa', externalId: 'w-e', casdoorName: 'eve',
      phone: '13400004444', boundVia: 'auto', status: 'active', sourceApprovalId: 1,
    })
    const ensured: string[] = []
    const svc = createIdentityLinks(pool, fakeCasdoorFor(ensured))
    // 带不同的 phone/approvalId 再申请：active 是终态，不该被后续申请改写
    const r = await svc.matchOnApplication({
      org: 'm4', provider: 'wechat-oa', externalId: 'w-e', phone: '13300005555', approvalId: 99,
    })
    expect(r).toEqual({ state: 'active' })
    const row = await findLinkByExternal(pool, 'm4', 'wechat-oa', 'w-e')
    expect(row?.phone).toBe('13400004444')
    expect(row?.sourceApprovalId).toBe(1)
    expect(row?.casdoorName).toBe('eve')
    expect(row?.boundVia).toBe('auto')
    expect(ensured).toEqual([])
  })

  it('手机号无效 ⇒ 与未命中同族（draft+pending），phone 落 null', async () => {
    const ensured: string[] = []
    const svc = createIdentityLinks(pool, fakeCasdoorFor(ensured))
    const r = await svc.matchOnApplication({
      org: 'm5', provider: 'wechat-oa', externalId: 'w-f', phone: '010-1234', approvalId: 14,
    })
    expect(r).toEqual({ state: 'draft' })
    expect(ensured).toEqual(['m5/w-f'])
    const row = await findLinkByExternal(pool, 'm5', 'wechat-oa', 'w-f')
    expect(row?.status).toBe('pending')
    expect(row?.phone).toBeNull() // 无效手机号不落行（不能当强键用）
  })

  it('confirm/rebind/revoke/dispute 的状态机与 audit 落行（action=identity.link.*）', async () => {
    const seeded = await upsertLink(pool, {
      org: 'm6', provider: 'wechat-oa', externalId: 'w-g', casdoorName: 'grace',
      phone: null, boundVia: null, status: 'pending', sourceApprovalId: 15,
    })
    const svc = createIdentityLinks(pool, fakeCasdoorFor([], ['ghost']))

    // confirm/rebind 先验户：目标账户在 Casdoor 不存在 ⇒ LINK_TARGET_MISSING，行不动
    await expect(svc.confirm('m6', seeded.id, 'ghost')).rejects.toThrow('LINK_TARGET_MISSING')
    await expect(svc.rebind('m6', seeded.id, 'ghost')).rejects.toThrow('LINK_TARGET_MISSING')
    expect((await findLinkByExternal(pool, 'm6', 'wechat-oa', 'w-g'))?.status).toBe('pending')
    // 本 org 但 id 不存在 ⇒ LINK_NOT_FOUND
    await expect(svc.confirm('m6', 999999999)).rejects.toThrow('LINK_NOT_FOUND')

    // confirm（缺省目标 = 行上账户）⇒ active + manual
    await svc.confirm('m6', seeded.id)
    expect((await findLinkByExternal(pool, 'm6', 'wechat-oa', 'w-g'))?.status).toBe('active')
    expect((await findLinkByExternal(pool, 'm6', 'wechat-oa', 'w-g'))?.boundVia).toBe('manual')

    // rebind 换绑 ⇒ casdoorName 换人、仍 active
    await svc.rebind('m6', seeded.id, 'heidi')
    const rebound = await findLinkByExternal(pool, 'm6', 'wechat-oa', 'w-g')
    expect(rebound?.casdoorName).toBe('heidi')
    expect(rebound?.status).toBe('active')

    // revoke ⇒ revoked + revoked_by/revoked_at
    await svc.revoke('m6', seeded.id, 'boss1')
    const revoked = await findLinkByExternal(pool, 'm6', 'wechat-oa', 'w-g')
    expect(revoked?.status).toBe('revoked')

    // dispute ⇒ disputed + **disputed_at 落值**（DDL 列此前无写通路——评审裁决项）
    expect(await svc.dispute('m6', 'w-g')).toBe(true)
    const disputed = await findLinkByExternal(pool, 'm6', 'wechat-oa', 'w-g')
    expect(disputed?.status).toBe('disputed')
    const { rows: disputedAt } = await pool.query<{ disputed_at: Date | null }>(
      'select disputed_at from platform.identity_link where id = $1',
      [seeded.id],
    )
    expect(disputedAt[0]!.disputed_at).not.toBeNull()

    // 未绑定的 externalId ⇒ false，且不落 audit
    expect(await svc.dispute('m6', 'no-such-openid')).toBe(false)

    // audit 四行齐全且同事务语义可见：detail 带 id/from/to/actor；org 无 tenant 行 ⇒ tenant_id 为 null
    const { rows: audits } = await pool.query<{
      action: string
      actor: string | null
      detail: Record<string, unknown>
      tenant_id: number | null
    }>(
      "select action, actor, detail, tenant_id from platform.audit"
      + " where action like 'identity.link.%' and detail->>'org' = 'm6' order by id",
    )
    expect(audits.map((a) => a.action)).toEqual([
      'identity.link.confirm', 'identity.link.rebind', 'identity.link.revoke', 'identity.link.dispute',
    ])
    expect(audits[0]!.detail).toMatchObject({ id: seeded.id, from: 'pending', to: 'active' })
    expect(audits[1]!.detail).toMatchObject({ id: seeded.id, from: 'grace', to: 'heidi' })
    expect(audits[2]!.detail).toMatchObject({ id: seeded.id, to: 'revoked' })
    expect(audits[2]!.actor).toBe('boss1')
    expect(audits[3]!.detail).toMatchObject({ id: seeded.id, from: 'revoked', to: 'disputed' })
    expect(audits[3]!.actor).toBe('w-g') // 异议是本人提起：actor = 外部身份
  })

  it('describeOwn/listForOrg 出视图：phone 只出掩码、createdAt ISO、status 过滤', async () => {
    await upsertLink(pool, {
      org: 'm7', provider: 'wechat-oa', externalId: 'w-h', casdoorName: 'ivy',
      phone: '13800001111', boundVia: 'auto', status: 'active', sourceApprovalId: null,
    })
    await upsertLink(pool, {
      org: 'm7', provider: 'wecom', externalId: 'w-i', casdoorName: 'jack',
      phone: null, boundVia: null, status: 'pending', sourceApprovalId: null,
    })
    const svc = createIdentityLinks(pool, fakeCasdoorFor([]))
    const own = await svc.describeOwn('m7', 'w-h')
    expect(own).toMatchObject({
      provider: 'wechat-oa', externalId: 'w-h', casdoorName: 'ivy',
      status: 'active', phoneMasked: '138****11', boundVia: 'auto',
    })
    expect(typeof own!.createdAt).toBe('string')
    expect(new Date(own!.createdAt).toString()).not.toBe('Invalid Date')
    expect(own).not.toHaveProperty('phone') // 视图绝不外泄完整手机号
    expect(await svc.describeOwn('m7', 'no-such')).toBeNull()

    const all = await svc.listForOrg('m7')
    expect(all.map((v) => v.externalId).sort()).toEqual(['w-h', 'w-i'])
    expect(all.every((v) => typeof v.createdAt === 'string')).toBe(true)
    const pendingOnly = await svc.listForOrg('m7', 'pending')
    expect(pendingOnly.map((v) => v.externalId)).toEqual(['w-i'])
    expect(await svc.listForOrg('m7', 'disputed')).toEqual([])
  })

  it('confirm/rebind 带 opts.actor ⇒ audit actor 列与 detail.actor 都落执行人（Task 8 管理面）', async () => {
    // m8 是本文件专键；先清本 org 的 audit 残留，让「恰好 3 行」的断言对重复跑库幂等
    //（m6 那条的累积红是已知账，T6-fix 收敛——本条不再添同类账）
    await pool.query("delete from platform.audit where detail->>'org' = 'm8'")
    const seeded = await upsertLink(pool, {
      org: 'm8', provider: 'wechat-oa', externalId: 'w-j', casdoorName: 'kate',
      phone: null, boundVia: null, status: 'pending', sourceApprovalId: null,
    })
    const svc = createIdentityLinks(pool, fakeCasdoorFor([]))
    await svc.confirm('m8', seeded.id, undefined, { actor: 'admin8' })
    await svc.rebind('m8', seeded.id, 'lily', { actor: 'admin9' })
    await svc.confirm('m8', seeded.id) // 缺省 opts ⇒ actor 回落 null（Task 6 既有形状不回归）

    const { rows } = await pool.query<{ action: string; actor: string | null; detail: Record<string, unknown> }>(
      "select action, actor, detail from platform.audit"
      + " where action in ('identity.link.confirm','identity.link.rebind') and detail->>'org' = 'm8' order by id",
    )
    expect(rows.map((r) => r.action)).toEqual([
      'identity.link.confirm', 'identity.link.rebind', 'identity.link.confirm',
    ])
    expect(rows[0]!.actor).toBe('admin8')
    expect(rows[0]!.detail).toMatchObject({ target: 'kate', actor: 'admin8' })
    expect(rows[1]!.actor).toBe('admin9')
    expect(rows[1]!.detail).toMatchObject({ from: 'kate', to: 'lily', actor: 'admin9' })
    expect(rows[2]!.actor).toBeNull()
    expect(rows[2]!.detail).toMatchObject({ actor: null })
  })
})
