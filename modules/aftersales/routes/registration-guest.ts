// routes/registration-guest.ts — 访客面：我的登记 / 提交登记变更 / 选商品（spec §2.5）。
//
// 身份：访客 session（identity.userId = openid、orgId = 租户），**不查 Casdoor**（§1.3——
// 移动端面向加盟商，是外部身份）。
//
// 「有限制」落在业务数据上：提交工单前必须有已审批的登记 —— 该判定在 M3b-2 的移动端消费
// `GET /guest/me/registration` 的结果；**本文件不替它决定 UI 怎么呈现**。
import { z } from 'zod'
import { RegistrationError, computeRegistration } from '../domain/registration'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, guestIdentityIds, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/** 目标值：客户端只表达「我要变成什么」（spec §2.5 纪律②），差异由服务端算 */
const TargetBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50),
  // 门店引用 = `data.dim_branch.code` 自然键（#476：消费源已切发布快照）。长度/字符集与
  // dim_branch.code 的发布契约对齐（源侧门店编号，十进制数字串为主）——宽松校验留给
  // 提交时的存在性校验（STORE_NOT_FOUND），这里只挡明显乱形。
  storeCodes: z.array(z.string().min(1).max(64)).max(50),
})

interface MySnapshot {
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
async function readMySnapshot(ctx: RouteCtx, org: string, openids: string[]): Promise<MySnapshot | null> {
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

/** ILIKE 的 `%` `_` 在搜索词里是通配符——转义掉，否则用户输入 `%` 等于全表匹配（同 masterdata.ts） */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

export function registerRegistrationGuest(r: ModuleHono, ctx: RouteCtx): void {
  // ── 我的登记 ──────────────────────────────────────────────────────────────
  r.get('/guest/me/registration', async (c) => {
    const identity = c.get('identity')
    const org = identity.orgId
    const openids = guestIdentityIds(identity)
    const snap = await readMySnapshot(ctx, org, openids)
    // pending 检查同按集合：申请在别的渠道（中间态）提交的，这里也报「有 待审」——
    // 否则多绑用户会从另一渠道再提一份申请（部分唯一索引按 open_id 分桶，拦不住跨渠道重复）。
    const pending = await ctx.pool.query(
      `select 1 from aftersales.employee_approval where org = $1 and open_id = any($2::text[]) and status = 'pending'`,
      [org, openids],
    )
    return c.json({
      registration: snap ? { name: snap.name, phone: snap.phone, storeCodes: snap.storeCodes } : null,
      hasPendingApproval: pending.rowCount! > 0,
    })
  })

  // ── 提交登记/变更 ────────────────────────────────────────────────────────
  r.post('/guest/employee-approvals', async (c) => {
    const { orgId: org, userId: openid } = c.get('identity')
    const parsed = TargetBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const target = parsed.data

    // 读旧档案按绑定集合（同 GET 侧）；下面的写入 open_id 仍 = 登录 openid（红线：只动读侧）
    const snap = await readMySnapshot(ctx, org, guestIdentityIds(c.get('identity')))
    let diff: ReturnType<typeof computeRegistration>
    try {
      diff = computeRegistration(snap ? { name: snap.name, phone: snap.phone, storeCodes: snap.storeCodes } : null, target)
    } catch (e) {
      // 「您没有修改任何信息」——源侧同样是拒绝提交（不是静默成功）
      if (e instanceof RegistrationError) return c.json({ error: 'INVALID_BODY', message: e.message }, 400)
      throw e
    }

    let approvalId: number
    try {
      const ins = await ctx.pool.query<{ id: string }>(
        `insert into aftersales.employee_approval(org, open_id, approve_type, old_info, new_info)
         values ($1, $2, $3, $4::jsonb, $5::jsonb) returning id`,
        [org, openid, diff.approveType, JSON.stringify(diff.oldInfo), JSON.stringify(diff.newInfo)],
      )
      approvalId = Number(ins.rows[0]!.id)
    } catch (e) {
      // ★ 防重**由库保证**（spec §2.5 纪律①）：部分唯一索引在并发下也拦得住。
      //   不先查后插——那正是源侧前端判定的做法，两个并发请求都能查到 0 条 ⇒ 都插入。
      if ((e as { code?: string }).code === '23505') return c.json({ error: 'APPROVAL_PENDING' }, 409)
      throw e
    }

    // 账户统一（Task 7）：申请已落库、201 应答前触发自动匹配。identityLinks 缺省
    // （旧宿主/单测）⇒ 跳过照旧 201。匹配失败抛错 ⇒ 500 裸露（在 try 外，不会被 409 防重
    // 分支吞掉）——**不回滚申请**：申请是业务事实且 409 防重意味着重试进不来，绑定可由
    // 管理员从 pending 队列人工补绑。
    if (ctx.identityLinks) {
      await ctx.identityLinks.matchOnApplication({
        org,
        provider: 'wechat-oa',
        externalId: openid,
        phone: target.phone,
        approvalId,
      })
    }
    return c.json({ id: approvalId, approveType: diff.approveType }, 201)
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
      `select count(*)::int as n from data.dim_item where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select item_code, bar_code, name, spec, unit_name, sale_cease, eliminate from data.dim_item
        where ${where} order by item_code limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((p) => ({
        code: String(p.item_code),
        barCode: p.bar_code === null ? null : String(p.bar_code),
        name: p.name,
        spec: p.spec,
        unitName: p.unit_name,
        saleCease: p.sale_cease,
        eliminate: p.eliminate,
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
  // 两个调用方（实读源侧）：登记页按**名称**搜（`q`）；提交页按**我的登记 code** 取明细（`codes`）。
  // `codes` 不是可有可无——提交页的口径是「选我登记的门店」，code 来自 /guest/me/registration，
  // 而**名字**只能从这里取。
  r.get('/guest/stores', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const codesRaw = c.req.query('codes')
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    if (codesRaw !== undefined) {
      // 约定：空串 = **空集**（调用方说「我没有任何门店」），不是「不过滤」——
      // 不过滤会把全量门店回给访客，是这批端点里最不该发生的一种静默降级。
      const parts = codesRaw === '' ? [] : codesRaw.split(',')
      // 只认 dim_branch.code 的发布契约形状（非空、限长、无通配/注入面字符）：坏值一律 400，
      // **不静默丢弃**——少几个门店比报错难查得多。
      const codes = parts.map((t) => (/^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : null))
      if (codes.some((v) => v === null)) {
        return c.json({ error: 'INVALID_CODES' }, 400)
      }
      if (codes.length === 0) return c.json({ items: [], total: 0, page, size })
      params.push(codes)
      where += ` and code = any($${params.length}::text[])`
    }

    // #476：数据源 = `data.dim_branch`（发布快照）。与 /guest/products 同构：回 total ⇒ 可真分页
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from data.dim_branch where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select code, name, enable, address, phone from data.dim_branch
        where ${where} order by code limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((s) => ({
        code: String(s.code),
        name: s.name,
        enable: s.enable,
        address: s.address,
        phone: s.phone,
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    })
  })
}
