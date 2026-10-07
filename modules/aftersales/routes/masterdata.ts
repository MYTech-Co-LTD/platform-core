import { z } from 'zod'
import type { ApproveStatus, EmployeeItem, Paged, ProductItem, StoreItem } from '../api-types'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/** ILIKE 的 `%` `_` 在搜索词里是通配符——转义掉，否则用户输入 `%` 等于全表匹配。 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

const EmployeeBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  /** 主门店 = `data.dim_branch.code` 自然键（#476：门店消费源已切发布快照）。 */
  storeCode: z.string().min(1).max(64).optional(),
  /** 微信 openid，移动端身份锚（spec §1.2）。console 侧注册时可留空，随迁时由 M2b 补。 */
  openId: z.string().max(200).optional(),
})

const ApproveBody = z.object({ approveStatus: z.enum(['approved', 'rejected']) })

export function registerMasterData(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/stores', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    // 【#155】与 /products 同一口径（context.ts 的 parsePageParam）：回 total 可真分页。
    // 原先的 `MAX_STORES` 硬上界随之退役——size 已被 MAX_PAGE_SIZE 夹住。
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    // #476：数据源 = `data.dim_branch`（发布快照，跨账套去重租户视图）——不再自持门店副本。
    // 只读引用已被 lint B1 白名单放行（`from data.dim_`）；**写仍然不许**（发布表只许 owner 写）。
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from data.dim_branch where ${where}`,
      params,
    )
    const res = await ctx.pool.query(
      `select code, name, enable, address, phone from data.dim_branch
        where ${where} order by code limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）
    const body: Paged<StoreItem> = {
      items: res.rows.map((s) => ({
        code: String(s.code),
        name: s.name,
        enable: s.enable,
        address: s.address,
        phone: s.phone,
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    }
    return c.json(body)
  })

  r.get('/products', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    // 与管理端/访客端**同一口径**（context.ts 的 parsePageParam）：非法值回落默认、超上界夹住。
    // ⚠️ page 的上界 `Number.MAX_SAFE_INTEGER` 是**载荷的**——去掉它，`?page=1e21` 时
    // `(page - 1) * size` 会溢出 pg 的 bigint（> 9.22e18）或变成非整数 ⇒ **又变 500**。
    // （T6 定向复审实测：去掉该上界 ⇒ 必 500。）
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }

    // #476：数据源 = `data.dim_item`（发布快照）。⚠️ 无忌语义的 basic_quantity /
    // basic_unit_price_minor 在乐檬维表**没有对应列**（人裁 2026-10-07：先不显示价格；
    // 工单金额依据的来源另题——issue #476 价格阻塞项）。
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from data.dim_item where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select item_code, bar_code, name, spec, unit_name, sale_cease, eliminate from data.dim_item
        where ${where} order by item_code
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）——回 total 的分页口径原点，
    // #155 起 /rules /employees /stores 与本端点逐字对齐
    const body: Paged<ProductItem> = {
      items: listRes.rows.map((p) => ({
        code: String(p.item_code),
        barCode: p.bar_code === null ? null : String(p.bar_code),
        name: p.name,
        spec: p.spec,
        unitName: p.unit_name,
        saleCease: p.sale_cease,
        eliminate: p.eliminate,
      })),
      total: totalRes.rows[0].n,
      page,
      size,
    }
    return c.json(body)
  })

  r.get('/employees', async (c) => {
    const org = c.get('identity').orgId
    const status = c.req.query('approveStatus')
    // 【#155】与 /products 同一口径（context.ts 的 parsePageParam）：回 total 可真分页。
    // 原先的 `MAX_EMPLOYEES` 硬上界随之退役——size 已被 MAX_PAGE_SIZE 夹住。
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (status) {
      params.push(status)
      where += ` and approve_status = $${params.length}`
    }
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.employee where ${where}`,
      params,
    )
    const res = await ctx.pool.query(
      `select id, name, phone, store_code, open_id, approve_status from aftersales.employee
        where ${where} order by id desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）
    const body: Paged<EmployeeItem> = {
      items: res.rows.map((e) => ({
        id: Number(e.id),
        name: e.name,
        phone: e.phone,
        storeCode: e.store_code === null ? null : String(e.store_code),
        openId: e.open_id,
        approveStatus: e.approve_status as ApproveStatus,
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    }
    return c.json(body)
  })

  r.post('/employees', async (c) => {
    const org = c.get('identity').orgId
    const parsed = EmployeeBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, phone, storeCode, openId } = parsed.data

    // 门店必须属于本 org——跨租户的 store_code 落进去 = 一个跨租户外键，后面每个 join 都是洞。
    // 引用目标 = `data.dim_branch`（#476）；校验与写入同事务，避免"校验通过后被并发删掉"的窗口。
    const client = await ctx.pool.connect()
    try {
      await client.query('begin')
      if (storeCode !== undefined) {
        const st = await client.query('select code from data.dim_branch where org = $1 and code = $2', [org, storeCode])
        if (st.rowCount === 0) {
          await client.query('rollback')
          return c.json({ error: 'STORE_NOT_FOUND' }, 400)
        }
      }
      const res = await client.query<{ id: string }>(
        `insert into aftersales.employee(org, name, phone, store_code, open_id, approve_status)
         values ($1, $2, $3, $4, $5, 'pending') returning id`,
        [org, name, phone ?? '', storeCode ?? '', openId ?? ''],
      )
      await client.query('commit')
      return c.json({ id: Number(res.rows[0].id) }, 201)
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  r.post('/employees/:id/approve', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const parsed = ApproveBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    // 目标枚举定死英文（spec §5 #9：源侧三套词表并存——pending|approved|rejected 与中文
    // 待审批|通过|驳回；中文是展示层的事，不入库）。
    const res = await ctx.pool.query(
      'update aftersales.employee set approve_status = $3 where org = $1 and id = $2',
      [org, id, parsed.data.approveStatus],
    )
    if (res.rowCount === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true, id, approveStatus: parsed.data.approveStatus })
  })
}
