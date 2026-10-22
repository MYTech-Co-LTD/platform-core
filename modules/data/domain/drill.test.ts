// drill.test.ts — 下钻执行核心的单测（下钻 spec 2026-10-21 §2.4/§2.5/§2.6）。
//
// 全部走**假执行器 + 假词表池**：词表（loadMergedCatalog 的 metrics select）与审计
// （writeAudit 的 insert）由假池应答，湖由 deps.execute 假执行器应答——不需要真库，也不需要湖。
// 钉的东西：buildDrillSql 的 SQL 形状（逐字）、runDetailQuery 的门序、参数校验、掩码接线、
// 湖竞态重试与审计面。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { buildDrillSql, runDetailQuery } from './drill'
import type { DrillBinding, Requester } from './authz'
import type { QueryDeps } from './query-service'
import { resetWarehousePool } from './warehouse'

const DRILL: DrillBinding = {
  expr: '(sale_amount@order - return_amount@line)',
  dims: ['system_book', 'bizday', 'branch_num', 'order_no'],
  relation: 'vw_t',
  filter: "state = 'FINISHED'",
}

/** #452 真机形态（形状级，值部分换短例——竞态窄匹配只认「ETag on reading file」，与
 *  query-service.test.ts 的 RACE_MSG 同一做法）。 */
const RACE_MSG =
  'HTTP Error: ETag on reading file "s3://shanhai-data/lemeng/retail_order_line/system_book=3120/bizday=2026-10-06/hour=10/all.parquet" was initially "a" and now it returned "b", this likely means the remote file has changed.'

const ORG = 'org_a'
/** 缺省入参：bizday 必传（date_range 参数，与词表 params 夹具同形）。 */
const ARGS = { bizday: { from: '2026-10-19', to: '2026-10-20' } }
/** 能力陈述 detail（消费面据此换措辞，spec §2.6）——逐字钉在这里，改文案必须红着改。 */
const NO_BINDING_DETAIL = '该指标未声明明细下钻（能力边界，非权限问题）——聚合口径可用 query_metric 查询'

/** data.metrics 行的 DB 形状（loadMergedCatalog 的 select 投影，snake_case；jsonb 列已是对象）。 */
const METRIC_ROW: Record<string, unknown> = {
  id: 'drill:net_sales', title: '净销售额', description: 'd',
  required_scope: null, subject_column: 'org',
  select_sql: 'select sum(fct_t.net_amount) as value, system_book, bizday from fct_t group by system_book, bizday',
  group_by: 'system_book, bizday',
  params: { bizday: { column: 'bizday', type: 'date_range' } },
  source: 'l1', source_system: 'lemeng', updated_by: null, version: 1,
  totalable: false, scope_note: '', sla_days: 1, freshness_relations: [], mask_spec: null,
  drill_expr: DRILL.expr, drill_dims: DRILL.dims, drill_detail: { relation: DRILL.relation, filter: DRILL.filter },
}
/** 已声明但**未声明下钻**的指标（L2 行天然形状：下钻三列恒 NULL）。 */
const NO_DRILL_ROW: Record<string, unknown> = {
  ...METRIC_ROW, id: 'drill:plain', drill_expr: null, drill_dims: null, drill_detail: null,
}

function req(over: Partial<Requester> = {}): Requester {
  const scopes = over.scopes ?? ['data:query']
  return {
    userId: 'alice', orgId: ORG, channel: 'session', keyId: null, scopes,
    hasScope: (c) => scopes.includes(c), ...over,
  }
}

/** 假词表池：应答 loadMergedCatalog 的 metrics select 与 writeAudit 的 insert，其余响亮失败。 */
function fakePool(metrics: Record<string, unknown>[]) {
  const audits: { text: string; params: unknown[] }[] = []
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (/insert\s+into\s+data\.query_audit/.test(text)) {
        audits.push({ text, params: params ?? [] })
        // Wave1 起 writeAudit 读 returning 行（信封 audit 节用）——替身收严到真机形状
        // （registry.test.ts / query-service.test.ts 同款）。
        return { rows: [{ id: 1, created_at: new Date('2026-10-21T10:00:00Z') }] }
      }
      if (/from\s+data\.metrics/.test(text)) {
        return { rows: metrics.map((m) => ({ ...m })), rowCount: metrics.length }
      }
      throw new Error(`fake pool: unexpected sql: ${text}`)
    },
  }
  return { pool: pool as unknown as Pool, audits }
}

