import { describe, expect, it } from 'vitest'
import type { Identity } from '@platform/sdk'
import { guestIdentityIds, parseIdParam } from './context'

// 本模块【唯一】的路径 id 守卫（终审修复轮 1 起，7 处调用点共用一份）。
// 这条单测钉的是「什么形状算合法 id」这一层，各站点保留什么状态码由各自的端到端用例钉
// （见 ticket.test.ts / masterdata.test.ts），helper 只回 null。
describe('parseIdParam（路径参数 :id 的共享守卫）', () => {
  it('接受十进制正整数字面量', () => {
    expect(parseIdParam('1')).toBe(1)
    expect(parseIdParam('42')).toBe(42)
    expect(parseIdParam('007')).toBe(7) // 前导零无害：Number('007') 仍落在安全整数内
    expect(parseIdParam(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('越界值一律否掉——这正是修掉 500 的那一档（Number.isInteger(1e23) === true）', () => {
    // 修前：`Number.isInteger(id)` 放行 1e23 / 超长数字串 ⇒ 值落进 pg 的 bigint 参数位
    // ⇒ 22P02 ⇒ Hono 兜成 500（实测 GET /api/modules/aftersales/tickets/1e23 ⇒ 500）。
    expect(parseIdParam('1e23')).toBeNull()
    expect(parseIdParam('99999999999999999999999')).toBeNull()
    expect(parseIdParam('9007199254740992')).toBeNull() // MAX_SAFE_INTEGER + 1
    expect(parseIdParam('1e30')).toBeNull()
  })

  it('非规范字面量一律否掉——修前被静默接受成某个 id', () => {
    // 修前 `Number('1.0') === 1`、`Number('1e2') === 100` ⇒ 静默当作 id=1 / id=100（实测 404）。
    // 终审判定这是修掉歧义，不是回归。
    expect(parseIdParam('1.0')).toBeNull()
    expect(parseIdParam('1e2')).toBeNull()
    expect(parseIdParam('0x10')).toBeNull()
    expect(parseIdParam('+1')).toBeNull()
    expect(parseIdParam(' 1')).toBeNull()
    expect(parseIdParam('1 ')).toBeNull()
  })

  it('非正数 / 空 / 缺失 / 非数字一律否掉', () => {
    expect(parseIdParam('-1')).toBeNull()
    expect(parseIdParam('0')).toBeNull()
    expect(parseIdParam('abc')).toBeNull()
    expect(parseIdParam('')).toBeNull()
    expect(parseIdParam(undefined)).toBeNull()
    expect(parseIdParam('NaN')).toBeNull()
    expect(parseIdParam('Infinity')).toBeNull()
    expect(parseIdParam('1/2')).toBeNull()
  })
})

// guestIdentityIds（I-1，终审修复）：空绑定集合悬崖——最后一条 active link 被撤销/争议后，
// 正式态 session 重签出 boundExternalIds=[]，直接当读谓词是 ANY('{}') 全空（看不见自己、
// 还会重复申请）；写侧仍按登录 openid ⇒ 读写两歧。修后：空数组与 undefined 同口径回落登录 openid。
describe('guestIdentityIds（guest 面身份集合；空绑定集合=回退登录 openid）', () => {
  const identity = (boundExternalIds?: string[]): Identity => ({
    userId: 'openid-me', orgId: 'ff-org', displayName: 'me', scopes: [], hasScope: () => true,
    boundExternalIds,
  })

  it('undefined（中间态/旧会话）⇒ [登录 openid]', () => {
    expect(guestIdentityIds(identity(undefined))).toEqual(['openid-me'])
  })

  it('[]（撤销全部绑定后正式态 session 重签出空集合）⇒ 回落 [登录 openid]', () => {
    expect(guestIdentityIds(identity([]))).toEqual(['openid-me'])
  })

  it('非空集合原样返回（正式态按绑定集合收窄，顺序不作承诺）', () => {
    expect(guestIdentityIds(identity(['oa-1', 'wecom-2']))).toEqual(['oa-1', 'wecom-2'])
  })
})
