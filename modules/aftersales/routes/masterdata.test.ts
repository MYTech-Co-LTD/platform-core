import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, ensureDimTables, makeIdentity } from '../test-util'
import { DEFAULT_PAGE_SIZE } from './context'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-md'
const OTHER_ORG = 'test-aftersales-md-other'

describePg('主数据域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    { pool },
  )

  beforeAll(async () => {
    await applyMigrations(pool)
    await ensureDimTables(pool)
    // #476：门店/商品的消费源 = `data.dim_branch` / `data.dim_item`（发布快照）。
    // 测试种它 = 模拟「发布完成」；org 键隔离（用例只查本 org），afterAll 清理。
    await pool.query('delete from data.dim_branch where org = $1', [ORG])
    await pool.query('delete from data.dim_item where org = $1', [ORG])
    await pool.query('delete from aftersales.employee where org = $1', [ORG])
    await pool.query(
      `insert into data.dim_branch(org, code, name, enable, address, phone, source_book, snapshot)
       values ($1,'101','上海门店',true,'', '', '3120', current_date),
              ($1,'102','北京门店',null,'', '', '3120', current_date)`,
      [ORG],
    )
    await pool.query(
      `insert into data.dim_item(org, item_code, bar_code, name, spec, unit_name, sale_cease, eliminate, source_book, snapshot)
       values ($1,'3001','6900000001','苹果','规格A','箱',false,false,'3120',current_date),
              ($1,'3002','6900000002','梨','规格B','kg',false,false,'3120',current_date)`,
      [ORG],
    )
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.employee where org = $1', [ORG])
    await pool.query('delete from data.dim_item where org = $1', [ORG])
    await pool.query('delete from data.dim_branch where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const json = (body: unknown) => ({
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('门店列表只回本 org', async () => {
    const res = await app.request('/stores')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string }[] }
    expect(body.items.map((s) => s.name).sort()).toEqual(['上海门店', '北京门店'])
  })

  // 【#155】与 /products 同形：回 {items,total,page,size}；q 过滤要计入 total（同一 where）。
  // 本 org 门店恰为 beforeAll 的两行（其余用例只动别的 org）⇒ total 可钉死为 2。
  it('【#155】门店列表回 total/page/size，q 过滤计入 total', async () => {
    const res = await app.request('/stores')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; size: number }
    expect(body).toMatchObject({ total: 2, page: 1, size: DEFAULT_PAGE_SIZE })

    const hit = await app.request('/stores?q=上海')
    const hitBody = (await hit.json()) as { items: unknown[]; total: number }
    expect(hitBody.total).toBe(1)

    const paged = await app.request('/stores?page=1&size=1')
    const pagedBody = (await paged.json()) as { items: unknown[]; total: number; size: number }
    expect(pagedBody).toMatchObject({ total: 2, size: 1 })
    expect(pagedBody.items).toHaveLength(1)
  })

  it('商品按名搜索（服务端过滤，不搬源侧「全量 13767 行 + 前端过滤」）', async () => {
    const hit = await app.request('/products?q=苹果')
    const hitBody = (await hit.json()) as { items: { name: string }[] }
    expect(hitBody.items.map((p) => p.name)).toEqual(['苹果'])

    const miss = await app.request('/products?q=不存在的名字')
    expect(((await miss.json()) as { items: unknown[] }).items).toEqual([])
  })

  it('商品分页：size 被夹到 100，行形状是发布契约（code/barCode/unitName，#476 后无价格字段）', async () => {
    const res = await app.request('/products?size=99999')
    const body = (await res.json()) as { size: number; items: { code: string; unitName: string | null }[] }
    expect(body.size).toBe(100)
    const apple = body.items.find((p) => p.code === '3001')
    expect(apple).toMatchObject({ code: '3001', unitName: '箱' })
  })

  // 分页口径与管理端/访客端**同一份** parsePageParam（context.ts）。两条边界必须钉住：
  // ① 非法值回落默认（**不是 500**——非法值直接进 pg 的 limit/offset 会抛 22P02 被 Hono 兜成 500）；
  // ② page 上界不得去掉（去掉则 ?page=1e21 的 offset 溢出 pg bigint ⇒ 500）。
  it('商品分页：非法 page/size 回落默认值，不 500', async () => {
    for (const qs of ['size=-5', 'size=1.5', 'size=abc', 'size=', 'page=1.5', 'page=0', 'page=']) {
      const res = await app.request(`/products?${qs}`)
      expect(res.status, `?${qs}`).toBe(200)
      const body = (await res.json()) as { page: number; size: number }
      expect(Number.isInteger(body.page), `?${qs} page`).toBe(true)
      expect(Number.isInteger(body.size), `?${qs} size`).toBe(true)
    }
    const fallback = (await (await app.request('/products?size=-5&page=0')).json()) as { page: number; size: number }
    expect(fallback).toMatchObject({ page: 1, size: DEFAULT_PAGE_SIZE })
  })

  it('商品分页：page 上界存在（极大 page 不 500，offset 不溢出 pg bigint）', async () => {
    const res = await app.request('/products?page=1e21&size=100')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { page: number }
    expect(body.page).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('员工注册 ⇒ 201、审批态默认 pending', async () => {
    const res = await app.request('/employees', json({ name: '张三', phone: '13800000000' }))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select approve_status, open_id from aftersales.employee where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ approve_status: 'pending', open_id: '' })
  })

  it('员工列表可按审批态筛选，open_id 被带出来（它是移动端身份锚）', async () => {
    const res = await app.request('/employees?approveStatus=pending')
    const body = (await res.json()) as { items: { name: string; approveStatus: string; openId: string }[] }
    expect(body.items.every((e) => e.approveStatus === 'pending')).toBe(true)
    expect(body.items.find((e) => e.name === '张三')?.openId).toBe('')
  })

  // 【#155】与 /products 同形：回 {items,total,page,size}；approveStatus 筛选计入 total（同一 where）。
  // 期望值直接按同一 where 从库里数出来——不硬编码行数，免疫本文件用例间的顺序耦合。
  it('【#155】员工列表回 total/page/size，approveStatus 筛选计入 total', async () => {
    const all = await app.request('/employees')
    expect(all.status).toBe(200)
    const dbAll = await pool.query<{ n: number }>(
      'select count(*)::int as n from aftersales.employee where org = $1',
      [ORG],
    )
    const allBody = (await all.json()) as { items: unknown[]; total: number; page: number; size: number }
    expect(allBody).toMatchObject({ total: dbAll.rows[0]!.n, page: 1, size: DEFAULT_PAGE_SIZE })
    // 单页装得下时（本用例 < 20 行）行数即 total——total 与 items 由同一 where 产生
    expect(allBody.items).toHaveLength(allBody.total)

    const pending = await app.request('/employees?approveStatus=pending')
    const dbPending = await pool.query<{ n: number }>(
      "select count(*)::int as n from aftersales.employee where org = $1 and approve_status = 'pending'",
      [ORG],
    )
    const pendingBody = (await pending.json()) as { total: number }
    expect(pendingBody.total).toBe(dbPending.rows[0]!.n)
  })

  it('审批通过 ⇒ 200 且状态落 approved；非法审批值 ⇒ 400', async () => {
    const created = await app.request('/employees', json({ name: '李四', phone: '13900000000' }))
    const { id } = (await created.json()) as { id: number }

    const bad = await app.request(`/employees/${id}/approve`, json({ approveStatus: 'maybe' }))
    expect(bad.status).toBe(400)

    const ok = await app.request(`/employees/${id}/approve`, json({ approveStatus: 'approved' }))
    expect(ok.status).toBe(200)
    const row = await pool.query('select approve_status from aftersales.employee where id = $1', [id])
    expect(row.rows[0].approve_status).toBe('approved')
  })

  it('跨 org 审批别人的员工 ⇒ 404（rowCount 0 与不存在同形）', async () => {
    const created = await app.request('/employees', json({ name: '王五', phone: '13700000000' }))
    const { id } = (await created.json()) as { id: number }
    const other = makeIdentity({ orgId: OTHER_ORG, scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, { pool }).request(
      `/employees/${id}/approve`,
      json({ approveStatus: 'approved' }),
    )
    expect(cross.status).toBe(404)
    const row = await pool.query('select approve_status from aftersales.employee where id = $1', [id])
    expect(row.rows[0].approve_status).toBe('pending')
  })

  it('员工注册带门店时，门店必须属于本 org（跨租户门店 code ⇒ 400，不是静默落 null）', async () => {
    await pool.query(
      `insert into data.dim_branch(org, code, name, source_book, snapshot)
       values ($1,'999','别人的门店','3120',current_date)`,
      [OTHER_ORG],
    )
    const res = await app.request(
      '/employees',
      json({ name: '赵六', phone: '13600000000', storeCode: '999' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'STORE_NOT_FOUND' })
    await pool.query('delete from data.dim_branch where org = $1', [OTHER_ORG])
  })

  // ── #476：引用键从 bigint 切自然键后的参数面变化 ──
  // `employee.store_code` 是 **text**（≤64，dim_branch.code 的发布契约）。
  // 修前 bigint 时代的「越界数字」用例随之退役；改为钉「超长/坏形 code ⇒ INVALID_BODY」。
  it('【回归 #476】员工注册 storeCode 超长/空串 ⇒ 400（不是 500）', async () => {
    for (const storeCode of ['x'.repeat(65), '']) {
      const res = await app.request('/employees', json({ name: '坏形', storeCode }))
      expect(res.status, `storeCode 长度=${storeCode.length} 应为 400`).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'INVALID_BODY' })
    }
    // 边界对照：形状合法但不存在的 code ⇒ zod 放行、走到门店校验 ⇒ 400 **STORE_NOT_FOUND**。
    const missing = await app.request('/employees', json({ name: '边界', storeCode: 'no-such-code' }))
    expect(missing.status).toBe(400)
    expect((await missing.json()) as { error: string }).toMatchObject({ error: 'STORE_NOT_FOUND' })
  })

  // ── 终审修复轮 1（I-2）：path-param id 守卫收成 routes/context.ts 的 parseIdParam ──
  // 修前 `Number.isInteger(1e23) === true` ⇒ 超大数字串落进 pg 的 bigint 参数位 ⇒ 500。
  // 本用例是【管理面】终点站之一的端到端连线证据；helper 本身的形状由 routes/context.test.ts 钉住。
  // 本站点【保留原有状态码】404（与 ticket-manage 的 400 不同，这是刻意的）。
  it('【回归 I-2】审批端点路径 id 越界 / 非规范 ⇒ 404（保留本站点原有状态码）', async () => {
    for (const raw of ['1e23', '99999999999999999999999', '1.0', '1e2', '-1', 'abc']) {
      const res = await app.request(`/employees/${raw}/approve`, json({ approveStatus: 'approved' }))
      expect(res.status, `POST /employees/${raw}/approve 应为 404，实为 ${res.status}`).toBe(404)
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'NOT_FOUND' })
    }
  })

  // ── 终审修复轮 1（M-T8-1）：`escapeLike` 的转义此前【从未被执行过】 ──
  // 终审静态核：本文件原来的搜索词只有 `苹果` / `不存在的名字`，**无一含 `%` 或 `_`**
  // ⇒ 转义函数一次都没被走到；将来有人「简化」掉它【不会红】。
  // 终审动态实核（真 PG 16.15）：`name ilike '%A\%B%'` 只命中 `A%B`；不转义对照
  // `'%A%B%'` 命中 `A_B`/`A%B`/`AXB` 三行。⇒ 转义本身是对的（PG 默认 ESCAPE 字符就是
  // 反斜杠，无需显式 ESCAPE 子句），本用例补的是【证据】，不改实现。
  it('【回归 M-T8-1】搜索词里的 % / _ / 反斜杠按【字面量】处理，不当通配符', async () => {
    // `a\%b` 是【含转义字符本身】的输入（JS 字面量 'a\\%b' ⇒ 4 个字符 a \ % b）
    const names = ['A%B', 'A_B', 'AXB', '纯%号', '纯_号', 'a\\%b']
    await pool.query('delete from data.dim_item where org = $1 and item_code like \'900%\'', [ORG])
    for (let i = 0; i < names.length; i++) {
      await pool.query(
        `insert into data.dim_item(org, item_code, name, spec, unit_name, source_book, snapshot)
         values ($1, $2, $3, '', '', '3120', current_date)`,
        [ORG, `900${i + 1}`, names[i]],
      )
    }
    try {
      const search = async (q: string) => {
        const res = await app.request(`/products?q=${encodeURIComponent(q)}`)
        expect(res.status, `q=${q}`).toBe(200)
        return ((await res.json()) as { items: { name: string }[] }).items.map((p) => p.name).sort()
      }

      // ① `q='%'`：若 `%` 被当通配符，它会匹配【一切】——包括本 org 原有的「苹果」
      const pct = await search('%')
      expect(pct).toEqual(['A%B', 'a\\%b', '纯%号'])
      expect(pct, '% 不得被当成通配符匹配到一切').not.toContain('苹果')

      // ② `q='_'`：单字符通配符同理，只命中名字里真有下划线的
      expect(await search('_')).toEqual(['A_B', '纯_号'])

      // ③ `q='a\%b'`（输入自带反斜杠）：反斜杠必须先被转义，否则它会把后面的 `%` 吃掉、
      //    当成「字面 %」⇒ 变成匹配 `a%b` 类名字。正确行为是整体按字面量匹配 ⇒ 只有 `a\%b` 命中。
      expect(await search('a\\%b')).toEqual(['a\\%b'])
    } finally {
      await pool.query('delete from data.dim_item where org = $1 and item_code like \'900%\'', [ORG])
    }
  })
})
