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
import { applyMigrations, applyPlatformMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertL1Metric } from '../domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-mcp-manage'
/** P2 终审修复用例的合成租户（与 domain 侧 9107/9207/9307/9308 错开）+ 夹具树前缀。 */
const TENANT_M = 9407
const M_ROOT = 'org-mcp-mg-root'
const M_CHILD = 'org-mcp-mg-child'
const M_SIB = 'org-mcp-mg-sib'
const M_U_OWNER = 'org-mcp-mg-u-owner' // 直属 child（owned L2 的归属方）
const M_U_SIB = 'org-mcp-mg-u-sib'     // 直属 sib（child 的兄弟部门）
/** 种进 platform 桶的平台 L1（基底；也是「撞 L1 保留 id」用例的被撞者）。 */
const L1_ID = 'mw_l1_sales_daily'
/** P1 Task 7 修复用例的覆盖单夹具 L1：三段蛇形（entry.name 必须过编译器名字白名单），本文件专属前缀。 */
const OVR_ID = 'mw:mcp:sales'
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

  it('initialize 不回 instructions（写面不提供；字段整个省略，与旧版逐字节兼容）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const body = await res.json()
    expect(body.result.serverInfo).toBeDefined()
    expect('instructions' in body.result).toBe(false)
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

/**
 * P4 回滚开关（DATA_METRIC_REVIEW_MODE，spec §14）：'off' ⇒ 写工具走旧直写路径。
 * 开关在 call 时读 process.env ⇒ 现场切换 + 返回还原函数（模式同 DATA_MCP_ALLOW_MUTATING 的
 * try/finally，不向同 worker 的其他文件泄漏）。
 */
function reviewModeOff(): () => void {
  const prev = process.env.DATA_METRIC_REVIEW_MODE
  process.env.DATA_METRIC_REVIEW_MODE = 'off'
  return () => {
    if (prev === undefined) delete process.env.DATA_METRIC_REVIEW_MODE
    else process.env.DATA_METRIC_REVIEW_MODE = prev
  }
}

/** 工具级载荷：content[0].text 是域层结果的 JSON 串——协议外壳与业务结局的接缝。 */
function toolText(body: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>
}

describePg('写面（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from data.metric_change where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    // 平台桶按精确 id 回收（OVR_ID = P1 Task 7 修复用例的覆盖单夹具）
    await pool.query('delete from data.metrics where org = $1 and id = any($2::text[])',
      ['platform', [L1_ID, OVR_ID]]).catch(() => {})
    // P2 终审修复用例的 org 树夹具（TENANT_M 专用，不碰别人的租户）
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT_M]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT_M]).catch(() => {})
    await pool.query('delete from platform.tenant where id = $1', [TENANT_M]).catch(() => {})
    await pool.end().catch(() => {})
  })

  function app(): Hono {
    // 第 4 参是 tenant（宿主投影的租户行）——不传会用默认 'test' 租户，断言全错。
    // execute：试算的测试缝（mcp-rpc 组装处 wh = ctx.execute 透传）——submit_metric_change
    // 的「提交即试算」不碰真仓库（与 metric-changes.test.ts 同款假执行器，恒回同一行）。
    return buildTestApp(mod, makeIdentity({ orgId: ORG }),
      { pool, execute: async () => ({ rows: [{ rows: 5, value: 100 }] }) } as never,
      { id: 1, casdoor_org: ORG })
  }

  /** 指定身份的写面壳（其余装配与 app() 相同）：部门可见用例给合成租户 + org 树身份。 */
  function appAs(userId: string): Hono {
    return buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'], userId, accountName: userId }),
      { pool, execute: async () => ({ rows: [{ rows: 5, value: 100 }] }) } as never,
      { id: TENANT_M, casdoor_org: ORG })
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
      groupBy: 'bizday', params: {}, sourceSystem: null, slaDays: 1, freshnessRelations: [], masks: null,
    })
  }

  /** 口径片 + 报表片 + 变更单提案两件（P0 Task 6）：结构约束（多出发布/回收类 = 「能提不能发」被破坏）。 */
  const METRIC_REPORT_TOOL_NAMES = ['customize_metric', 'delete_custom_metric', 'list_metrics',
    'list_reports', 'propose_report', 'revise_report_spec', 'get_report_spec',
    'submit_metric_change', 'list_metric_changes']
  /** Wave 3 提案面（spec §7）+ W3 L1 声明提案（#1401）：九个，缺一或多一都算漂。 */
  const PIPELINE_TOOL_NAMES = ['apply_pipeline_proposal', 'get_pipeline', 'get_pipeline_run', 'list_pipeline_runs', 'list_pipelines',
    'propose_contract_change', 'propose_metric_declaration', 'propose_pipeline_change', 'run_pipeline_sandbox']
  /** Phase 2 需求台账（#1404）：两件，缺一或多一都算漂。 */
  const DEMAND_TOOL_NAMES = ['dismiss_demand_signal', 'list_demand_signals']

  it('tools/list → 口径三 + 报表四（#496）+ 提案九件（Wave 3 + W3）+ 需求两件（Phase 2）各自恰好', async () => {
    await seedL1()
    const body = await (await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    const tools = (body as { result: { tools: { name: string; description: string }[] } }).result.tools
    expect(tools.map((t) => t.name).sort()).toEqual([...METRIC_REPORT_TOOL_NAMES, ...PIPELINE_TOOL_NAMES, ...DEMAND_TOOL_NAMES].sort())
    expect(tools.find((t) => t.name === 'customize_metric')!.description).toContain('不能凭空造新指标')
    // 提案版语义（P4 Task 1，spec §11）：两把写工具的描述必须声明「只提案不生效」，
    // 且把状态/驳回原因的读取口指给 list_metric_changes——schema 不承载这句话。
    expect(tools.find((t) => t.name === 'customize_metric')!.description).toContain('不直接生效')
    expect(tools.find((t) => t.name === 'delete_custom_metric')!.description).toContain('不直接生效')
    expect(tools.find((t) => t.name === 'customize_metric')!.description).toContain('list_metric_changes')
    expect(tools.find((t) => t.name === 'delete_custom_metric')!.description).toContain('list_metric_changes')
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

  it('★ customize_metric 缺省（on）落变更单（P4 Task 1）：不直接生效——data.metrics 无新行，list_metric_changes 可见 kind=create', async () => {
    await seedL1()
    const created = await (await rpc(app(), {
      jsonrpc: '2.0', id: 40, method: 'tools/call',
      params: {
        name: 'customize_metric',
        arguments: { id: L2_ID, baseMetric: L1_ID, alias: '提案版口径', visibility: { dims: ['bizday'] } },
      },
    })).json()
    const out = toolText(created as never)
    expect(out.status).toBe('ok')
    expect(typeof out.changeId).toBe('number')
    // 提交即试算（与 submit_metric_change 同契，P0 终审 F1）：注入执行器在位 ⇒ preview_ready
    expect(out.state).toBe('preview_ready')

    // 生效路径未被触碰：独立回读存储层，不采信工具自述
    const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [ORG, L2_ID])
    expect(live.rowCount).toBe(0)
    // 工具面的「自定义」面也不出现（生效行没有，读面自然没有）
    const listed = await (await rpc(app(), {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    expect((toolText(listed as never).custom as { id: string }[]).map((c) => c.id)).not.toContain(L2_ID)

    // 单据落库事实独立回读：kind=create（本租户无同名生效行）、preview_ready
    const row = await pool.query('select kind, status, metric_id from data.metric_change where id = $1', [out.changeId])
    expect(row.rows[0]).toMatchObject({ kind: 'create', status: 'preview_ready', metric_id: L2_ID })

    // 再用**工具面**核对（不只直读表）：list_metric_changes 看得到这张单，preview 快照可读
    const changes = toolText(await (await rpc(app(), {
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'list_metric_changes', arguments: {} },
    })).json() as never).changes as { id: number; metricId: string; kind: string; status: string }[]
    expect(changes.find((c) => c.id === out.changeId)).toMatchObject({
      metricId: L2_ID, kind: 'create', status: 'preview_ready',
    })

    // 编译坏单照落单：试算失败 ⇒ preview_failed（仍可驳），不是工具级 error——
    // 编译错误码从「提交即拒」移到「preview 快照」里，由人在 list_metric_changes 读。
    const bad = toolText(await (await rpc(app(), {
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: 'x_bad_base', baseMetric: 'no_such_base' } },
    })).json() as never)
    expect(bad.status).toBe('ok')
    expect(bad.state).toBe('preview_failed')
  })

  it('★ customize_metric 对已有生效行 = update 提案（P4 Task 1 kind 归一）：落单 kind=update 且行不被触碰', async () => {
    await seedL1()
    // 先用 off 模式直写种一行生效 L2（这正是应急回滚路径的原样行为）
    const restore = reviewModeOff()
    try {
      const seeded = toolText(await (await rpc(app(), {
        jsonrpc: '2.0', id: 44, method: 'tools/call',
        params: {
          name: 'customize_metric',
          arguments: { id: L2_ID, baseMetric: L1_ID, alias: '已有行', visibility: { dims: ['bizday'] } },
        },
      })).json() as never)
      expect(seeded.status).toBe('ok')
    } finally {
      restore()
    }

    const revised = await (await rpc(app(), {
      jsonrpc: '2.0', id: 45, method: 'tools/call',
      params: {
        name: 'customize_metric',
        arguments: { id: L2_ID, baseMetric: L1_ID, alias: '改口径提案', visibility: { dims: ['bizday'] } },
      },
    })).json()
    const out = toolText(revised as never)
    expect(out.status).toBe('ok')
    expect(typeof out.changeId).toBe('number')
    const row = await pool.query('select kind, status, metric_id from data.metric_change where id = $1', [out.changeId])
    expect(row.rows[0]).toMatchObject({ kind: 'update', status: 'preview_ready', metric_id: L2_ID })
    // 生效行仍是种子时的样子（title 未变——生效只发生在人采纳之后）
    const live = await pool.query('select title from data.metrics where org = $1 and id = $2', [ORG, L2_ID])
    expect(live.rows[0]).toMatchObject({ title: '已有行' })
  })

  it('★ delete_custom_metric 缺省（on）落删除提案（P4 Task 1）：行不被删，list_metric_changes 可见 kind=delete', async () => {
    await seedL1()
    // 种一行生效 L2（off 模式直写）
    const restore = reviewModeOff()
    try {
      const seeded = toolText(await (await rpc(app(), {
        jsonrpc: '2.0', id: 50, method: 'tools/call',
        params: {
          name: 'customize_metric',
          arguments: { id: L2_ID, baseMetric: L1_ID, alias: '待删口径' },
        },
      })).json() as never)
      expect(seeded.status).toBe('ok')
    } finally {
      restore()
    }

    const del = await (await rpc(app(), {
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'delete_custom_metric', arguments: { id: L2_ID } },
    })).json()
    const out = toolText(del as never)
    expect(out.status).toBe('ok')
    expect(typeof out.changeId).toBe('number')
    expect(out.state).toBe('preview_ready')   // 删档试算 = 编译「当前生效口径」，行在 ⇒ ready

    // 行未被删（生效只发生在人采纳之后）：独立回读存储层
    const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [ORG, L2_ID])
    expect(live.rowCount).toBe(1)

    const row = await pool.query('select kind, status, metric_id from data.metric_change where id = $1', [out.changeId])
    expect(row.rows[0]).toMatchObject({ kind: 'delete', status: 'preview_ready', metric_id: L2_ID })

    // 工具面核对：list_metric_changes 看得到这张删除单
    const changes = toolText(await (await rpc(app(), {
      jsonrpc: '2.0', id: 52, method: 'tools/call',
      params: { name: 'list_metric_changes', arguments: {} },
    })).json() as never).changes as { id: number; metricId: string; kind: string }[]
    expect(changes.find((c) => c.id === out.changeId)).toMatchObject({ metricId: L2_ID, kind: 'delete' })
  })

  it('★ customize_metric 打平台口径 id（on）→ 提交即拒 ID_RESERVED_BY_L1，且不落单（修复轮 1①）', async () => {
    await seedL1()
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 60, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: L1_ID, baseMetric: L1_ID } },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('refused')
    expect(out.error).toBe('ID_RESERVED_BY_L1')
    expect((body as { result: { isError: boolean } }).result.isError).toBe(true)
    // 不落「注定失败」的单：提交期就拒，变更单表零行
    const tickets = await pool.query('select 1 from data.metric_change where org = $1 and metric_id = $2', [ORG, L1_ID])
    expect(tickets.rowCount).toBe(0)
  })

  it('★ delete_custom_metric 打平台口径（on）→ 提交即拒 READONLY_L1，且不落单（修复轮 1①）', async () => {
    await seedL1()
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 61, method: 'tools/call',
      params: { name: 'delete_custom_metric', arguments: { id: L1_ID } },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('refused')
    expect(out.error).toBe('READONLY_L1')
    expect((body as { result: { isError: boolean } }).result.isError).toBe(true)
    const tickets = await pool.query('select 1 from data.metric_change where org = $1 and metric_id = $2', [ORG, L1_ID])
    expect(tickets.rowCount).toBe(0)
  })

  it('★ customize_metric 打租户 declared 行（W8 覆盖）→ 提交即拒 DECLARED_NOT_EDITABLE，且不落单（修复轮 1②）', async () => {
    await seedL1()
    // 夹具：本租户桶一条 basis='declared' 的行（W8 声明形态；列清单照 insertTenantDeclaration 最小集）
    const declaredId = 'mw_l2_declared'
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by, params,
          source, updated_by, version, totalable, sla_days, freshness_relations, basis, certified, created_by)
       values ($1, $2, $3, '', null, 'org',
               'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
               'bizday', '{}'::jsonb, 'l2', 'u', 1, true, 1, '[]'::jsonb, 'declared', 'draft', 'u')`,
      [ORG, declaredId, '声明行夹具'])
    const body = await (await rpc(app(), {
      jsonrpc: '2.0', id: 62, method: 'tools/call',
      params: { name: 'customize_metric', arguments: { id: declaredId, baseMetric: L1_ID } },
    })).json()
    const out = toolText(body as never)
    expect(out.status).toBe('refused')
    expect(out.error).toBe('DECLARED_NOT_EDITABLE')
    expect((body as { result: { isError: boolean } }).result.isError).toBe(true)
    const tickets = await pool.query(
      'select 1 from data.metric_change where org = $1 and metric_id = $2', [ORG, declaredId])
    expect(tickets.rowCount).toBe(0)
  })

  it('★ happy path（off 模式直写，应急回滚路径）：customize 成功 → 落库可读回（且 list 里出现在「自定义」面）', async () => {
    await seedL1()
    const restore = reviewModeOff()
    try {
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
    } finally {
      restore()
    }
  })

  it('★ happy path（off 模式直写）：customize 用 expr（受限算术组合多条口径）→ 工具返回非错误，且写入成功', async () => {
    await seedL1()
    const restore = reviewModeOff()
    try {
      const l2ExprId = 'mw_l2_half_revenue'
      const body = await (await rpc(app(), {
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: {
          name: 'customize_metric',
          arguments: {
            id: l2ExprId,
            // 工具面只暴露顶层的 `expr`（`op.kind` 由面归一）—— 取证点之一
            expr: { kind: 'div', left: { kind: 'ref', id: L1_ID }, right: { kind: 'num', value: 2 } },
          },
        },
      })).json()
      const out = toolText(body as never)
      expect(out.status).toBe('ok')
      expect((body as { result: { isError: boolean } }).result.isError).toBe(false)

      // 独立回读存储层：不采信工具自述（口径确实落库了，且带编译器注入的除零守卫）
      const row = await pool.query(
        'select source, subject_column, group_by, select_sql from data.metrics where org = $1 and id = $2',
        [ORG, l2ExprId])
      expect(row.rowCount).toBe(1)
      expect(row.rows[0]).toMatchObject({ source: 'l2', subject_column: 'org', group_by: 'bizday' })
      expect(row.rows[0].select_sql).toContain('NULLIF((2), 0)')
    } finally {
      restore()
    }
  })

  it('★ happy path（off 模式直写）：delete_custom_metric 删自己的 → 成功；再 list 已不在', async () => {
    await seedL1()
    const restore = reviewModeOff()
    try {
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
    } finally {
      restore()
    }
  })

  it('★ list_metrics 部门可见（P2 终审修复）：兄弟部门 data:manage 持有者看不到别家归属的自建口径——custom 过同一把裁剪尺', async () => {
    await seedL1()
    await applyPlatformMigrations(pool)
    // org 树夹具（真表种法与 metric-visibility.test.ts 同款）：ROOT → CHILD；SIB 另一支。
    await pool.query(
      'insert into platform.tenant(id, slug, casdoor_org) values ($1, $2, $3) on conflict (id) do nothing',
      [TENANT_M, 'org-mcp-mg', ORG])
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT_M])
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT_M])
    const insDept = async (extId: string, parent: string | null, path: string) => {
      await pool.query(
        `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
         values ($1, $2, $3, $4, $5, 1)
         on conflict (tenant_id, ext_id) do update set parent_ext_id = excluded.parent_ext_id, path = excluded.path, status = 1`,
        [TENANT_M, extId, extId, parent, path],
      )
    }
    const insMember = async (userName: string, extId: string) => {
      await pool.query(
        'insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary) values ($1, $2, $3, true) on conflict do nothing',
        [TENANT_M, userName, extId],
      )
    }
    await insDept(M_ROOT, null, M_ROOT)
    await insDept(M_CHILD, M_ROOT, `${M_ROOT}.${M_CHILD}`)
    await insDept(M_SIB, null, M_SIB)
    await insMember(M_U_OWNER, M_CHILD)
    await insMember(M_U_SIB, M_SIB)

    // owner 建出自建口径（off 模式直写种夹具——本用例验的是读面裁剪尺，不是写面开关）；
    // 归属列写侧暂无 API 面（P1 只建列）⇒ 夹具直改库（query 面用例同款）
    const restoreFix = reviewModeOff()
    let created: Response
    try {
      created = await rpc(appAs(M_U_OWNER), {
        jsonrpc: '2.0', id: 30, method: 'tools/call',
        params: {
          name: 'customize_metric',
          arguments: { id: L2_ID, baseMetric: L1_ID, alias: '归属部门的自建口径', visibility: { dims: ['bizday'] } },
        },
      })
    } finally {
      restoreFix()
    }
    expect(toolText(await created.json() as never).status).toBe('ok')
    await pool.query('update data.metrics set owner_dept = $1 where org = $2 and id = $3', [M_CHILD, ORG, L2_ID])

    // 兄弟部门的 data:manage 持有者：平台桶 L1 照常在 bases（不受裁剪影响），owned L2 不在 custom
    const sibBody = await (await rpc(appAs(M_U_SIB), {
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    const sibOut = toolText(sibBody as never)
    expect(sibOut.status).toBe('ok')
    expect((sibOut.bases as { id: string }[]).map((b) => b.id)).toContain(L1_ID)
    expect((sibOut.custom as { id: string }[]).map((c) => c.id)).not.toContain(L2_ID)

    // 归属方本人照常看到自己的口径——裁剪尺只切链外，没多切
    const ownBody = await (await rpc(appAs(M_U_OWNER), {
      jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'list_metrics', arguments: {} },
    })).json()
    expect((toolText(ownBody as never).custom as { id: string }[]).map((c) => c.id)).toContain(L2_ID)
  })

  // ↓ 以下三个「域层判定 → 工具级错误」用例走 **off 模式直写路径**（应急回滚路径原样保留）：
  //   on 模式下这些编译/保留 id 判据移到提交后的试算与采纳期（提案失败在人面可读），提交本身 ok。
  it('（off 直写）customize_metric 撞 L1 保留 id → ID_RESERVED_BY_L1，且 isError:true', async () => {
    await seedL1()
    const restore = reviewModeOff()
    let body: unknown
    try {
      body = await (await rpc(app(), {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'customize_metric', arguments: { id: L1_ID, baseMetric: L1_ID } },
      })).json()
    } finally {
      restore()
    }
    const out = toolText(body as never)
    expect(out.status).toBe('refused')
    expect(out.error).toBe('ID_RESERVED_BY_L1')
    expect((body as { result: { isError: boolean } }).result.isError).toBe(true)
  })

  it('（off 直写）customize_metric 基底不存在 → L1_BASE_NOT_FOUND；未知维度 → UNKNOWN_DIM', async () => {
    await seedL1()
    const restore = reviewModeOff()
    try {
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
    } finally {
      restore()
    }
  })

  it('（off 直写）delete_custom_metric 打 L1 id → READONLY_L1（复用同一条判定）', async () => {
    await seedL1()
    const restore = reviewModeOff()
    let body: unknown
    try {
      body = await (await rpc(app(), {
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'delete_custom_metric', arguments: { id: L1_ID } },
      })).json()
    } finally {
      restore()
    }
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

  it('★ submit_metric_change：写总闸关→denied 不立单；开闸后只提案不生效（未决态）；list 看得到自己的单', async () => {
    await seedL1()
    const args = {
      name: 'submit_metric_change',
      arguments: {
        metricId: 'x:via_mcp', kind: 'create',
        payload: { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '经 MCP 提的' },
      },
    }
    // 写总闸缺省关（与管线提案片同一开关 DATA_MCP_ALLOW_MUTATING）：连单都不立
    const gated = toolText(await (await rpc(app(), {
      jsonrpc: '2.0', id: 19, method: 'tools/call', params: args,
    })).json() as never)
    expect(gated.status).toBe('denied')
    expect(gated.reason).toBe('mutating_disabled')

    // 开闸只作用本用例（try/finally 还原，不向同 worker 的其他文件泄漏）
    const prev = process.env.DATA_MCP_ALLOW_MUTATING
    process.env.DATA_MCP_ALLOW_MUTATING = 'true'
    try {
      const submitted = await (await rpc(app(), {
        jsonrpc: '2.0', id: 20, method: 'tools/call', params: args,
      })).json()
      const out = toolText(submitted as never)
      expect(out.status).toBe('ok')
      // 提交即试算（与 HTTP 面 POST /metric-changes 同契，P0 终审 F1）：注入执行器在位 ⇒
      // preview_ready（控制台的采纳按钮只认这个态）；且永不直接生效
      expect(out.state).toBe('preview_ready')
      expect(typeof out.changeId).toBe('number')

      // 自己的单在 list 里可见（带 kind/metricId；驳回原因是人裁决后才有的字段，未决时为 null）
      const listed = await (await rpc(app(), {
        jsonrpc: '2.0', id: 21, method: 'tools/call',
        params: { name: 'list_metric_changes', arguments: {} },
      })).json()
      const changes = toolText(listed as never).changes as
        { id: number; metricId: string; kind: string; status: string; preview: { rows?: number } | null; rejectReason: string | null }[]
      const mine = changes.find((c) => c.id === out.changeId)
      expect(mine).toBeDefined()
      expect(mine!.metricId).toBe('x:via_mcp')
      expect(mine!.kind).toBe('create')
      expect(mine!.status).toBe('preview_ready')
      expect(mine!.preview).toMatchObject({ rows: 5 })

      // 生效路径未被触碰：独立回读存储层，不采信工具自述
      const live = await pool.query(`select 1 from data.metrics where org = $1 and id = 'x:via_mcp'`, [ORG])
      expect(live.rowCount).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.DATA_MCP_ALLOW_MUTATING
      else process.env.DATA_MCP_ALLOW_MUTATING = prev
    }
  })

  it('★ override 档经 MCP 提单（P1 Task 7 修复）：落单 kind=override 且**不生效**——工具不接采纳，租户桶无覆盖行', async () => {
    await seedL1()
    // override 的 entry.name 必须 = L1 id 且过编译器名字白名单（三段蛇形）；expression 关系
    // 复用本文件 L1 的 mart_sales_daily ⇒ B11 白名单天然在集（与 Task 7 routes 夹具同构）。
    await upsertL1Metric(pool, {
      id: OVR_ID, title: '销售(覆盖单夹具)', description: 'mcp-manage override 夹具',
      requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday', params: {}, sourceSystem: 'lemeng', slaDays: 1, freshnessRelations: [], masks: null,
    })
    const prev = process.env.DATA_MCP_ALLOW_MUTATING
    process.env.DATA_MCP_ALLOW_MUTATING = 'true'
    try {
      const submitted = await (await rpc(app(), {
        jsonrpc: '2.0', id: 22, method: 'tools/call',
        params: { name: 'submit_metric_change', arguments: {
          metricId: OVR_ID, kind: 'override',
          payload: {
            name: OVR_ID, label: '本租户销售（MCP 单）', definition: '覆盖单测试', owner: 'data-platform',
            tier: 'experimental', source: 'lemeng', expression: 'sum(mart_sales_daily.revenue)',
            grain: ['bizday'], freshness_sla_days: 1, reads: [],
          },
        } },
      })).json()
      const out = toolText(submitted as never)
      expect(out.status).toBe('ok')
      expect(out.state).toBe('preview_ready')
      expect(typeof out.changeId).toBe('number')

      // 单据 kind=override 在 list 里可见（不采信工具自述的 state，落库事实独立回读）
      const row = await pool.query('select kind, status, metric_id from data.metric_change where id = $1', [out.changeId])
      expect(row.rows[0]).toMatchObject({ kind: 'override', status: 'preview_ready', metric_id: OVR_ID })

      // 生效路径未被触碰：工具不接采纳 ⇒ 租户桶没有覆盖行（连草稿都没有——那是人采纳之后的事）
      const live = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [ORG, OVR_ID])
      expect(live.rowCount).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.DATA_MCP_ALLOW_MUTATING
      else process.env.DATA_MCP_ALLOW_MUTATING = prev
    }
  })

  it('协议面：通知回 202；未解析 body → -32700；未知方法 → -32601', async () => {
    expect((await rpc(app(), { jsonrpc: '2.0', method: 'ping' })).status).toBe(202)
    const bad = await (await rpc(app(), 'not json')).json()
    expect((bad as { error: { code: number } }).error.code).toBe(-32700)
    const unknown = await (await rpc(app(), { jsonrpc: '2.0', id: 99, method: 'nope' })).json()
    expect((unknown as { error: { code: number } }).error.code).toBe(-32601)
  })
})

describe('管理面工具片：跨片名字不重（新增片必过）', () => {
  it('三片合成后工具名唯一', async () => {
    const { GROUPS } = await import('./mcp-manage')
    const fake = {
      pool: { query: async () => ({ rows: [] }) } as never,
      org: 'acme', adoptedSources: new Set<string>(),
      requester: { userId: 'u', orgId: 'acme', channel: 'pat' as const, keyId: 1, scopes: ['data:manage'], hasScope: () => true },
    }
    const names = (await Promise.all(GROUPS.map((g) => g.list(fake as never)))).flat().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('合并面事实源：三片 list() 取自纯文件 face（P1 Task 6，销缓办⑤）', () => {
  /** 与上面同款假 deps（不需要数据库；metric 片 list 不再碰词表）。 */
  const fake = {
    pool: { query: async () => ({ rows: [] }) } as never,
    org: 'acme', adoptedSources: new Set<string>(),
    requester: { userId: 'u', orgId: 'acme', channel: 'pat' as const, keyId: 1, scopes: ['data:manage'], hasScope: () => true },
  }

  it('每片 list() ≡ face 里本片 wire 投影（谁手改定义不进 face ⇒ 红）', async () => {
    const { GROUPS } = await import('./mcp-manage')
    const { manageFaceOfSlice } = await import('./mcp-manage-face')
    const slices = ['metric', 'report', 'pipeline'] as const
    expect(GROUPS).toHaveLength(slices.length)   // 新增片必须同时扩 face（两处同改，本断言绊线）
    for (let i = 0; i < GROUPS.length; i++) {
      expect(await GROUPS[i].list(fake as never)).toEqual(manageFaceOfSlice(slices[i]).map((t) => t.wire))
    }
  })

  it('合并清单 = face 全集（20 件：口径 5 + 报表 4 + 管线提案/需求 11）', async () => {
    const { GROUPS } = await import('./mcp-manage')
    const { MANAGE_FACE_TOOLS } = await import('./mcp-manage-face')
    const names = (await Promise.all(GROUPS.map((g) => g.list(fake as never)))).flat().map((t) => t.name)
    expect(names.sort()).toEqual(MANAGE_FACE_TOOLS.map((t) => t.name).sort())
    expect(MANAGE_FACE_TOOLS).toHaveLength(20)
  })
})
