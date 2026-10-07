// mcp-manage.test.ts — POST /mcp-manage 的写面测试（本租户口径的定义）。
//
// 三层：
//   ① **承重断言**——写面的门禁来自**声明**，所以清单里那一行是本设计安全属性的唯一可机检落点；
//   ② 协议面（与读面共用一个壳，两端点都要过）；
//   ③ 三工具 + 判定复用（写/删的闸门与 HTTP 面同一份，故两处行为必须一致）。
//
// ⚠️ 模块壳不挂宿主门卫（鉴权链归端到端测试），故本文件**验不到**「scope 不够被拒」——
//    那条由 loader.test.ts 的 R2 组盯（声明即授权），本文件只钉「声明写对了」。
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertL1Metric } from '../domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-mcp-manage'
/** 种进 platform 桶的平台 L1（基底；也是「撞 L1 保留 id」用例的被撞者）。 */
const L1_ID = 'mw_l1_sales_daily'
/** 本租户自建的 L2（happy path 用）。 */
const L2_ID = 'mw_l2_mine'

/** ① 承重断言：写面的门禁来自**声明**，这一行是本设计安全属性的唯一落点。 */
describe('写面的声明（不需要数据库）', () => {
  it('★ /mcp-manage 在 api.internal 里声明为 data:manage', () => {
    const m = parseYaml(readFileSync(new URL('../manifest.yaml', import.meta.url), 'utf8')) as {
      api: { internal: { method: string; path: string; scope: string }[] }
    }
    const entry = m.api.internal.find((e) => e.path === '/mcp-manage')
    expect(entry).toBeDefined()
    expect(entry!.method).toBe('POST')
    expect(entry!.scope).toBe('data:manage')
  })

  it('清单声明集合与注册路由集合逐条一致（装载期双向核对的本地版）', () => {
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path}`))
    const registered = new Set(
      mod.createRouter({ pool: null as never }).routes
        .filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`))
    expect([...registered].sort()).toEqual([...declared].sort())
  })
})

