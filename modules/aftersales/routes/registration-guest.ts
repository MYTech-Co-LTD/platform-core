// routes/registration-guest.ts — 访客面：我的登记 / 提交登记变更 / 选商品（spec §2.5）。
//
// 身份：访客 session（identity.userId = openid、orgId = 租户），**不查 Casdoor**（§1.3——
// 移动端面向加盟商，是外部身份）。
//
// 「有限制」落在业务数据上：提交工单前必须有已审批的登记 —— 该判定在 M3b-2 的移动端消费
// `GET /guest/me/registration` 的结果；**本文件不替它决定 UI 怎么呈现**。
import { z } from 'zod'
import { RegistrationError, computeRegistration } from '../domain/registration'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/** 目标值：客户端只表达「我要变成什么」（spec §2.5 纪律②），差异由服务端算 */
const TargetBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50),
  // 门店 id 落 bigint 列 ⇒ `.safe()`（M2a I-1 的教训：`z.number().int()` 的 int 就是
  // `Number.isInteger`，而 `Number.isInteger(1e30) === true` ⇒ 放行后落进 pg 参数位 ⇒ 22P02
  // ⇒ Hono 兜成 500）。全模块 bigint 列只用这一种写法。
  storeIds: z.array(z.number().int().positive().safe()).max(50),
})

interface MySnapshot {
  id: number
  name: string
  phone: string
  storeIds: number[]
}

/** 读「我的档案」快照：employee 行 + employee_store 展开。**org + open_id 双向收窄**。 */
async function readMySnapshot(ctx: RouteCtx, org: string, openid: string): Promise<MySnapshot | null> {
  const emp = await ctx.pool.query<{ id: string; name: string; phone: string }>(
    `select id, name, phone from aftersales.employee
      where org = $1 and open_id = $2 and approve_status = 'approved'`,
    [org, openid],
  )
  const row = emp.rows[0]
  if (!row) return null
  const stores = await ctx.pool.query<{ store_id: string }>(
    `select store_id from aftersales.employee_store where org = $1 and employee_id = $2 order by store_id`,
    [org, Number(row.id)],
  )
  return { id: Number(row.id), name: row.name, phone: row.phone, storeIds: stores.rows.map((s) => Number(s.store_id)) }
}

/** ILIKE 的 `%` `_` 在搜索词里是通配符——转义掉，否则用户输入 `%` 等于全表匹配（同 masterdata.ts） */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

export function registerRegistrationGuest(r: ModuleHono, ctx: RouteCtx): void {
  // ── 我的登记 ──────────────────────────────────────────────────────────────
  r.get('/guest/me/registration', async (c) => {
    const { orgId: org, userId: openid } = c.get('identity')
    const snap = await readMySnapshot(ctx, org, openid)
    const pending = await ctx.pool.query(
      `select 1 from aftersales.employee_approval where org = $1 and open_id = $2 and status = 'pending'`,
      [org, openid],
    )
    return c.json({
      registration: snap ? { name: snap.name, phone: snap.phone, storeIds: snap.storeIds } : null,
      hasPendingApproval: pending.rowCount! > 0,
    })
  })

  // ── 提交登记/变更 ────────────────────────────────────────────────────────
  r.post('/guest/employee-approvals', async (c) => {
    const { orgId: org, userId: openid } = c.get('identity')
    const parsed = TargetBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const target = parsed.data

    const snap = await readMySnapshot(ctx, org, openid)
    let diff: ReturnType<typeof computeRegistration>
    try {
      diff = computeRegistration(snap ? { name: snap.name, phone: snap.phone, storeIds: snap.storeIds } : null, target)
    } catch (e) {
      // 「您没有修改任何信息」——源侧同样是拒绝提交（不是静默成功）
      if (e instanceof RegistrationError) return c.json({ error: 'INVALID_BODY', message: e.message }, 400)
      throw e
    }

    try {
      const ins = await ctx.pool.query<{ id: string }>(
        `insert into aftersales.employee_approval(org, open_id, approve_type, old_info, new_info)
         values ($1, $2, $3, $4::jsonb, $5::jsonb) returning id`,
        [org, openid, diff.approveType, JSON.stringify(diff.oldInfo), JSON.stringify(diff.newInfo)],
      )
      return c.json({ id: Number(ins.rows[0]!.id), approveType: diff.approveType }, 201)
    } catch (e) {
      // ★ 防重**由库保证**（spec §2.5 纪律①）：部分唯一索引在并发下也拦得住。
      //   不先查后插——那正是源侧前端判定的做法，两个并发请求都能查到 0 条 ⇒ 都插入。
      if ((e as { code?: string }).code === '23505') return c.json({ error: 'APPROVAL_PENDING' }, 409)
      throw e
    }
  })

  // ── 选商品（M3b-2 的移动端要用）──────────────────────────────────────────
  // 与 `GET /products` 分面是**协议硬约束**：同一条 (method,path) 只能声明一次、一条声明只带
  // 一个 scope（spec §2.2 的同一条理由，与 /guest/tickets 同构）。
  r.get('/guest/products', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.product where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, name, spec, basic_quantity, basic_unit_price_minor from aftersales.product
        where ${where} order by id limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((p) => ({
        id: Number(p.id),
        name: p.name,
        spec: p.spec,
        basicQuantity: Number(p.basic_quantity),
        basicUnitPriceMinor: Number(p.basic_unit_price_minor),
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    })
  })

  // ── 选门店（M3b-2 的移动端要用；spec §3.2）──────────────────────────────
  // 与 `GET /stores` 分面是**协议硬约束**：同一条 (method,path) 只能声明一次、一条声明只带
  // 一个 scope（spec §2.2 的同一条理由，与 /guest/products 同构）。
  //
  // 两个调用方（实读源侧）：登记页按**名称**搜（`q`）；提交页按**我的登记 id** 取明细（`ids`）。
  // `ids` 不是可有可无——提交页的口径是「选我登记的门店」，id 来自 /guest/me/registration，
  // 而**名字**只能从这里取（源侧那半边靠拼 OR filter，是因为源数据源没有 id__in）。
  r.get('/guest/stores', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const idsRaw = c.req.query('ids')
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    if (idsRaw !== undefined) {
      // 约定：空串 = **空集**（调用方说「我没有任何门店」），不是「不过滤」——
      // 不过滤会把全量门店回给访客，是这批端点里最不该发生的一种静默降级。
      const parts = idsRaw === '' ? [] : idsRaw.split(',')
      // 只认十进制正整数字面量（与 parseIdParam 同一口径）：非规范写法（`1e3` / `-2` / `1.5`）
      // 一律 400，**不静默丢弃坏值**——少几个门店比报错难查得多。
      const nums = parts.map((t) => (/^\d+$/.test(t) ? Number(t) : NaN))
      if (nums.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
        return c.json({ error: 'INVALID_IDS' }, 400)
      }
      if (nums.length === 0) return c.json({ items: [], total: 0, page, size })
      params.push(nums)
      where += ` and id = any($${params.length}::bigint[])`
    }

    // 与 /guest/products 同构：回 total ⇒ 可真分页（对照 /stores 只回 {items}）
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.store where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, name, region_id, address, phone from aftersales.store
        where ${where} order by id limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((s) => ({
        id: Number(s.id),
        name: s.name,
        regionId: s.region_id === null ? null : Number(s.region_id),
        address: s.address,
        phone: s.phone,
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    })
  })
}
