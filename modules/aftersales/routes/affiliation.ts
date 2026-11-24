// routes/affiliation.ts — 访客档案读取与「门店归属一致性」判定（2026-11-24 归属双源 ADR §7 P1）。
//
// 为什么要单独一个文件：注册面（/guest/me/registration）与提单项面（POST /guest/tickets）都
// 需要「我的档案门店集合」。判定若各写一份，两边必然漂移（一处按 approve_status 过滤、一处忘），
// 而漂移的后果是**归属结论互相矛盾**。所以读取只有一个实现，归因判定只有一个函数。
//
// ⚠️ 本判定是**信息性**的，不是授权：ADR §3.1 已实测「提售后单不校验门店归属」，本文件只负责
// 把「提交人档案门店 vs 单据门店」的一致性算出来存快照，不改任何放行/拒绝行为（fail-open）。
import type { Identity } from '@platform/sdk'
import { guestIdentityIds } from './context'
import type { RouteCtx } from './context'

export interface MySnapshot {
  id: number
  name: string
  phone: string
  storeCodes: string[]
}

/**
 * 读「我的档案」快照：employee 行 + employee_store 展开。**org + open_id 双向收窄**；
 * open_id 按【绑定集合】判（账户统一设计 §4.1）——多绑身份在任一渠道登记的档案都算「我的」；
 * 中间态/旧会话集合 = 登录 openid 单元素，行为与旧的单 openid 逐字等价。
 */
export async function readMySnapshot(
  ctx: RouteCtx,
  org: string,
  openids: string[],
): Promise<MySnapshot | null> {
  const emp = await ctx.pool.query<{ id: string; name: string; phone: string }>(
    `select id, name, phone from aftersales.employee
      where org = $1 and open_id = any($2::text[]) and approve_status = 'approved'`,
    [org, openids],
  )
  const row = emp.rows[0]
  if (!row) return null
  const stores = await ctx.pool.query<{ store_code: string }>(
    `select store_code from aftersales.employee_store where org = $1 and employee_id = $2 order by store_code`,
    [org, Number(row.id)],
  )
  return { id: Number(row.id), name: row.name, phone: row.phone, storeCodes: stores.rows.map((s) => s.store_code) }
}

/**
 * 门店归属一致性（**快照语义**：记录提单那一刻的事实，档案后改不回溯）。
 *
 * - `matched`      档案存在，且单据门店在其门店集合里
 * - `mismatch`     档案存在，但单据门店不在其集合里（调店未更新 / 填错 / 借用他人账号）
 * - `unregistered` 无已通过档案（未注册或待审批）——ADR §3.1：这在当前覆盖下是**正常状态**
 * - `null`         判定失败（查库异常）——fail-open：绝不让归属判定挡住提单
 */
export type StoreAffiliation = 'matched' | 'mismatch' | 'unregistered'

export async function resolveStoreAffiliation(
  ctx: RouteCtx,
  org: string,
  identity: Identity,
  storeCode: string,
): Promise<StoreAffiliation | null> {
  try {
    const snap = await readMySnapshot(ctx, org, guestIdentityIds(identity))
    if (!snap) return 'unregistered'
    return snap.storeCodes.includes(storeCode) ? 'matched' : 'mismatch'
  } catch (e) {
    // 归属是**附加信息**，不是放行条件（ADR §3.1）：查不到/查挂了就不记，不阻断提单。
    console.warn('[aftersales] 归属一致性判定失败（已按 fail-open 放行）:', (e as Error)?.message)
    return null
  }
}