/** writeAudit 的位置参数序（合并后 12 列：…, masking=9, drill=10, tool=11）——断言用下标，靠本常量组自释。 */
const AUDIT_VERDICT = 7
const AUDIT_REASON = 8
const AUDIT_MASKING = 9
const AUDIT_DRILL = 10

/** 假湖执行器：count(*) 与明细计划分叉应答，SQL 全量留痕。 */
function execRecording(sqls: string[], count = 15222) {
  return async (sql: string) => {
    sqls.push(sql)
    return /count\(\*\)/.test(sql)
      ? { columns: ['n'], rows: [[count]] }
      : { columns: ['system_book', 'bizday', 'branch_num', 'order_no', 'value'], rows: [['3120', '2026-10-19', 142, 'SO001', 123.4]] }
  }
}

function depsOf(pool: Pool, sqls: string[], over: Partial<QueryDeps> = {}): QueryDeps {
  return {
    pool,
    adoptedSources: new Set(['lemeng']),
    dimensionLookup: async () => null,   // 名称解析缝：本文件不验装饰（dimension-labels 自己的单测管）
    execute: execRecording(sqls),
    ...over,
  }
}

describe('buildDrillSql（纯函数）', () => {
  it('缺省 = 原子粒度，value 降序；rowCountSql = 同一 where 的裸 count(*)', () => {
    const p = buildDrillSql(DRILL, DRILL.dims, "org = 'o' AND state = 'FINISHED'", 'value', true, 50, 0)
    expect(p.sql).toBe("select system_book, bizday, branch_num, order_no, sum(value) as value from ( select system_book, bizday, branch_num, order_no, ((sale_amount@order - return_amount@line)) as value from vw_t where org = 'o' AND state = 'FINISHED' group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday, branch_num, order_no order by value desc limit 50 offset 0")
    expect(p.rowCountSql).toBe("select count(*) as n from vw_t where org = 'o' AND state = 'FINISHED'")
    expect(p.dimensions).toEqual(DRILL.dims)
  })

  it('子集上卷：请求维度变粗（外层 group by 收窄），内层原子粒度不动', () => {
    const p = buildDrillSql(DRILL, ['system_book', 'bizday'], 'w', 'value', true, 50, 0)
    expect(p.sql).toContain('group by system_book, bizday order by value desc')
    expect(p.sql).toContain('group by system_book, bizday, branch_num, order_no ) t')
    expect(p.dimensions).toEqual(['system_book', 'bizday'])
  })
})

