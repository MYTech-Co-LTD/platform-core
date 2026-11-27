import { z } from 'zod'
import type {
  ApproveStatus, EmployeeItem, Paged, ProductItem, StoreItem, StoreProfileOptions,
} from '../api-types'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam } from './context'
import { writeAudit } from '../domain/audit'
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
  // 门店页签的编辑选项 + 覆盖率（#2924）。写面在 data（`data:store`）；这里只读。
  // data 057 未部署时视图缺失 ⇒ 降级返回空选项（degraded=true），门店列表本身照常可看。
  r.get('/stores/profile-options', async (c) => {
    const org = c.get('identity').orgId
    const storesRes = await ctx.pool.query<{ n: number }>(
      'select count(*)::int as n from data.dim_branch where org = $1', [org])
    let degraded = false
    let brands: StoreProfileOptions['brands'] = []
    let levels: StoreProfileOptions['levels'] = []
    let brandTagged = 0
    let levelTagged = 0
    try {
      const [brandRes, levelRes, coverageRes] = await Promise.all([
        ctx.pool.query<{ code: string; name: string; enabled: boolean; sort: number }>(
          `select code, name, enabled, sort from data.v_brand_registry
            where org = $1 order by sort, name`, [org]),
        ctx.pool.query<{ code: string; name: string; enabled: boolean; sort: number }>(
          `select code, name, enabled, sort from data.v_store_level_registry
            where org = $1 order by sort, name`, [org]),
        ctx.pool.query<{ brand_tagged: number; level_tagged: number }>(
          `select count(*) filter (where brand_code is not null)::int as brand_tagged,
                  count(*) filter (where level_code is not null)::int as level_tagged
             from data.v_store_profile where org = $1`, [org]),
      ])
      brands = brandRes.rows
      levels = levelRes.rows
      brandTagged = coverageRes.rows[0]?.brand_tagged ?? 0
      levelTagged = coverageRes.rows[0]?.level_tagged ?? 0
    } catch (e) {
      degraded = true
      console.warn('[aftersales] 门店画像选项降级（data 057 可能未部署）:', e instanceof Error ? e.message : e)
    }
    const body: StoreProfileOptions = {
      brands, levels,
      coverage: { stores: storesRes.rows[0]?.n ?? 0, brandTagged, levelTagged },
      degraded,
    }
    return c.json(body)
  })

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
    // 只读引用经 manifest `dataDependencies` 声明放行（B1 按声明集判，宪法 §4）；**写仍然不许**
    // （发布表只许 owner 写）。列集契约：scripts/data-dependencies.lock.json + 判据 2 门禁。
    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from data.dim_branch where ${where}`,
      params,
    )
    const res = await ctx.pool.query(
      `select code, name, enable, address, phone from data.dim_branch
        where ${where} order by code limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    // 门店画像（#2924）：单独查本页门店，视图缺失时只丢 tag，不影响门店列表。
    const profileByCode = new Map<string, {
      brand_code: string | null; brand_name: string | null
      level_code: string | null; level_name: string | null
    }>()
    const codes = res.rows.map((s) => String(s.code))
    if (codes.length > 0) {
      try {
        const profiles = await ctx.pool.query(
          `select store_code, brand_code, brand_name, level_code, level_name
             from data.v_store_profile
            where org = $1 and store_code = any($2::text[])`,
          [org, codes],
        )
        for (const p of profiles.rows) profileByCode.set(String(p.store_code), p)
      } catch (e) {
        console.warn('[aftersales] 门店画像读取失败（列表按无 tag 降级）:', e instanceof Error ? e.message : e)
      }
    }
    // 响应形状与 console 共用同一份类型（api-types.ts）
    const body: Paged<StoreItem> = {
      items: res.rows.map((s) => {
        const p = profileByCode.get(String(s.code))
        return {
          code: String(s.code),
          name: s.name,
          enable: s.enable,
          address: s.address,
          phone: s.phone,
          brandCode: p?.brand_code ?? null,
          brandName: p?.brand_name ?? null,
          levelCode: p?.level_code ?? null,
          levelName: p?.level_name ?? null,
        }
      }),
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
      const newId = Number(res.rows[0].id)
      // 同事务审计（评审 P0-2）：detail 不记手机号明文
      await writeAudit(client, {
        org, actor: c.get('identity').userId, action: 'employee.create', target: String(newId),
        detail: { name, storeCode: storeCode ?? '' },
      })
      await client.query('commit')
      return c.json({ id: newId }, 201)
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
    await writeAudit(ctx.pool, {
      org, actor: c.get('identity').userId, action: 'employee.approve', target: String(id),
      detail: { approveStatus: parsed.data.approveStatus },
    })
    return c.json({ ok: true, id, approveStatus: parsed.data.approveStatus })
  })
}