/** 一次 JSON-RPC POST 到**写面**端点。raw 给字符串可测「不可解析 body」。 */
async function rpc(app: Hono, payload: unknown): Promise<Response> {
  return await app.request('/mcp-manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

/** 工具级载荷：content[0].text 是域层结果的 JSON 串——协议外壳与业务结局的接缝。 */
function toolText(body: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>
}

describePg('写面（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = $1`, [L1_ID]).catch(() => {})
    await pool.end().catch(() => {})
  })

  function app(): Hono {
    // 第 4 参是 tenant（宿主投影的租户行）——不传会用默认 'test' 租户，断言全错。
    return buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool }, { id: 1, casdoor_org: ORG })
  }

  /** 种一条平台 L1：写面的基底，也是「撞 L1 保留 id」用例的被撞者。 */
  async function seedL1(): Promise<void> {
    await applyMigrations(pool)
    // sourceSystem 刻意留 null：源闸只对「有源且有值」的行生效，本文件不验源闸（那是 HTTP 面的用例）
    await upsertL1Metric(pool, {
      id: L1_ID, title: '销售日明细', description: '按日汇总的销售明细',
      requiredScope: null, subjectColumn: 'org',
      // ⚠️ 必须合 L1 的**形状契约**：`select <表达式> as value [, <维度>…] from <关系>`
      //（少了 `as value` 会在 resolveL1Base 处抛 BAD_BASE_SQL，写面全链拿不到基底）。
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday', params: {}, sourceSystem: null,
    })
  }

  it('tools/list → 恰好三件，且 customize 的描述写明「不能凭空造新指标」', async () => {
    await seedL1()
    const body = await (await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    const tools = (body as { result: { tools: { name: string; description: string }[] } }).result.tools
    expect(tools.map((t) => t.name).sort())
      .toEqual(['customize_metric', 'delete_custom_metric', 'list_metrics'])
    expect(tools.find((t) => t.name === 'customize_metric')!.description)
      .toContain('不能凭空造新指标')
  })

  it('list_metrics → 基底含刚种的 L1（带可用维度）；自定义面初始为空', async () => {
    await seedL1()
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('ok')
    const bases = out.bases as { id: string; dimensions: string[] }[]
    expect(bases.map((b) => b.id)).toContain(L1_ID)
    // 「可用维度」必须显式列出来 —— 否则 agent 只能靠试错撞「未知维度」
    expect(bases.find((b) => b.id === L1_ID)!.dimensions).toEqual(['bizday'])
    expect(out.custom).toEqual([])
  })

  it('★ happy path：customize 成功 → 落库可读回（且 list 里出现在「自定义」面）', async () => {
    await seedL1()
    const created = await (await rpc(app(), {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'customize_metric',
        arguments: { id: L2_ID, baseMetric: L1_ID, alias: '本租户口径', visibility: { dims: ['bizday'] } },
      },
    })).json()
    expect(toolText(created as never).status).toBe('ok')

    const listed = await (await rpc(app(), {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    expect((toolText(listed as never).custom as { id: string }[]).map((c) => c.id)).toContain(L2_ID)

    // 独立回读存储层：不采信工具自述
    const row = await pool.query(
      `select source, subject_column, group_by from data.metrics where org = $1 and id = $2`, [ORG, L2_ID])
    expect(row.rowCount).toBe(1)
    expect(row.rows[0]).toMatchObject({ source: 'l2', subject_column: 'org', group_by: 'bizday' })
  })

  it('★ happy path：delete_custom_metric 删自己的 → 成功；再 list 已不在', async () => {
    await seedL1()
    const del = await (await rpc(app(), {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'delete_custom_metric', arguments: { id: L2_ID } },
    })).json()
    expect(toolText(del as never).status).toBe('ok')

    const listed = await (await rpc(app(), {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    expect((toolText(listed as never).custom as { id: string }[]).map((c) => c.id)).not.toContain(L2_ID)
  })

  it('customize_metric 撞 L1 保留 id → ID_RESERVED_BY_L1，且 isError:true', async () => {
    await seedL1()
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: L1_ID, baseMetric: L1_ID } },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('refused')
    expect(out.error).toBe('ID_RESERVED_BY_L1')
    expect((body as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  it('customize_metric 基底不存在 → L1_BASE_NOT_FOUND；未知维度 → UNKNOWN_DIM', async () => {
    await seedL1()
    const bad = await (await rpc(app(), {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: 'x1', baseMetric: 'no_such_base' } },
    })).json()
    expect(toolText(bad as never).error).toBe('L1_BASE_NOT_FOUND')

    const dim = await (await rpc(app(), {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: {
        name: 'customize_metric',
        arguments: { id: 'x2', baseMetric: L1_ID, visibility: { dims: ['no_such_dim'] } },
      },
    })).json()
    expect(toolText(dim as never).error).toBe('UNKNOWN_DIM')
  })

  it('delete_custom_metric 打 L1 id → READONLY_L1（复用同一条判定）', async () => {
    await seedL1()
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'delete_custom_metric', arguments: { id: L1_ID } },
    })).json()
    expect(toolText(body as never).error).toBe('READONLY_L1')
  })

  it('入参形状非法 → INVALID_BODY（不是 500，也不是静默放行）', async () => {
    await seedL1()
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: 'x3' } },   // 缺 baseMetric
    })).json()
    expect(toolText(body as never).error).toBe('INVALID_BODY')
  })

  it('协议面：通知回 202；未解析 body → -32700；未知方法 → -32601', async () => {
    expect((await rpc(app(), { jsonrpc: '2.0', method: 'ping' })).status).toBe(202)
    const bad = await (await rpc(app(), 'not json')).json()
    expect((bad as { error: { code: number } }).error.code).toBe(-32700)
    const unknown = await (await rpc(app(), { jsonrpc: '2.0', id: 99, method: 'nope' })).json()
    expect((unknown as { error: { code: number } }).error.code).toBe(-32601)
  })
})
