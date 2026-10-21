// query-detail.test.ts — POST /query/detail 的路由层测试（下钻 spec 2026-10-21 §2.4）。
// 模块壳（buildTestApp）不挂宿主门卫与三通道中间件——那部分归宿主 loader R2；
// 这里验：路由在场（缺路由 = 404）、zod 参数面、requesterOf 身份归一、与 /query 同一
// 的状态码三分法（ok 200 / denied 403 / error 502）。域逻辑本身由 domain/drill.test.ts 钉。
// 夹具照 query.test.ts 的铺法（buildTestApp + 身份注入 + 假执行器），词表/审计用假池应答
// （照 domain/drill.test.ts 的 fakePool）——不需要真库，也不需要湖。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import mod from '../index'
import { buildTestApp, makeIdentity } from '../test-util'
import type { SqlExecutor } from '../domain/query-service'
import { resetWarehousePool } from '../domain/warehouse'

const ORG = 'org-route-detail'
/** 缺省入参：bizday 必传（date_range 参数，与词表 params 夹具同形）。 */
const ARGS = { bizday: { from: '2026-10-19', to: '2026-10-20' } }
/** 能力陈述 detail（消费面据此换措辞，spec §2.6）——逐字钉住，改文案必须红着改。 */
const NO_BINDING_DETAIL = '该指标未声明明细下钻（能力边界，非权限问题）——聚合口径可用 query_metric 查询'

/** data.metrics 行的 DB 形状（loadMergedCatalog 的 select 投影，snake_case；jsonb 列已是对象）。
 *  与 domain/drill.test.ts 的 METRIC_ROW 同形（路由测试不 import 单测夹具，各自成文）。 */
const METRIC_ROW: Record<string, unknown> = {
  id: 'drill:net_sales', title: '净销售额', description: 'd',
  required_scope: null, subject_column: 'org',
  select_sql: 'select sum(fct_t.net_amount) as value, system_book, bizday from fct_t group by system_book, bizday',
  group_by: 'system_book, bizday',
  params: { bizday: { column: 'bizday', type: 'date_range' } },
  source: 'l1', source_system: 'lemeng', updated_by: null, version: 1,
  totalable: false, scope_note: '', sla_days: 1, freshness_relations: [], mask_spec: null,
  drill_expr: '(sale_amount@order - return_amount@line)',
  drill_dims: ['system_book', 'bizday', 'branch_num', 'order_no'],
  drill_detail: { relation: 'vw_t', filter: "state = 'FINISHED'" },
}
/** 已声明但**未声明下钻**的指标（L2 行天然形状：下钻三列恒 NULL）。 */
const NO_DRILL_ROW: Record<string, unknown> = {
  ...METRIC_ROW, id: 'drill:plain', drill_expr: null, drill_dims: null, drill_detail: null,
}

/** 假词表池：应答 loadMergedCatalog 的 metrics select 与 writeAudit 的 insert，其余响亮失败
 *  （照 domain/drill.test.ts 的 fakePool——正则认的是真 store 的 SQL 形状）。 */
function fakePool(metrics: Record<string, unknown>[]) {
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/insert\s+into\s+data\.query_audit/.test(text)) return { rows: [], rowCount: 1 }
      if (/from\s+data\.metrics/.test(text)) {
        void params
        return { rows: metrics.map((m) => ({ ...m })), rowCount: metrics.length }
      }
      throw new Error(`fake pool: unexpected sql: ${text}`)
    },
  }
  return pool as unknown as Pool
}

/** 假湖执行器：count(*) 与明细计划分叉应答，SQL 全量留痕。 */
function execRecording(sqls: string[], count = 15222): SqlExecutor {
  return async (sql) => {
    sqls.push(sql)
    return /count\(\*\)/.test(sql)
      ? { columns: ['n'], rows: [[count]] }
      : { columns: ['system_book', 'bizday', 'branch_num', 'order_no', 'value'], rows: [['3120', '2026-10-19', 142, 'SO001', 123.4]] }
  }
}

/** 经真实路由打一发 /query/detail。sources=['lemeng'] = 宿主投影「已接入该源」（夹具的 source_system）。 */
async function postDetail(pool: Pool, execute: SqlExecutor | undefined, body: unknown) {
  // ctx 用**变量**携带（与 query.test.ts 同款）：绕开 ModuleContext 字面量的多余属性检查。
  const ctx = { pool, execute }
  const app = buildTestApp(
    mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG }, ['lemeng'],
  )
  return app.request('/query/detail', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /query/detail', () => {
  beforeEach(() => {
    // ok 路径的 data_as_of/维度名解析走真仓库缝：env 与惰性单例先清（drill.test.ts 同款纪律），
    // 不吃同 worker 先跑的文件可能留在 process.env 里的 DATA_WAREHOUSE_URL。
    delete process.env.DATA_WAREHOUSE_URL
    resetWarehousePool()
  })

  it('缺 bizday ⇒ 403 + reason=bad_param + detail=missing_param:bizday', async () => {
    const res = await postDetail(fakePool([METRIC_ROW]), undefined, { metricId: 'drill:net_sales', args: {} })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      status: 'denied', metricId: 'drill:net_sales', reason: 'bad_param', detail: 'missing_param:bizday',
    })
  })

  it('未声明下钻的指标 ⇒ 403 + reason=no_detail_binding（body 带能力陈述 detail）', async () => {
    const res = await postDetail(fakePool([NO_DRILL_ROW]), undefined, { metricId: 'drill:plain', args: ARGS })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.reason).toBe('no_detail_binding')
    // 能力陈述逐字透传（企微插件靠它换措辞，不当「没权限」说）——路由不得吞成统一文案
    expect(body.detail).toBe(NO_BINDING_DETAIL)
  })

  it('合法下钻（假执行器）⇒ 200 + rowCountTotal 在场', async () => {
    const sqls: string[] = []
    const res = await postDetail(fakePool([METRIC_ROW]), execRecording(sqls), { metricId: 'drill:net_sales', args: ARGS })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.rowCountTotal).toBe(15222)
    // execute 注入经 RouteCtx 透传（不碰真仓库）：明细 + count 两条
    expect(sqls).toHaveLength(2)
    expect(sqls.some((s) => /count\(\*\)/.test(s))).toBe(true)
  })
})