describe('runDetailQuery（假执行器 + 假词表池，不需要湖）', () => {
  beforeEach(() => {
    // 本文件的 data_as_of 判据钉「仓库未配 ⇒ 字段缺席」：env 与惰性单例先清，
    // 不吃同 worker 先跑的文件可能留在 process.env 里的 DATA_WAREHOUSE_URL。
    delete process.env.DATA_WAREHOUSE_URL
    resetWarehousePool()
  })

  it('缺 bizday ⇒ bad_param missing_param:bizday（400 面），从未触达湖，审计留痕', async () => {
    const { pool, audits } = fakePool([METRIC_ROW])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:net_sales', {}, {})
    expect(out).toEqual({ status: 'denied', metricId: 'drill:net_sales', reason: 'bad_param', detail: 'missing_param:bizday' })
    expect(sqls).toEqual([])                                     // 被拒 ⇒ 从未触达湖
    expect(audits).toHaveLength(1)                               // 被拒也留痕（spec §5 约束 7）
    expect(audits[0].params[AUDIT_VERDICT]).toBe('denied')
    expect(audits[0].params[AUDIT_REASON]).toBe('bad_param')
    expect(audits[0].params[6]).toBeNull()                       // row_count：没有行数可记（null ≠ 0）
  })

  it('已声明但未声明下钻 ⇒ no_detail_binding（能力陈述逐字），审计照写', async () => {
    const { pool, audits } = fakePool([NO_DRILL_ROW])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:plain', ARGS, {})
    expect(out).toEqual({ status: 'denied', metricId: 'drill:plain', reason: 'no_detail_binding', detail: NO_BINDING_DETAIL })
    expect(sqls).toEqual([])
    expect(audits[0].params[AUDIT_REASON]).toBe('no_detail_binding')
  })

  it('词表里没有的 id ⇒ 门序先过 authorize：metric_not_declared（不是 no_detail_binding）', async () => {
    // 门序钉子（计划 Task 7 的拒绝链顺序）：authorize 在 drill presence 之前——
    // 「词表里没有这个 id」是声明/裁剪面的回答，先于「有没有下钻能力」。
    const { pool } = fakePool([METRIC_ROW])
    const out = await runDetailQuery(depsOf(pool, []), ORG, req(), 'drill:no_such', ARGS, {})
    expect(out).toEqual({ status: 'denied', metricId: 'drill:no_such', reason: 'metric_not_declared' })
  })

  it('dimensions 超出闭集 ⇒ bad_param unknown_dimension:item_num（不许凭空加列）', async () => {
    const { pool } = fakePool([METRIC_ROW])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:net_sales', ARGS, { dimensions: ['system_book', 'item_num'] })
    expect(out).toEqual({ status: 'denied', metricId: 'drill:net_sales', reason: 'bad_param', detail: 'unknown_dimension:item_num' })
    expect(sqls).toEqual([])
  })

  it('limit 5000 静默夹到 500（不报错）；limit=0 ⇒ bad_param invalid_value:limit（两个断言）', async () => {
    const { pool } = fakePool([{ ...METRIC_ROW, scope_note: '仅含乐檬直营 47 家门店' }])
    const sqls: string[] = []
    const clamped = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:net_sales', ARGS, { limit: 5000 })
    expect(clamped.status, '上限超出是静默夹紧，不是拒绝').toBe('ok')
    const detailSql = sqls.find((s) => !/count\(\*\)/.test(s))
    expect(detailSql).toContain('limit 500 offset 0')            // 常量漂移必须红：钉字面量，不钉 import
    expect(clamped.status === 'ok' && clamped.scope_line).toBe('📐 口径：仅含乐檬直营 47 家门店')

    const zero = await runDetailQuery(depsOf(pool, []), ORG, req(), 'drill:net_sales', ARGS, { limit: 0 })
    expect(zero).toEqual({ status: 'denied', metricId: 'drill:net_sales', reason: 'bad_param', detail: 'invalid_value:limit' })
  })

  it('ok 回包带 rowCountTotal（来自 count SQL，不是 rows.length）与 dimensions（缺省=原子粒度）', async () => {
    const { pool, audits } = fakePool([METRIC_ROW])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:net_sales', ARGS, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.rowCountTotal).toBe(15222)
    expect(out.dimensions).toEqual(DRILL.dims)
    expect(out.subject).toBe('org_a')                            // 主体钉死回包可独立验证
    expect(out.truncated).toBe(false)                            // 1 行 < limit 50
    expect(out.columns).toEqual(['system_book', 'bizday', 'branch_num', 'order_no', 'value'])
    expect(out.rows).toEqual([['3120', '2026-10-19', 142, 'SO001', 123.4]])
    expect(out.drill_as_of).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/)
    expect('data_as_of' in out, '仓库未配 ⇒ 物化钟缺席（未知 ≠ 捏造）').toBe(false)
    expect('clock_note' in out).toBe(false)
    expect('scope_line' in out, '未声明射程 ⇒ 字段缺席').toBe(false)
    expect('masking' in out, '未声明掩码 ⇒ 字段缺席').toBe(false)
    // 两条 SQL：明细（内层原子粒度求组件 + 外层按请求维度上卷）与 count；where 三件套 =
    // 主体钉死 + 声明 filter + 参数连接词（与聚合面同一 paramFilters 产物）。
    // 内层 **value-first**（终审 C1 后掩码路径与 buildDrillSql 的 inner 仅列序不同、语义等价）
    expect(sqls).toHaveLength(2)
    expect(sqls[0]).toBe(
      "select system_book, bizday, branch_num, order_no, sum(value) as value from ( select ((sale_amount@order - return_amount@line)) as value, system_book, bizday, branch_num, order_no from vw_t where org = 'org_a' AND state = 'FINISHED' AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday, branch_num, order_no order by value desc limit 50 offset 0")
    expect(sqls[1]).toBe("select count(*) as n from vw_t where org = 'org_a' AND state = 'FINISHED' AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date")
    // 审计：verdict ok + 行数（=回包行数）+ masking null（无掩码生效）+ drill 面 {dimensions, rowCountTotal}
    expect(audits).toHaveLength(1)
    expect(audits[0].params[AUDIT_VERDICT]).toBe('ok')
    expect(audits[0].params[6]).toBe(1)
    expect(audits[0].params[AUDIT_REASON]).toBeNull()
    expect(audits[0].params[AUDIT_MASKING]).toBeNull()
    expect(JSON.parse(audits[0].params[AUDIT_DRILL] as string)).toEqual({ dimensions: DRILL.dims, rowCountTotal: 15222 })
  })

  it('整值掩码：内层 value 头被 null 化（原表达式一个不剩），masking 三态透出；count SQL 不掩', async () => {
    const MASKED_ROW: Record<string, unknown> = {
      ...METRIC_ROW, id: 'drill:masked',
      mask_spec: [{ column: null, kind: 'nullify', grantedBy: 'data:precise' }],
    }
    const { pool, audits } = fakePool([MASKED_ROW])
    const sqls: string[] = []
    const deps = depsOf(pool, sqls, {
      execute: async (sql: string) => {
        sqls.push(sql)
        return /count\(\*\)/.test(sql)
          ? { columns: ['n'], rows: [[15222]] }
          : { columns: ['system_book', 'bizday', 'branch_num', 'order_no', 'value'], rows: [['3120', '2026-10-19', 142, 'SO001', null]] }
      },
    })
    const out = await runDetailQuery(deps, ORG, req(), 'drill:masked', ARGS, {})   // requester 无 data:precise ⇒ 不豁免
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    // 全形状钉（终审 C1 的缺口就在「只钉子串」：吞掉维度列的内层任何子串断言都照绿）——
    // 内层 value 头之后必须**紧跟维度列**，外层 group by 的列必须都在内层投影里。
    expect(sqls[0]).toBe(
      "select system_book, bizday, branch_num, order_no, sum(value) as value from ( select cast(null as numeric) as value, system_book, bizday, branch_num, order_no from vw_t where org = 'org_a' AND state = 'FINISHED' AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday, branch_num, order_no order by value desc limit 50 offset 0")
    expect(sqls[0]).toContain('cast(null as numeric) as value, system_book')
    expect(sqls[0], '原组件表达式一个不剩（掩码在授权层展开，执行层拿到的是已掩 SQL）').not.toContain('sale_amount@order')
    expect(sqls[1], 'rowCountTotal 数行数，与值掩码正交 ⇒ count SQL 不掩').not.toContain('cast(null')
    expect(out.masking).toEqual({ '<value>': 'nullify' })
    expect(out.rows[0][4]).toBeNull()                            // 执行器回 null ⇒ 原样透出
    expect(JSON.parse(audits[0].params[AUDIT_MASKING] as string)).toEqual({ '<value>': 'nullify' })
    // 子集请求 + 掩码：requested 的维度列必须在整值替换后幸存（外层 group by 引用得到）
    const subset = await runDetailQuery(deps, ORG, req(), 'drill:masked', ARGS, { dimensions: ['system_book', 'bizday'] })
    expect(subset.status).toBe('ok')
    if (subset.status !== 'ok') return
    expect(sqls[2]).toBe(
      "select system_book, bizday, sum(value) as value from ( select cast(null as numeric) as value, system_book, bizday from vw_t where org = 'org_a' AND state = 'FINISHED' AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday order by value desc limit 50 offset 0")
    expect(subset.dimensions).toEqual(['system_book', 'bizday'])
  })

  it('湖竞态：首次 ETag 错误退避重试恰一次成功，审计 reason=lake_race_retry', async () => {
    const { pool, audits } = fakePool([METRIC_ROW])
    const sqls: string[] = []
    let calls = 0
    const deps = depsOf(pool, [], {
      raceRetryDelayMs: 0,                                       // 测试缝：退避归零，免真等 1s
      execute: async (sql: string) => {
        calls++
        sqls.push(sql)
        if (calls === 1) throw new Error(RACE_MSG)
        return /count\(\*\)/.test(sql)
          ? { columns: ['n'], rows: [[15222]] }
          : { columns: ['value'], rows: [[1]] }
      },
    })
    const out = await runDetailQuery(deps, ORG, req(), 'drill:net_sales', ARGS, {})
    expect(out.status).toBe('ok')
    expect(calls).toBe(3)                                        // 明细 2 次（1 撞 + 恰一次重试）+ count 1 次
    expect(sqls[0]).toBe(sqls[1])                                // 重试的是同一条明细 SQL
    expect(audits[0].params[AUDIT_VERDICT]).toBe('ok')
    expect(audits[0].params[AUDIT_REASON]).toBe('lake_race_retry')
  })

  it('count 腿单独撞湖竞态：重试恰一次成功，审计 reason=lake_race_retry（retried 多处累计）', async () => {
    // 明细腿全干净、只有 count 腿第一次撞 ETag——审计 reason 若只看明细腿（cnt.retried 被丢），
    // ok 行会记 null，「重试是否长期够用」的数据源（spec §3.5）就漏了 count 这一半。
    const { pool, audits } = fakePool([METRIC_ROW])
    const sqls: string[] = []
    let countCalls = 0
    const deps = depsOf(pool, [], {
      raceRetryDelayMs: 0,                                       // 测试缝：退避归零，免真等 1s
      execute: async (sql: string) => {
        sqls.push(sql)
        if (/count\(\*\)/.test(sql)) {
          countCalls++
          if (countCalls === 1) throw new Error(RACE_MSG)
          return { columns: ['n'], rows: [[15222]] }
        }
        return { columns: ['value'], rows: [[1]] }
      },
    })
    const out = await runDetailQuery(deps, ORG, req(), 'drill:net_sales', ARGS, {})
    expect(out.status).toBe('ok')
    expect(sqls.length).toBe(3)                                  // 1 明细 + 2 count（1 撞 + 恰一次重试）
    expect(sqls.filter((s) => /count\(\*\)/.test(s)).length).toBe(2)
    expect(sqls[0], '明细腿全程干净').not.toContain('count(*)')
    expect(audits[0].params[AUDIT_VERDICT]).toBe('ok')
    expect(audits[0].params[AUDIT_REASON]).toBe('lake_race_retry')
  })

  it('非 ETag 错误不重试（calls=1）→ warehouse_error 原文透出（窄匹配回归护栏）', async () => {
    const { pool, audits } = fakePool([METRIC_ROW])
    let calls = 0
    const deps = depsOf(pool, [], {
      raceRetryDelayMs: 0,
      execute: async () => { calls++; throw new Error('boom') },
    })
    const out = await runDetailQuery(deps, ORG, req(), 'drill:net_sales', ARGS, {})
    expect(calls).toBe(1)
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_error')
    expect(out.detail).toBe('boom')
    expect(audits[0].params[AUDIT_VERDICT]).toBe('error')
    expect(audits[0].params[AUDIT_REASON]).toBe('warehouse_error')
  })

  it('detail.columns 坏形状 ⇒ 整个下钻绑定作废（no_detail_binding，fail-closed）', async () => {
    // 读侧不信任存储形状（同三键纪律）：一份读不懂的权限声明，宁可不给下钻，
    // 也不按它去投影列——「半绑」会让未授权列有暴露面。
    const { pool, audits } = fakePool([{
      ...METRIC_ROW, id: 'drill:badcols',
      drill_detail: { relation: 'vw_t', filter: 'true', columns: [{ col: 'order_detail_std_price' }] },
    }])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:badcols', ARGS, {})
    expect(out).toEqual({ status: 'denied', metricId: 'drill:badcols', reason: 'no_detail_binding', detail: NO_BINDING_DETAIL })
    expect(sqls).toEqual([])
    expect(audits[0].params[AUDIT_REASON]).toBe('no_detail_binding')
  })

  it('detail.columns 合法 ⇒ 绑定照常成立（条件列由执行面消费，Task 5 验）', async () => {
    const { pool } = fakePool([{
      ...METRIC_ROW, id: 'drill:cols',
      drill_detail: { relation: 'vw_t', filter: 'true', columns: [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }] },
    }])
    const out = await runDetailQuery(depsOf(pool, []), ORG, req(), 'drill:cols', ARGS, {})
    expect(out.status).toBe('ok')
  })
})
