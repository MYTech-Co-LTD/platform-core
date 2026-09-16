import { z } from 'zod'
import type { ApproveStatus, EmployeeItem, Paged, ProductItem, StoreItem, Unpaged } from '../api-types'
import { toMinor } from '../domain/ticket'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/** 门店是选择器数据（源侧 322 行），一次给全但设上界。 */
const MAX_STORES = 1000
/** 员工是审批列表（源侧 591 行），同上。 */
const MAX_EMPLOYEES = 2000
/** ILIKE 的 `%` `_` 在搜索词里是通配符——转义掉，否则用户输入 `%` 等于全表匹配。 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

const EmployeeBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  // `.safe()`：目标列 employee.store_id 是 bigint。`Number.isInteger(1e30) === true` ⇒ 旧写法放行
  // 越界值，落进 pg 参数位抛 22P02 ⇒ Hono 兜成 500（实测 `storeId: 1e30` ⇒ 500）。
  // 全模块 bigint 列一律用 `.safe()`，别混其他写法。
  storeId: z.number().int().positive().safe().optional(),
  /** 微信 openid，移动端身份锚（spec §1.2）。console 侧注册时可留空，随迁时由 M2b 补。 */
  openId: z.string().max(200).optional(),
})

const ApproveBody = z.object({ approveStatus: z.enum(['approved', 'rejected']) })

export function registerMasterData(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/stores', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    const res = await ctx.pool.query(
      `select id, name, region_id, address, phone from aftersales.store
        where ${where} order by id limit $${params.length + 1}`,
      [...params, MAX_STORES],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）
    const body: Unpaged<StoreItem> = {
      items: res.rows.map((s) => ({
        id: Number(s.id),
        name: s.name,
        regionId: s.region_id === null ? null : Number(s.region_id),
        address: s.address,
        phone: s.phone,
      })),
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

    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.product where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, name, spec, basic_quantity, basic_unit_price_minor from aftersales.product
        where ${where} order by id
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）——本端点是**回 total 的两个之一**
    const body: Paged<ProductItem> = {
      items: listRes.rows.map((p) => ({
        id: Number(p.id),
        name: p.name,
        spec: p.spec,
        basicQuantity: Number(p.basic_quantity),
        // bigint 是字符串——不转就会把 "500" 漏给前端（见 domain/ticket.ts 的说明）
        basicUnitPriceMinor: toMinor(p.basic_unit_price_minor),
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
    const params: unknown[] = [org]
    let where = 'org = $1'
    if (status) {
      params.push(status)
      where += ` and approve_status = $${params.length}`
    }
    const res = await ctx.pool.query(
      `select id, name, phone, store_id, open_id, approve_status from aftersales.employee
        where ${where} order by id desc limit $${params.length + 1}`,
      [...params, MAX_EMPLOYEES],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）
    const body: Unpaged<EmployeeItem> = {
      items: res.rows.map((e) => ({
        id: Number(e.id),
        name: e.name,
        phone: e.phone,
        storeId: e.store_id === null ? null : Number(e.store_id),
        openId: e.open_id,
        approveStatus: e.approve_status as ApproveStatus,
      })),
    }
    return c.json(body)
  })

  r.post('/employees', async (c) => {
    const org = c.get('identity').orgId
    const parsed = EmployeeBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, phone, storeId, openId } = parsed.data

    // 门店必须属于本 org——跨租户的 store_id 落进去 = 一个跨租户外键，后面每个 join 都是洞。
    // 校验与写入同事务，避免"校验通过后被并发删掉"的窗口。
    const client = await ctx.pool.connect()
    try {
      await client.query('begin')
      if (storeId !== undefined) {
        const st = await client.query('select id from aftersales.store where org = $1 and id = $2', [org, storeId])
        if (st.rowCount === 0) {
          await client.query('rollback')
          return c.json({ error: 'STORE_NOT_FOUND' }, 400)
        }
      }
      const res = await client.query<{ id: string }>(
        `insert into aftersales.employee(org, name, phone, store_id, open_id, approve_status)
         values ($1, $2, $3, $4, $5, 'pending') returning id`,
        [org, name, phone ?? '', storeId ?? null, openId ?? ''],
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
