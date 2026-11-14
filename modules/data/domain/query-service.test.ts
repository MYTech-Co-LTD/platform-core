import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { runQuery, freshnessFaceFor, freshnessLineOf, freshnessRelationsOf, freshnessStatusOf, formatHumanDay, type QueryDeps, type SqlExecutor } from './query-service'
import { L1_ORG, upsertL1Metric, upsertMetric } from './metric-store'
import { applyMigrations, applyPlatformMigrations } from '../test-util'
import { MAX_QUERY_ROWS, type MaskSpec, type Requester } from './authz'
import { DATA_WAREHOUSE_UNCONFIGURED, resetWarehousePool, runWarehouseSql, warehousePool } from './warehouse'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = Casdoor org）。**与 `req()` 的 `orgId` 同值**——生产上两者就是同一个值
 *  （隔离键取宿主注入的 `identity.orgId`，主体值取 `Requester.orgId`，同一租户同一 org），
 *  测试里让它们相等才不至于验一个现实中不存在的状态。 */
const ORG = 'org_a'
/** 本文件的 L1 夹具 id 前缀（L1 行落平台桶 org='platform'，清理按前缀——别全清平台桶）。 */
const L1_TOTAL_PREFIX = 't9q_total:'

/** #452 真机形态（2026-10-06 run jrun_dtyVWZnnFaQ_pCCN 实测原文的形状，值部分换短例）。
 *  判据窄匹配只认「ETag on reading file」——测试钉的是形状，不是整句。 */
const RACE_MSG =
  'HTTP Error: ETag on reading file "s3://shanhai-data/lemeng/retail_order_line/system_book=3120/bizday=2026-10-06/hour=10/all.parquet" was initially "a" and now it returned "b", this likely means the remote file has changed.'

/** #466 M2 负样本：**同面异形**——同为 DuckDB「读文件失败」错误形状、但**无 ETag 词**。
 *  钉住窄匹配不是「/on reading file/ 就重试」：正则若放宽丢了 ETag，本例必须红。 */
const NON_RACE_MSG = 'HTTP Error: 500 on reading file "s3://x/y.parquet"'

const METRIC = {
  id: 'sales_daily', title: '销售日明细', description: '',
  requiredScope: 'data:query', subjectColumn: 'org',
  selectSql: 'SELECT org, day FROM marts.sales_daily', groupBy: '', params: {},
}

function req(over: Partial<Requester> = {}): Requester {
  const scopes = over.scopes ?? ['data:query']
  return {
    userId: 'alice', orgId: 'org_a', channel: 'session', keyId: null, scopes,
    hasScope: (c) => scopes.includes(c), ...over,
  }
}

describePg('runQuery（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  // 注入假仓库：本任务只验编排，不验 SQL 真跑（真跑归 T10 的 e2e）
  let lastSql = ''
  const deps: QueryDeps = {
    pool,
    // 已接入源：本文件的夹具全部经 `upsertMetric` 落库（= L2 行，`sourceSystem: null`）
    // ⇒ 它们**不受源维度裁剪影响**，空集就够（空集只裁掉 L1 行——本文件一条 L1 都没有）。
    adoptedSources: new Set<string>(),
    execute: async (sql) => {
      lastSql = sql
      return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
    },
  }

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await upsertMetric(pool, ORG, METRIC, 'fixture')
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    // L1 夹具落在平台桶（org='platform'）——只按本文件前缀清，别碰别人的行
    await pool.query('delete from data.metrics where org = $1 and id like $2',
      [L1_ORG, `${L1_TOTAL_PREFIX}%`]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('ok：执行 SQL 只带本主体，回包带 subject，审计记 ok + 行数', async () => {
    const out = await runQuery(deps, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.subject).toBe('org_a')
    expect(out.rows).toEqual([['org_a', '2026-08-15']])
    expect(lastSql).toContain("WHERE org = 'org_a'")

    const a = await pool.query(
      `select channel, key_id, verdict, row_count, reason from data.query_audit
        where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ channel: 'session', key_id: null, verdict: 'ok', row_count: 1 })
  })

  it('denied：scope 不够的指标 —— 被**裁剪**掉（metric_not_declared），不执行 SQL，但审计照写', async () => {
    // ⚠️ 清零必须在 runQuery **之前**：写在之后等于把这次调用留下的证据擦掉，
    //    断言恒真（跑没跑 SQL 都绿）——「从未触达仓库」就变成一句没人验的话。
    lastSql = ''
    const out = await runQuery(deps, ORG, req({ scopes: [] }), 'sales_daily', {})
    // ★ 计划 5 起 reason 是 `metric_not_declared`（此前是 `metric_not_authorized`）：
    //   runQuery 现在与另外三条消费面**同款**——先经 `visibleMetrics` 裁剪（scope **与** 源维度），
    //   再交给 authorize。scope 不够的指标在 authorize 看到它之前就没了 ⇒ 对它「不可见」
    //   （spec §5 约束 3 的原文口径）。在此之前，`list_metrics`/`GET /metrics`/MCP 都已隐藏它，
    //   只有 /query 会回一句「存在但你没权限」——那是个**存在性探针**，与被裁的三条面自相矛盾。
    //   `authorize` 自身的 `metric_not_authorized` 分支未变（authz.test.ts 的 C2 仍钉着它）：
    //   它仍是本核心的契约，只是消费面在它之前已把词表收窄。
    expect(out).toEqual({ status: 'denied', metricId: 'sales_daily', reason: 'metric_not_declared' })
    const a = await pool.query(
      `select verdict, reason from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'denied', reason: 'metric_not_declared' })
    expect(lastSql).toBe('')                                   // 被拒 ⇒ 从未触达仓库
  })

  it('denied：匿名（requester = null）→ unauthenticated，审计也留痕', async () => {
    const out = await runQuery(deps, ORG, null, 'sales_daily', {})
    expect(out).toEqual({ status: 'denied', metricId: 'sales_daily', reason: 'unauthenticated' })
    // 匿名被拒**也留痕**（约束 7）：匿名占位主体 + 默认 session 通道 + 无 key。
    // 只查回包形状验不到这一写——回归掉 audit('denied','unauthenticated') 时这里必须红。
    const a = await pool.query(
      `select user_id, channel, key_id, verdict, reason from data.query_audit
        where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({
      user_id: '(anonymous)', channel: 'session', key_id: null,
      verdict: 'denied', reason: 'unauthenticated',
    })
  })

  it('denied：PAT 通道的 key_id 落进审计（通道 B 可追溯到具体 key）', async () => {
    await runQuery(deps, ORG, req({ channel: 'pat', keyId: 42 }), 'sales_daily', {})
    const a = await pool.query(
      `select channel, key_id from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ channel: 'pat', key_id: '42' })
  })

  it('error：仓库执行抛错 → status:error + 审计 verdict=error', async () => {
    const bad: QueryDeps = { pool, adoptedSources: new Set(), execute: async () => { throw new Error('boom') } }
    const out = await runQuery(bad, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_error')
    const a = await pool.query(
      `select verdict, reason from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'error', reason: 'warehouse_error' })
  })

  it('race：ETag 竞态错 → 退避重试恰一次成功，审计 verdict=ok + reason=lake_race_retry', async () => {
    let calls = 0
    const flaky: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,                                   // 测试缝：退避归零，免真等 1s
      execute: async () => {
        calls++
        if (calls === 1) throw new Error(RACE_MSG)
        return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
      },
    }
    const startedAt = Date.now()                             // #466 M1：0 注入必须=立即——
    const out = await runQuery(flaky, ORG, req(), 'sales_daily', {})
    expect(Date.now() - startedAt).toBeLessThan(500)         // 实现若忽略注入、写死 1000ms 默认，这里红
    expect(out.status).toBe('ok')
    expect(calls).toBe(2)                                    // 恰一次：不是 0 次也不是 ≥3 次
    // 重试成功也留痕：reason=lake_race_retry 是 spec §3.5 判「重试长期是否够用」的数据源
    const a = await pool.query(
      `select verdict, reason, row_count from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'ok', reason: 'lake_race_retry', row_count: 1 })
  })

  it('race：连撞两次 → status=error reason=warehouse_transient（detail 保留原文），审计照写', async () => {
    let calls = 0
    const alwaysRace: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,
      execute: async () => { calls++; throw new Error(RACE_MSG) },
    }
    const out = await runQuery(alwaysRace, ORG, req(), 'sales_daily', {})
    expect(calls).toBe(2)
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_transient')           // 不是裸 warehouse_error
    expect(out.detail).toBe(RACE_MSG)                        // 原文供排障
    const a = await pool.query(
      `select verdict, reason from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'error', reason: 'warehouse_transient' })
  })

  it('race：注入 30ms 则真等（≥25ms）又不等默认 1000ms（<500ms）——raceRetryDelayMs 被真实消费', async () => {
    // #466 M1 正方向：钉「注入值被消费」本身，不只钉 0——
    //   若实现把注入值丢掉（恒 0）→ <25ms 红；若写死默认 1000ms → <500ms 红。
    let calls = 0
    const flaky: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 30,
      execute: async () => {
        calls++
        if (calls === 1) throw new Error(RACE_MSG)
        return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
      },
    }
    const startedAt = Date.now()
    const out = await runQuery(flaky, ORG, req(), 'sales_daily', {})
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(25)               // 真等了（Node 计时器不早发，30ms 注入实际 ≥30）
    expect(elapsed).toBeLessThan(500)                        // 又没等默认的 1000ms
    expect(out.status).toBe('ok')
    expect(calls).toBe(2)
  })

  it('race：非 ETag 错误不重试（calls=1）→ 原样 warehouse_error（窄匹配的回归护栏）', async () => {
    let calls = 0
    const bad: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,
      execute: async () => { calls++; throw new Error(NON_RACE_MSG) },
    }
    const out = await runQuery(bad, ORG, req(), 'sales_daily', {})
    expect(calls).toBe(1)                                    // 同面异形：读了文件但不是 ETag 竞态 ⇒ 不重试
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_error')
    expect(out.detail).toBe(NON_RACE_MSG)                    // 原文供排障
  })

  it('error：未配仓库 → reason=warehouse_unconfigured（不是 warehouse_error）', async () => {
    // 按 T3 warehouse.ts 的**真形状**注入：真源就是 new Error(DATA_WAREHOUSE_UNCONFIGURED)
    // （常量从 './warehouse' import，query-service 以 === 全等判 err.message）——不造近似值。
    const unconfigured: QueryDeps = {
      pool,
      adoptedSources: new Set(),
      execute: async () => { throw new Error(DATA_WAREHOUSE_UNCONFIGURED) },
    }
    const out = await runQuery(unconfigured, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_unconfigured')          // 关键分叉：走配错分支而非笼统 warehouse_error
    expect(out.detail).toBe(DATA_WAREHOUSE_UNCONFIGURED)
    const a = await pool.query(
      `select verdict, reason from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'error', reason: 'warehouse_unconfigured' })
  })

  it('truncated：行数达到上限时置位', async () => {
    const many: QueryDeps = {
      pool,
      adoptedSources: new Set(),
      execute: async () => ({ columns: ['org'], rows: Array.from({ length: 1000 }, () => ['org_a']) }),
    }
    const out = await runQuery(many, ORG, req(), 'sales_daily', {})
    expect(out.status === 'ok' && out.truncated).toBe(true)
  })

  // ── 维度名称解析（issue #857）──────────────────────────────────────────────────
  it('维度名称：回包在 system_book / branch_num 之后插入 brand_name / branch_name，原 key 保留', async () => {
    const withDim: QueryDeps = {
      pool,
      adoptedSources: new Set(),
      execute: async () => ({ columns: ['system_book', 'branch_num', 'value'], rows: [['3120', 142, 9.5]] }),
      dimensionLookup: async () => ({
        brandByBook: new Map([['3120', '熊喵鲜生']]),
        branchNameByKey: new Map([['3120|142', '品品甜折扣昆明壹号广场店']]),
        regionByKey: new Map(),
        clientNameByFid: new Map(),
        supplierNameByNum: new Map(),
      }),
    }
    const out = await runQuery(withDim, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.columns).toEqual(['system_book', 'brand_name', 'branch_num', 'branch_name', 'value'])
    expect(out.rows[0]).toEqual(['3120', '熊喵鲜生', 142, '品品甜折扣昆明壹号广场店', 9.5])
  })

  it('维度缺席（lookup 返回 null）⇒ 不加名称列、主查询照常交付（缺账不反噬）', async () => {
    const noDim: QueryDeps = {
      pool,
      adoptedSources: new Set(),
      execute: async () => ({ columns: ['system_book', 'branch_num', 'value'], rows: [['3120', 142, 9.5]] }),
      dimensionLookup: async () => null,
    }
    const out = await runQuery(noDim, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.columns).toEqual(['system_book', 'branch_num', 'value'])
    expect(out.rows[0]).toEqual(['3120', 142, 9.5])
  })

  // ── 合计形态（spec §8）＋ 自动伴随（spec §8.4）────────────────────────────────
  it('total：args.total=true → 单行聚合回包（total 字段=合计值，不再是布尔标记）、truncated 恒 false，审计记 ok', async () => {
    let totalSql = ''
    const totalDeps: QueryDeps = {
      pool, adoptedSources: new Set(),
      execute: async (sql) => {
        totalSql = sql
        return { columns: ['total'], rows: [[1470.5]] }
      },
    }
    const out = await runQuery(totalDeps, ORG, req(), 'sales_daily', { total: true })
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(totalSql).toContain('sum(value)')
    expect(totalSql).not.toContain('LIMIT')              // 执行的就是 authz 出的合计计划（无外层帽）
    expect(out.columns).toEqual(['total'])
    expect(out.rows).toEqual([[1470.5]])
    expect(out.truncated).toBe(false)                    // 合计无截断面（恒单行）
    expect(out.total, '#699 的 total:true 布尔已废（spec §8.4）：total=合计值').toBe(1470.5)
    const a = await pool.query(
      `select verdict, row_count from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'ok', row_count: 1 })
  })

  it('total：合计语义真库验证——计划 SQL 在夹具表上执行 = 明细 value 之和，恒单行', async () => {
    // 真库（临时表 + 专用连接）上跑 authz 出的合计计划 SQL 本身——验证的不只是
    // 「SQL 长得像」，而是合计语义（spec §8.2：数学上 = 明细 value 列之和）真成立。
    const client = await pool.connect()
    try {
      await client.query('create temp table qp3_total_face (org text, bizday date, v numeric)')
      await client.query(
        `insert into qp3_total_face values
           ('org_a','2026-10-08',100),('org_a','2026-10-09',47.5),('org_b','2026-10-08',999)`)
      await upsertMetric(pool, ORG, {
        ...METRIC, id: 'sales_total_fixture', title: '销售日明细·total_face',
        // 照真实 L1 形态（buildSelectSql：`select <聚合 expr> as value, <grain> from <rel>`）：
        // 内层 GROUP BY 要求 value 是聚合列——裸列会被 Postgres 拒（上面实测过）。
        selectSql: 'SELECT sum(v) AS value, org, bizday FROM qp3_total_face',
        groupBy: 'org, bizday',
      }, 'fixture')
      let captured = ''
      const rec: QueryDeps = {
        pool, adoptedSources: new Set(),
        execute: async (sql) => { captured = sql; return { columns: ['total'], rows: [[0]] } },
      }
      const out = await runQuery(rec, ORG, req(), 'sales_total_fixture', { total: true })
      expect(out.status).toBe('ok')
      expect(captured).not.toContain('LIMIT')
      // 100 + 47.5 = 147.5；org_b 的 999 必须被主体钉死挡在内层 WHERE 外
      const got = await client.query(captured)
      expect(got.rows).toEqual([{ total: '147.5' }])     // numeric 经 node-pg 回字符串
    } finally {
      client.release()
    }
  })

  // ── 自动伴随（spec §8.4）：totalable 指标的任何查询响应自动附 total=合计值 ──────
  it('自动伴随：totalable 指标普通查询 → 执行 totalSql 并把合计值附到响应 total；明细 rows/truncated 不变', async () => {
    // L1 夹具（totalable 只有 L1 物化路径带值）；id 带本文件专用前缀，afterAll 按前缀清理
    // 平台桶（理由同 metric-store.test.ts 的 L1_ID_PREFIX：不带前缀会被 sync --check 读成删除漂移）。
    await upsertL1Metric(pool, {
      ...METRIC, id: L1_TOTAL_PREFIX + 'auto', title: '销售日明细·total_auto',
      selectSql: 'SELECT sum(v) AS value, org, bizday FROM qp3_total_auto',
      groupBy: 'org, bizday',
      sourceSystem: 'lemeng', totalable: true, slaDays: 1, freshnessRelations: [], masks: null,
    })
    const sqls: string[] = []
    const autoDeps: QueryDeps = {
      pool,
      adoptedSources: new Set(['lemeng']),   // L1 行带源维度 ⇒ 必须已接入才可见
      execute: async (sql) => {
        sqls.push(sql)
        return /SELECT sum\(value\) AS total/.test(sql)
          ? { columns: ['total'], rows: [['1470.5']] }
          : { columns: ['org', 'bizday', 'value'], rows: [['org_a', '2026-10-08', '1000'], ['org_a', '2026-10-09', '470.5']] }
      },
    }
    const out = await runQuery(autoDeps, ORG, req(), L1_TOTAL_PREFIX + 'auto', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    // 两条 SQL：先明细（带 LIMIT），再自动合计（sum、无 LIMIT——与显式合计同一形状）
    expect(sqls.length).toBe(2)
    expect(sqls[0]).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
    expect(sqls[1]).toMatch(/^SELECT sum\(value\) AS total FROM \( .*\) t$/)
    expect(sqls[1]).not.toContain('LIMIT')
    expect(sqls[1]).toContain("WHERE org = 'org_a'")
    // 明细语义原样；total = 合计值（数值/numeric 字符串与 rows 同源）
    expect(out.rows).toEqual([['org_a', '2026-10-08', '1000'], ['org_a', '2026-10-09', '470.5']])
    expect(out.truncated).toBe(false)
    expect(out.total).toBe('1470.5')
    const a = await pool.query(
      `select verdict, row_count from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    // 审计的 row_count 仍是**明细**行数（合计不是行，不该顶掉行数语义）
    expect(a.rows[0]).toMatchObject({ verdict: 'ok', row_count: 2 })
  })

  it('自动伴随：非 totalable 指标 → 响应**无** total 字段（比率/去重计数不给合计，模型也不得跨行求和）', async () => {
    // METRIC 经 upsertMetric 落库 = L2 行 ⇒ totalable 恒 false（缺省即不可加）
    const out = await runQuery(deps, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect('total' in out, '不可加指标不得凭空带 total 字段').toBe(false)
  })

  it('自动伴随：合计语义真库验证——totalSql 在夹具表上执行 = 明细 value 之和（明细照常返回）', async () => {
    // 与显式合计的真库验证同一条纪律：验的不只是「SQL 长得像」，而是合计语义真成立。
    const client = await pool.connect()
    try {
      await client.query('create temp table qp3_total_auto (org text, bizday date, v numeric)')
      await client.query(
        `insert into qp3_total_auto values
           ('org_a','2026-10-08',100),('org_a','2026-10-09',47.5),('org_b','2026-10-08',999)`)
      await upsertL1Metric(pool, {
        ...METRIC, id: L1_TOTAL_PREFIX + 'sem', title: '销售日明细·total_sem',
        selectSql: 'SELECT sum(v) AS value, org, bizday FROM qp3_total_auto',
        groupBy: 'org, bizday',
        sourceSystem: 'lemeng', totalable: true, slaDays: 1, freshnessRelations: [], masks: null,
      })
      let captured: string[] = []
      const rec: QueryDeps = {
        pool, adoptedSources: new Set(['lemeng']),
        execute: async (sql) => { captured.push(sql); return { columns: ['x'], rows: [[0]] } },
      }
      const out = await runQuery(rec, ORG, req(), L1_TOTAL_PREFIX + 'sem', {})
      expect(out.status).toBe('ok')
      if (out.status !== 'ok') return
      expect(captured.length).toBe(2)
      const [detailSql, totalSql] = captured
      expect(detailSql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
      expect(totalSql).not.toContain('LIMIT')
      // 真库上把两条计划都跑一遍：明细 2 行（org_b 被主体钉死挡掉），合计 = 100 + 47.5 = 147.5
      // （date 列经 node-pg 回 Date 对象，断言只认 value/org + 行集形状）
      // 行序：spec §10.3 起明细 SQL 带 ORDER BY bizday DESC——最新分区在前（10-09 的 47.5 先回）。
      const detail = await client.query(detailSql)
      const total = await client.query(totalSql)
      expect(detail.rows.map((r: { value: string; org: string }) => ({ value: r.value, org: r.org })))
        .toEqual([{ value: '47.5', org: 'org_a' }, { value: '100', org: 'org_a' }])
      expect(detail.rows.reduce((s: number, r: { value: string }) => s + Number(r.value), 0)).toBe(147.5)
      expect(total.rows).toEqual([{ total: '147.5' }])
    } finally {
      client.release()
    }
  })
})

// ── 新鲜度面（spec §10.2）：ok 响应附 data_as_of = load_log 最新 ok 的 materialized_at ──
// 仓库 = 同一份测试库（DATA_WAREHOUSE_URL 指它）：主查询走注入的假执行器（不验 SQL 真跑，
// 与上方用例同一口径），data_as_of 走**真仓库池**——生产里两者同池（pg_duckdb），测试里
// 各走各的通道，正好把「新鲜度查询不经 deps.execute 主计划缝」这条契约一并钉住。
describePg('runQuery —— data_as_of（spec §10.2，需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let planSqls: string[] = []
  const depsOf = (): QueryDeps => ({
    pool,
    adoptedSources: new Set<string>(),
    execute: async (sql) => {
      planSqls.push(sql)
      return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
    },
  })
  /** 仓库池（指向本测试库）+ load_log 生命周期。 */
  let wh: Pool

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await upsertMetric(pool, ORG, METRIC, 'fixture')
    // 仓库环境：env 先设、单例先清（惰性单例按 env 建）——本文件此前从未触发过 warehousePool()
    process.env.DATA_WAREHOUSE_URL = dbUrl
    resetWarehousePool()
    wh = warehousePool()
    planSqls = []
  })
  afterAll(async () => {
    // 还原世界：load_log 摘掉（同库还有别的测试文件——别留一张半满的账给别人）、
    // 仓库单例清掉、两条池都关（防 vitest 挂在 open handle 上）
    await wh.query('drop table if exists data.load_log').catch(() => {})
    resetWarehousePool()
    delete process.env.DATA_WAREHOUSE_URL
    await wh.end().catch(() => {})
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  const dropLog = () => wh.query('drop table if exists data.load_log')
  const createLog = () => wh.query(
    'create table data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text)')

  it('F1 表不存在 ⇒ ok 照常返回、data_as_of 字段缺席（缺账不反噬主查询）', async () => {
    await dropLog()
    const out = await runQuery(depsOf(), ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.rows).toEqual([['org_a', '2026-08-15']])
    expect('data_as_of' in out, '新鲜度未知 ≠ 捏造：表缺席就别带这个字段').toBe(false)
    // 新鲜度查询走真仓库池，**不**走主计划缝（假执行器只该见到计划 SQL 一条）
    expect(planSqls.length).toBe(1)
  })

  it('F2 表在但空 ⇒ data_as_of 缺席（max=NULL 不许捏成时间戳）', async () => {
    await dropLog()
    await createLog()
    const out = await runQuery(depsOf(), ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect('data_as_of' in out).toBe(false)
  })

  it('F3 有 ok 行 ⇒ data_as_of = 最新 ok 的 materialized_at（非 ok 行不计，哪怕更新），且是 Asia/Shanghai 确定性字符串（spec §10.6）', async () => {
    await dropLog()
    await createLog()
    await wh.query(
      `insert into data.load_log (materialized_at, tests_pass, tests_error, status) values
         ('2026-10-15 03:27:00+00', 26, 0, 'ok'),
         ('2026-10-16 03:27:00+00', 26, 0, 'ok'),
         ('2026-10-16 09:00:00+00', 0,  6,  'failed')`)
    const out = await runQuery(depsOf(), ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.data_as_of, '取 status=ok 的 max（failed 行更新也不算）').toBe('2026-10-16 11:27:00 +08:00')
  })

  it('F5 data_as_of 形状钉死：YYYY-MM-DD HH:mm:ss +08:00，UTC 午夜换算跨日不漂（spec §10.6，不教模型换算）', async () => {
    await dropLog()
    await createLog()
    // 16:00Z = 上海次日 00:00:00——同一锚点同时钉「+8 跨日」与「午夜渲染为 00 不是 24」
    await wh.query(
      `insert into data.load_log (materialized_at, tests_pass, tests_error, status)
       values ('2026-10-16 16:00:00+00', 26, 0, 'ok')`)
    const out = await runQuery(depsOf(), ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.data_as_of).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/)
    expect(out.data_as_of).toBe('2026-10-17 00:00:00 +08:00')
  })

  it('F4 显式合计模式同样附带 data_as_of（新鲜度与查询形态正交）', async () => {
    await dropLog()
    await createLog()
    await wh.query(
      `insert into data.load_log (materialized_at, tests_pass, tests_error, status)
       values ('2026-10-16 03:27:00+00', 26, 0, 'ok')`)
    const totalDeps: QueryDeps = {
      pool, adoptedSources: new Set(),
      execute: async (sql) => {
        planSqls.push(sql)
        return { columns: ['total'], rows: [[1470.5]] }
      },
    }
    const out = await runQuery(totalDeps, ORG, req(), 'sales_daily', { total: true })
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.total).toBe(1470.5)
    expect(out.data_as_of, '合计形态同样带北京时间字符串').toBe('2026-10-16 11:27:00 +08:00')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 新鲜度链路面（spec §10.7.3/§10.7.4）：watermark / freshness_status / freshness_line。
// 先钉**纯函数**（状态转译的算术判据 + 固定行模板——模板逐字是消费契约，模型原样附加），
// 再在真库上钉**编排**（min(max_bizday) 木桶短板、缺失链路字段缺席、old-shape 降级）。
// ════════════════════════════════════════════════════════════════════════════════════════
describe('freshnessStatusOf —— 水位 → 状态（spec §10.7.3：≤sla normal / ≤sla+2 late / 更早 alert）', () => {
  it('三态与边界恰判：d=sla normal；d=sla+1 与 d=sla+2 late；d=sla+3 alert；水位在未来 ⇒ normal', () => {
    // 今天 2026-10-16、sla=1：水位 10-15（d=1）normal；10-14（d=2）late；10-13（d=3）late；
    // 10-12（d=4）alert；水位 10-17（d=-1，未来/当天）normal。
    expect(freshnessStatusOf('2026-10-15', 1, '2026-10-16')).toBe('normal')
    expect(freshnessStatusOf('2026-10-14', 1, '2026-10-16')).toBe('late')
    expect(freshnessStatusOf('2026-10-13', 1, '2026-10-16')).toBe('late')
    expect(freshnessStatusOf('2026-10-12', 1, '2026-10-16')).toBe('alert')
    expect(freshnessStatusOf('2026-10-17', 1, '2026-10-16')).toBe('normal')
    // sla=2（inventory 的实测登记）：窗口整体右移两天
    expect(freshnessStatusOf('2026-10-14', 2, '2026-10-16')).toBe('normal')
    expect(freshnessStatusOf('2026-10-12', 2, '2026-10-16')).toBe('late')
    expect(freshnessStatusOf('2026-10-11', 2, '2026-10-16')).toBe('alert')
  })

  it('跨月/跨年不漂（日历差按日期算，不吃时区钟点）', () => {
    expect(freshnessStatusOf('2026-09-30', 1, '2026-10-01')).toBe('normal')
    expect(freshnessStatusOf('2026-09-28', 1, '2026-10-01')).toBe('late')
    expect(freshnessStatusOf('2025-12-31', 1, '2026-01-01')).toBe('normal')
    expect(freshnessStatusOf('2026-01-01', 1, '2026-01-05')).toBe('alert')
  })
})

describe('freshness_line 模板（spec §10.7.4 ec16eeb 订正版：业务大白话，行内零工程术语）', () => {
  it('四状态模板逐字；{d}=人话日期（M月D日），{t}=MM-DD HH:mm（北京）；today 注入（第 4 参）', () => {
    expect(freshnessLineOf('normal', '2026-10-15', new Date('2026-10-15T03:27:00Z'), '2026-10-16'))
      .toBe('📅 数据已更新至 10月15日（该日数据完整）｜更新于 10-15 11:27')
    expect(freshnessLineOf('late', '2026-10-14', new Date('2026-10-15T03:27:00Z'), '2026-10-16'))
      .toBe('📅 数据已更新至 10月14日，比平时慢了，还在处理中')
    expect(freshnessLineOf('alert', '2026-10-12', new Date('2026-10-15T03:27:00Z'), '2026-10-16'))
      .toBe('📅 数据更新停在 10月12日，可能有问题，我们正在检查')
    expect(freshnessLineOf('unknown', '2026-10-15', new Date('2026-10-15T03:27:00Z'), '2026-10-16'))
      .toBe('📅 数据更新情况未知')
  })

  it('★ 当日部分天变体（fix round 2）：watermark = 今天 ⇒ 「今日数据仍在累计中」；过去日 ⇒ 「该日数据完整」不变', () => {
    // 今天没过完（零售 tick 的当日分区是部分天），「该日数据完整」是错误陈述——
  // spec §10.4/§10.7.4 话术纪律：当日=部分天必须标注。状态判定不变（d=0 ≤ sla 恒 normal）。
    expect(freshnessLineOf('normal', '2026-10-16', new Date('2026-10-16T03:27:00Z'), '2026-10-16'))
      .toBe('📅 数据已更新至 10月16日（今日数据仍在累计中）｜更新于 10-16 11:27')
    // 过去日期逐字不变（回归面）
    expect(freshnessLineOf('normal', '2026-10-15', new Date('2026-10-16T03:27:00Z'), '2026-10-16'))
      .toBe('📅 数据已更新至 10月15日（该日数据完整）｜更新于 10-16 11:27')
  })

  it('行内禁工程术语（承诺/水位/物化/业务日/T+N 一律不许出现——ec16eeb 的硬约束）', () => {
    for (const line of [
      freshnessLineOf('normal', '2026-10-15', new Date('2026-10-15T03:27:00Z'), '2026-10-16'),
      freshnessLineOf('normal', '2026-10-16', new Date('2026-10-16T03:27:00Z'), '2026-10-16'),
      freshnessLineOf('late', '2026-10-14', new Date('2026-10-15T03:27:00Z'), '2026-10-16'),
      freshnessLineOf('alert', '2026-10-12', new Date('2026-10-15T03:27:00Z'), '2026-10-16'),
      freshnessLineOf('unknown', '2026-10-15', new Date('2026-10-15T03:27:00Z'), '2026-10-16'),
    ]) {
      for (const term of ['承诺', '水位', '物化', '业务日', 'T+', 'sla', 'SLA']) {
        expect(line.includes(term), `模板行出现了工程术语 ${term}：${line}`).toBe(false)
      }
    }
  })

  it('formatHumanDay：YYYY-MM-DD → M月D日（人话，不给 ISO；前导零按数字读法收敛）', () => {
    expect(formatHumanDay('2026-10-15')).toBe('10月15日')
    expect(formatHumanDay('2026-01-05')).toBe('1月5日')
  })

  it('freshnessRelationsOf：坏形状归一成安全关系集（非数组/混入非字符串 ⇒ 剔除；空 ⇒ 无自动水位）', () => {
    expect(freshnessRelationsOf({ freshnessRelations: ['stg_a', 'stg_b', 'stg_a'] })).toEqual(['stg_a', 'stg_b'])
    expect(freshnessRelationsOf({ freshnessRelations: null })).toEqual([])
    expect(freshnessRelationsOf({ freshnessRelations: undefined })).toEqual([])
    expect(freshnessRelationsOf({ freshnessRelations: ['stg_a', 42, '', 'stg_a'] as unknown as string[] }))
      .toEqual(['stg_a'])
  })
})

describePg('runQuery —— freshness_line（spec §10.7，需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  /** 夹具关系集（staging 表名的同构形状；水位行按它落）。 */
  const RELS = ['stg_fw_retail', 'stg_fw_expense']
  const planSqls: string[] = []
  const depsOf = (): QueryDeps => ({
    pool,
    // L1 夹具带源维度（lemeng）⇒ 必须「已接入」才可见（裁剪判据，与上游 describe 同理）
    adoptedSources: new Set<string>(['lemeng']),
    execute: async (sql) => {
      planSqls.push(sql)
      return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
    },
  })
  /** 测试基准「今天」（Asia/Shanghai）：与实现同一格式化通道，跨日不靠猜。 */
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  /** today - n 天的 YYYY-MM-DD（日历差，UTC 算术避免跨月/夏令时漂移）。 */
  const daysAgo = (n: number): string => {
    const [y, m, d] = today().split('-').map(Number)
    return new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) - n)).toISOString().slice(0, 10)
  }
  let wh: Pool
  /** L1 夹具（带新鲜度链路；id 走本文件既有平台桶前缀，afterAll 按前缀清）。 */
  const seedFreshMetric = async (over: { slaDays?: number | null; relations?: string[] } = {}) => {
    await upsertL1Metric(pool, {
      ...METRIC, id: `${L1_TOTAL_PREFIX}fresh`, title: '销售日明细·fresh', groupBy: 'bizday',
      selectSql: 'SELECT sum(v) AS value, bizday FROM qp3_fresh_face',
      sourceSystem: 'lemeng', totalable: false,
      slaDays: over.slaDays ?? 1,
      freshnessRelations: over.relations ?? RELS,
      masks: null,
    })
    if (over.slaDays === null) {
      await pool.query('update data.metrics set sla_days = null where org = $1 and id = $2',
        [L1_ORG, `${L1_TOTAL_PREFIX}fresh`])
    }
  }
  /** 新形状 load_log + 一组水位行（relation 行；materialized_at 默认固定锚 → 北京 10-15 11:27，
   *  `at` 可覆盖——只有「同一关系多行历史」的用例需要不同的物化时刻）。 */
  const seedWatermarks = async (
    rows: Array<{ relation: string; maxBizday: string; status?: string; at?: string }>,
  ) => {
    await wh.query('drop table if exists data.load_log')
    await wh.query(`create table data.load_log(
      materialized_at timestamptz default now(), tests_pass int, tests_error int, status text,
      relation text, max_bizday date)`)
    for (const r of rows) {
      await wh.query(
        `insert into data.load_log (materialized_at, tests_pass, tests_error, status, relation, max_bizday)
         values ($1, 26, 0, $2, $3, $4)`,
        [r.at ?? '2026-10-15 03:27:00+00', r.status ?? 'ok', r.relation, r.maxBizday],
      )
    }
  }

  // 时间冻结：夹具按「今天」推算水位，而整段跑几十秒；正好跨北京时间零点时 seed 与断言
  // 会各读一次壁钟（seed 23:59 / 断言 00:01）⇒ 基准差一天，测试假红（2026-11-10 main 实测）。
  // 只冻结 Date，不禁用定时器（pg 连接/超时仍要用真 setTimeout）。
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T03:27:00Z'))
  })
  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await upsertMetric(pool, ORG, METRIC, 'fixture')
    process.env.DATA_WAREHOUSE_URL = dbUrl
    resetWarehousePool()
    wh = warehousePool()
    planSqls.length = 0
  })
  afterAll(async () => {
    vi.useRealTimers()
    await wh.query('drop table if exists data.load_log').catch(() => {})
    resetWarehousePool()
    delete process.env.DATA_WAREHOUSE_URL
    await wh.end().catch(() => {})
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1 and id like $2',
      [L1_ORG, `${L1_TOTAL_PREFIX}%`]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('W1 无链路（L2 行）⇒ watermark/freshness_status/freshness_line 三字段全缺席，data_as_of 照常', async () => {
    await seedWatermarks([{ relation: 'stg_fw_retail', maxBizday: daysAgo(1) }])
    const out = await runQuery(depsOf(), ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect('watermark' in out).toBe(false)
    expect('freshness_status' in out).toBe(false)
    expect('freshness_line' in out).toBe(false)
    expect('data_as_of' in out, 'data_as_of 与链路面正交，照常在').toBe(true)
  })

  it('W2 两关系取 min(max_bizday)（木桶短板），normal 模板逐字（{d} 人话、{t} 北京钟点）', async () => {
    await seedFreshMetric()
    await seedWatermarks([
      { relation: 'stg_fw_retail', maxBizday: daysAgo(1) },
      { relation: 'stg_fw_expense', maxBizday: daysAgo(0) },
    ])
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.watermark, '短板 = 两关系里更旧的那个').toBe(daysAgo(1))
    expect(out.freshness_status, 'd=1 ≤ sla=1 ⇒ normal').toBe('normal')
    expect(out.freshness_line).toBe(`📅 数据已更新至 ${formatHumanDay(daysAgo(1))}（该日数据完整）｜更新于 10-15 11:27`)
  })

  it('W10 同一关系多行历史 ⇒ 取**最新那一行**的水位（issue #844：追加式日志不是状态表）', async () => {
    await seedFreshMetric()
    await seedWatermarks([
      // 早先几次物化时水位还很旧——旧实现的全历史 min(max_bizday) 会永远卡在这几行上
      { relation: 'stg_fw_retail', maxBizday: daysAgo(6), at: '2026-10-12 03:27:00+00' },
      { relation: 'stg_fw_retail', maxBizday: daysAgo(5), at: '2026-10-13 03:27:00+00' },
      { relation: 'stg_fw_retail', maxBizday: daysAgo(4), at: '2026-10-14 03:27:00+00' },
      // 最新一次物化：当前水位
      { relation: 'stg_fw_retail', maxBizday: daysAgo(1), at: '2026-10-15 03:27:00+00' },
    ])
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.watermark, '先按关系取最新一行，再跨关系取木桶 —— 不是全历史 min').toBe(daysAgo(1))
    expect(out.freshness_status, 'd=1 ≤ sla=1 ⇒ normal（旧实现会因历史行判成 alert）').toBe('normal')
  })

  it('W3 late（d=sla+2 仍 late）与 W4 alert（d=sla+3）模板逐字', async () => {
    await seedFreshMetric()
    await seedWatermarks([{ relation: 'stg_fw_retail', maxBizday: daysAgo(3) }])
    const late = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    if (late.status !== 'ok') throw new Error('late 用例失败')
    expect(late.freshness_status).toBe('late')
    expect(late.freshness_line).toBe(`📅 数据已更新至 ${formatHumanDay(daysAgo(3))}，比平时慢了，还在处理中`)

    await seedWatermarks([{ relation: 'stg_fw_retail', maxBizday: daysAgo(4) }])
    const alert = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    if (alert.status !== 'ok') throw new Error('alert 用例失败')
    expect(alert.freshness_status).toBe('alert')
    expect(alert.freshness_line).toBe(`📅 数据更新停在 ${formatHumanDay(daysAgo(4))}，可能有问题，我们正在检查`)
  })

  it('W5 normal 边界（水位恰 = 今天-sla）；failed 行不计入水位', async () => {
    await seedFreshMetric()
    await seedWatermarks([
      { relation: 'stg_fw_retail', maxBizday: daysAgo(1) },
      { relation: 'stg_fw_expense', maxBizday: daysAgo(1), status: 'failed' },
    ])
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    if (out.status !== 'ok') throw new Error('normal 边界用例失败')
    expect(out.freshness_status).toBe('normal')
  })

  it('W9 水位 = 今天（fix round 2）：normal 状态不变，固定行改口「今日数据仍在累计中」（当日=部分天）', async () => {
    // sla=2、水位=今天（d=0 ≤ sla）⇒ status normal；但今天没过完 ⇒ 括号内必须改口
    await seedFreshMetric({ slaDays: 2 })
    await seedWatermarks([{ relation: 'stg_fw_retail', maxBizday: daysAgo(0) }])
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    if (out.status !== 'ok') throw new Error('当日变体用例失败')
    expect(out.watermark).toBe(daysAgo(0))
    expect(out.freshness_status).toBe('normal')
    expect(out.freshness_line).toBe(`📅 数据已更新至 ${formatHumanDay(daysAgo(0))}（今日数据仍在累计中）｜更新于 10-15 11:27`)
    expect(out.freshness_line, '变体只换括号内短语').not.toContain('该日数据完整')
  })

  it('W6 有链路但水位缺失（load_log 无对应 relation 行）⇒ 三字段全缺席（未知 ≠ 捏造）', async () => {
    await seedFreshMetric()
    await wh.query('drop table if exists data.load_log')
    await wh.query(`create table data.load_log(
      materialized_at timestamptz default now(), tests_pass int, tests_error int, status text,
      relation text, max_bizday date)`)
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    if (out.status !== 'ok') throw new Error('缺失链路用例失败')
    expect('watermark' in out).toBe(false)
    expect('freshness_status' in out).toBe(false)
    expect('freshness_line' in out).toBe(false)
  })

  it('W7 旧形状 load_log（无 max_bizday 列，materialize 未升级）⇒ 查询失败被咽下，字段缺席且不反噬主查询', async () => {
    await seedFreshMetric()
    await wh.query('drop table if exists data.load_log')
    await wh.query('create table data.load_log(materialized_at timestamptz default now(), tests_pass int, tests_error int, status text)')
    await wh.query(`insert into data.load_log (materialized_at, tests_pass, tests_error, status)
      values ('2026-10-15 03:27:00+00', 26, 0, 'ok')`)
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect('watermark' in out).toBe(false)
    expect('freshness_line' in out).toBe(false)
    // 主计划照常（新鲜度查询绝不反噬），data_as_of 照常在
    expect(planSqls.length).toBe(1)
    expect('data_as_of' in out).toBe(true)
  })

  it('W8 有水位但 sla_days 缺（库内旧行 sync 未刷的理论态）⇒ unknown 模板（不捏造状态）', async () => {
    await seedFreshMetric({ slaDays: null })
    await seedWatermarks([{ relation: 'stg_fw_retail', maxBizday: daysAgo(1) }])
    const out = await runQuery(depsOf(), ORG, req(), `${L1_TOTAL_PREFIX}fresh`, {})
    if (out.status !== 'ok') throw new Error('unknown 用例失败')
    expect(out.freshness_status).toBe('unknown')
    expect(out.freshness_line).toBe('📅 数据更新情况未知')
  })
})

describe('runQuery —— 值级脱敏回包 masking（spec §5.3，P2 T2）', () => {
  const MASK_PREFIX = 't9q_mask:'
  /** 本块自己的捕获变量与连接（文件首块的 `pool`/`lastSql` 是它 describe 内的局部量，这里够不着）。 */
  let lastSql = ''
  const pool = new Pool({ connectionString: dbUrl })
  const MASK_ID = `${MASK_PREFIX}m`
  /** L1 夹具带掩码声明（真值只能走 upsertL1Metric；L2 写入面没有掩码概念）。 */
  const seedMasked = async (masks: MaskSpec[] | null) => {
    await upsertL1Metric(pool, {
      ...METRIC, id: MASK_ID, groupBy: 'bizday',
      selectSql: 'SELECT sum(qp3_mask_f.revenue) AS value, bizday FROM qp3_mask_f',
      sourceSystem: 'lemeng', totalable: true, slaDays: 1, freshnessRelations: [],
      masks,
    })
  }
  const depsOf = (): QueryDeps => ({
    pool,
    // L1 夹具带源维度（lemeng）⇒ 必须「已接入」才可见（与上游 W 块同理）
    adoptedSources: new Set<string>(['lemeng']),
    execute: async (sql) => {
      lastSql = sql
      return { columns: ['value', 'bizday'], rows: [[1234, '2026-08-15']] }
    },
  })

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${MASK_PREFIX}%`])
    // L2 夹具落在本 org（`upsertMetric`）——同样按前缀清，别碰别人的行
    await pool.query('delete from data.metrics where org = $1 and id like $2', [ORG, `${MASK_PREFIX}%`])
    lastSql = ''
  })
  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${MASK_PREFIX}%`]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1 and id like $2', [ORG, `${MASK_PREFIX}%`]).catch(() => {})
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('无豁免码 ⇒ 回包带 masking（列 → 记号），且执行层拿到的 SQL 真被掩了', async () => {
    await seedMasked([{ column: 'qp3_mask_f.revenue', kind: 'round', step: 1000, grantedBy: 'data:precise' }])
    const out = await runQuery(depsOf(), ORG, req(), MASK_ID, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.masking).toEqual({ 'qp3_mask_f.revenue': 'round:1000' })
    expect(lastSql, '掩码在授权层展开，执行层拿到的是已掩 SQL').toContain('sum(round(qp3_mask_f.revenue, -1000))')
  })

  it('持有豁免码 ⇒ masking 键不出现（缺席 = 原值，与 total?/freshness_*? 同风格）', async () => {
    await seedMasked([{ column: 'qp3_mask_f.revenue', kind: 'round', step: 1000, grantedBy: 'data:precise' }])
    const out = await runQuery(depsOf(), ORG, req({ scopes: ['data:query', 'data:precise'] }), MASK_ID, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect('masking' in out).toBe(false)
  })

  it('未声明掩码 ⇒ masking 键不出现', async () => {
    await seedMasked(null)
    const out = await runQuery(depsOf(), ORG, req(), MASK_ID, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect('masking' in out).toBe(false)
  })

  // 审计列（P2 T3，spec §4.4）：回包说没说实话是一回事，**留痕**是另一回事——审计必须能
  // 回答「这个人看到的是原值还是掩码值」。两条用例钉住 null 与对象的**两态**（'{}' 不许出现）。
  it('掩码生效 ⇒ 审计行 masking 落库（列 → 记号），与回包同一份 applied', async () => {
    await seedMasked([{ column: 'qp3_mask_f.revenue', kind: 'round', step: 1000, grantedBy: 'data:precise' }])
    const out = await runQuery(depsOf(), ORG, req(), MASK_ID, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    // ★ 标题声称「与回包同一份 applied」就必须真比一次回包（T3-①，issue #824）：同源今日成立，
    //   但将来回包改道（例如另拼一份）不会红——除非这里比的是**回包那个字段**本身。
    expect(out.masking).toEqual({ 'qp3_mask_f.revenue': 'round:1000' })
    const r = await pool.query('select masking from data.query_audit where org = $1', [ORG])
    expect(r.rowCount).toBe(1)
    expect(r.rows[0].masking).toEqual({ 'qp3_mask_f.revenue': 'round:1000' })
  })

  // ★ 整值掩码（column=null）的**端到端**用例（T2-m4，issue #824）：此前整值路径只有纯函数级
  //   覆盖（mask.test.ts），接线层（authorize → runQuery）整体直传、风险低，但整值路径是
  //   「把 `… as value` 整段换成 typed NULL」——有人改拼接逻辑时，纯函数用例照绿而线上走偏。
  it('★ 整值掩码端到端：回包 masking 键是 `<value>`，执行层拿到的 SQL 整个值被换掉（T2-m4）', async () => {
    await seedMasked([{ column: null, kind: 'nullify', grantedBy: 'data:precise' }])
    const out = await runQuery(depsOf(), ORG, req(), MASK_ID, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.masking).toEqual({ '<value>': 'nullify' })
    expect(lastSql, '整值掩码把 `… as value` 的表达式整段换掉').toContain('cast(null as numeric) as value')
    expect(lastSql, '原列引用必须一个都不剩').not.toContain('qp3_mask_f.revenue')
  })

  it('无掩码生效 ⇒ 审计 masking 是 NULL（不是空对象 {}，与 row_count null≠0 同一把尺）', async () => {
    await seedMasked(null)
    const out = await runQuery(depsOf(), ORG, req(), MASK_ID, {})
    expect(out.status).toBe('ok')
    const r = await pool.query('select masking from data.query_audit where org = $1', [ORG])
    expect(r.rowCount).toBe(1)
    expect(r.rows[0].masking).toBeNull()
  })

  // ★ 端到端：L2 指标 + L1 带掩码 ⇒ 回包 masking **非空**（#820 路线 C）。改按列解析之前，
  //   L2 行 masks 恒 null ⇒ 只读本行 ⇒ masking 恒空（fail-open 洞）；L2 的 selectSql 逐字保留
  //   L1 的列引用 ⇒ 全量 catalog 按列解析后自动命中。
  //
  // ★★ 掩码只声明在**被裁掉**的 L1 行上（review fix round）：`sourceSystem: 'not_adopted'` 不在
  //    `depsOf()` 的 adoptedSources（`{'lemeng'}`）里 ⇒ visibleMetrics 把它从 `catalog` 裁掉，
  //    它**只**存在于 `allMetrics`。这样本用例才**鉴别** `query-service.ts` 传的是全量——
  //    若把第 5 参改回传 `catalog`（裁剪过的），掩码集为空 ⇒ masking 键缺席 ⇒ 本用例必红。
  //    （用 block 里的 `seedMasked`（sourceSystem 'lemeng'、可见）会因「裁剪后也在 catalog 里」
  //     而对这条接线**变异不可见**——正是「断言没走到它声称的那一行」那条教训。）
  //    ⚠️ 第 5 参现为**必填**（2026-10-18）：「漏传」已是编译错误；这一条防的是**传错那一份**。
  it('★ L2 指标：掩码只在**被裁掉**的 L1 行上 ⇒ 回包 masking 仍非空（证明传的是全量 catalog，#820）', async () => {
    // L1 行：源不在 adoptedSources ⇒ 被 visibleMetrics 裁掉，只留 allMetrics。
    // ⚠️ 不复用 seedMasked（它的 'lemeng' 是可见的，其余用例需要它可见）。
    const TRIMMED_L1 = `${MASK_PREFIX}l1_trimmed`
    await upsertL1Metric(pool, {
      ...METRIC, id: TRIMMED_L1, groupBy: 'bizday',
      selectSql: 'SELECT sum(qp3_mask_f.revenue) AS value, bizday FROM qp3_mask_f',
      sourceSystem: 'not_adopted', totalable: true, slaDays: 1, freshnessRelations: [],
      masks: [{ column: 'qp3_mask_f.revenue', kind: 'round', step: 1000, grantedBy: 'data:precise' }],
    })
    // L2 行（本 org）：masks 恒 null；selectSql 逐字复用 L1 的列引用（L2 编译原样保留，实测）
    const L2_ID = `${MASK_PREFIX}l2`
    await upsertMetric(pool, ORG, {
      ...METRIC, id: L2_ID, groupBy: 'bizday',
      selectSql: 'SELECT sum(qp3_mask_f.revenue) AS value, bizday FROM dbt.qp3_mask_f',
    }, 'fixture')

    const out = await runQuery(depsOf(), ORG, req(), L2_ID, {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    // 掩码来源行对调用方**不可见**，但掩码仍生效 —— fail-closed（掩码只减信息）
    expect(out.masking).toEqual({ 'qp3_mask_f.revenue': 'round:1000' })
    expect(lastSql, '按列解析 ⇒ L2 也拿到 L1 的掩码（掩在聚合内部）')
      .toContain('sum(round(qp3_mask_f.revenue, -1000))')
  })
})

// ══ 分析师面接线（spec 2026-10-21：tool/warehouseExec/slicing 透传，audit id 回传）══════
describe('runQuery 分析师面接线', () => {
  // 假平台池：词表查询回两行夹具（普通 + totalable 切片样例）；其余 SQL（审计 insert 等）
  // 回固定 {id, created_at}——与真机形状一致（scripts/e2e 的 #51 教训：mock 收严到真机形状）。
  const catalogPool = (auditId: number) => ({
    query: async (sql: string) => sql.includes('from data.metrics')
      ? { rows: [
          {
            id: 'sales_daily', title: '销售日明细', description: '', required_scope: null,
            subject_column: 'org', select_sql: 'SELECT org, day FROM marts.sales_daily',
            group_by: '', params: {}, source: 'l2', source_system: null, updated_by: null,
            version: 1, totalable: false, scope_note: '', sla_days: null, freshness_relations: null, mask_spec: null,
          },
          {
            id: 'm_totalable', title: '可加样例', description: '', required_scope: null,
            subject_column: 'org', select_sql: 'select org, day, sum(v) as value from fct group by org, day',
            group_by: 'org, day', params: {}, source: 'l2', source_system: null, updated_by: null,
            version: 1, totalable: true, scope_note: '', sla_days: null, freshness_relations: null, mask_spec: null,
          },
        ] }
      : { rows: [{ id: auditId, created_at: new Date('2026-10-21T10:00:00Z') }] },
  }) as never
  const emptyWh = async () => ({ columns: [], rows: [] })

  it('warehouseExec 承接辅助读（data_as_of/水位/维度解析不再直连 warehousePool）', async () => {
    const seen: string[] = []
    const main: SqlExecutor = async (sql) => {
      seen.push(`main:${sql.slice(0, 20)}`)
      return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
    }
    const wh: SqlExecutor = async (sql) => {
      seen.push(`wh:${sql.slice(0, 24)}`)
      if (sql.includes('load_log')) return { columns: ['data_as_of'], rows: [[new Date('2026-10-21T02:10:00+08:00')]] }
      return { columns: [], rows: [] }
    }
    const out = await runQuery(
      { pool: catalogPool(1), execute: main, warehouseExec: wh, adoptedSources: new Set<string>(), raceRetryDelayMs: 0 },
      'org_a', req(), 'sales_daily', {},
    )
    expect(out.status).toBe('ok')
    expect(seen.some((s) => s.startsWith('wh:'))).toBe(true)   // 辅助读走了注入的 wh
  })

  it('tool 透传进审计；QueryOk.audit 带 id/北京时间 ts；ok 带 sql', async () => {
    const inserts: { sql: string; values: unknown[] }[] = []
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        inserts.push({ sql, values: values ?? [] })
        if (sql.includes('from data.metrics')) return (catalogPool(501) as { query: (s: string) => unknown }).query(sql)
        return { rows: [{ id: 501, created_at: new Date('2026-10-21T10:00:00Z') }] }
      },
    } as never
    const out = await runQuery(
      {
        pool, execute: async () => ({ columns: ['org'], rows: [['org_a']] }),
        warehouseExec: emptyWh,
        adoptedSources: new Set<string>(), tool: 'query_metric', raceRetryDelayMs: 0,
      },
      'org_a', req(), 'sales_daily', {},
    )
    expect(out.status).toBe('ok')
    if (out.status === 'ok') {
      expect(out.audit).toMatchObject({ id: 501, ts: '2026-10-21T18:00:00+08:00' })
      expect(typeof out.sql).toBe('string')
    }
    const auditCall = inserts.find((c) => c.sql.includes('insert into data.query_audit'))
    expect(auditCall?.sql).toContain(', tool')
    expect(auditCall?.sql).toContain('session_id')
    // 052 起 duration_ms 追加在末尾：$16；其前是 $14 scope_plan / $15 scope_denial
    // （本用例未开 scope ⇒ 双 NULL；耗时是数字，旧断言的位置要跟着挪）。
    expect(auditCall?.sql).toContain('scope_plan')
    expect(auditCall?.values?.at(-2)).toBeNull()   // scope_denial
    expect(auditCall?.values?.at(-3)).toBeNull()   // scope_plan
    expect(typeof auditCall?.values?.at(-1)).toBe('number')   // duration_ms
    // 会话键（$13，非企微通道 null）与工具名（$12）都在 scope 两列之前
    expect(auditCall?.values?.at(-4)).toBeNull()          // session_id
    expect(auditCall?.values?.at(-5)).toBe('query_metric') // tool
  })

  it('slicing 透传 authorize（切片 SQL 生效）', async () => {
    let executed = ''
    const out = await runQuery(
      {
        pool: catalogPool(1), execute: async (sql) => { executed = sql; return { columns: ['org'], rows: [['org_a']] } },
        warehouseExec: emptyWh,
        adoptedSources: new Set<string>(), raceRetryDelayMs: 0,
      },
      'org_a', req(), 'm_totalable', {}, { dimensions: ['org'] },
    )
    expect(out.status).toBe('ok')
    expect(executed).toContain('sum(value) as value')
  })
})

// ── freshnessFaceFor（spec 2026-11-01 §10.4.2 移动徽标读侧）· 纯逻辑 · 假池注入 ──
// 真表（data.load_log）被并行兄弟测试文件反复 drop/create（它们各自的夹具语义），路由级
// 碰它会竞态——故状态映射/分组/fail-open 全部在假池上钉，路由级只钉「仓库未配 ⇒ 缺席」。
describe('freshnessFaceFor（纯逻辑 · 无需库）', () => {
  const TODAY = '2026-11-02'
  type Face = { status: string; watermark: string | null }

  /** 假池：按「SQL 里的首个关系名」回水位；未登记的关系集回空集（= 无水位）；throwRel 抛错。 */
  function fakePool(byRelation: Record<string, string>, throwRel?: string) {
    const calls: string[] = []
    return {
      calls,
      query: async (sql: string) => {
        calls.push(sql)
        const rel = /relation in \('([^']+)'/.exec(sql)?.[1] ?? ''
        if (rel === throwRel) throw new Error('load_log exploded')
        const wm = byRelation[rel]
        return { rows: wm === undefined ? [] : [{ watermark: wm }] }
      },
    }
  }
  const row = (id: string, slaDays: number | null, freshnessRelations: string[] | null) =>
    ({ id, slaDays, freshnessRelations })

  it('状态映射：SLA 内 normal；超 1-2 天 late；更早 alert（与 freshnessStatusOf 同判据）', async () => {
    const pool = fakePool({ r1: '2026-11-01', r2: '2026-10-30', r3: '2026-10-20' })
    const out = await freshnessFaceFor(pool, [
      row('a', 2, ['r1']),   // 差 1 天 ≤ sla 2 ⇒ normal
      row('b', 2, ['r2']),   // 差 3 天 = sla 2 + 1 ⇒ late
      row('c', 2, ['r3']),   // 差 13 天 ⇒ alert
    ], TODAY)
    expect(out.get('a')).toEqual({ status: 'normal', watermark: '2026-11-01' })
    expect(out.get('b')).toEqual({ status: 'late', watermark: '2026-10-30' })
    expect(out.get('c')).toEqual({ status: 'alert', watermark: '2026-10-20' })
  })

  it('sla 缺席 / 关系集空 ⇒ unknown 且不发 SQL（L2 行恒此形态，零查询开销）', async () => {
    const pool = fakePool({})
    const out = await freshnessFaceFor(pool, [
      row('l2a', null, ['r1']),
      row('l2b', 3, []),
      row('l2c', 3, null),
    ], TODAY)
    for (const id of ['l2a', 'l2b', 'l2c']) expect(out.get(id)).toEqual({ status: 'unknown', watermark: null })
    expect(pool.calls).toHaveLength(0)
  })

  it('同关系集共享一次水位查询（分组 = distinct 集数）；同集不同 sla 各算各的状态', async () => {
    const pool = fakePool({ r1: '2026-10-30' })
    const out = await freshnessFaceFor(pool, [
      row('x', 2, ['r1', 'r9']),   // 集合 {r1,r9}
      row('y', 30, ['r9', 'r1']),  // 同集（顺序无关）
      row('z', 2, ['r1']),         // 不同集 ⇒ 另一次查询
    ], TODAY)
    expect(pool.calls).toHaveLength(2)
    // 水位 10-30：x（sla 2）差 3 天 ⇒ late；y（sla 30）⇒ normal；z 另一次查询同水位同 sla ⇒ late
    expect(out.get('x')).toEqual({ status: 'late', watermark: '2026-10-30' })
    expect(out.get('y')).toEqual({ status: 'normal', watermark: '2026-10-30' })
    expect(out.get('z')).toEqual({ status: 'late', watermark: '2026-10-30' })
  })

  it('fail-open：水位查询抛错 / 水位形状坏 ⇒ unknown，不外抛（词表不因徽标面坏）', async () => {
    const boom = fakePool({}, 'bad_rel')
    const out1 = await freshnessFaceFor(boom, [row('a', 2, ['bad_rel'])], TODAY)
    expect(out1.get('a')).toEqual({ status: 'unknown', watermark: null })
    const ugly = fakePool({ r1: 'not-a-date' })
    const out2 = await freshnessFaceFor(ugly, [row('a', 2, ['r1'])], TODAY)
    expect(out2.get('a')).toEqual({ status: 'unknown', watermark: null })
  })
})

/**
 * 数据范围 **enforce 端到端**（spec 2026-11-10 §5；issue #1901）。
 *
 * 为什么单列：`buildScopePlan` 的纯函数单测只证明「算得对」，不证明「接线接上了」——
 * 这里用真库（scope/assignment 表）跑 `runQuery`，断言最终交给执行器的 SQL 真带 filter、
 * 无 scope 真被拒、审计真落 scope_plan。切 enforce 前这是唯一能证明端到端的那一层。
 */
describePg('runQuery —— 数据范围 enforce/shadow（端到端）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const SCOPE_METRIC = {
    id: 'scope_e2e', title: '范围端到端', description: '',
    requiredScope: 'data:query', subjectColumn: 'org',
    selectSql: 'SELECT org, system_book, branch_num, bizday, sum(value) AS value FROM marts.f',
    groupBy: 'system_book, branch_num, bizday', params: {},
  }
  let lastSql = ''
  const deps: QueryDeps = {
    pool,
    adoptedSources: new Set<string>(),
    execute: async (sql) => {
      lastSql = sql
      return { columns: ['system_book', 'branch_num', 'bizday', 'value'], rows: [['3120', 101, '2026-11-10', 1]] }
    },
  }

  /** 给某主体挂 scope（kind/selector）；返回 scope id 供清理。 */
  async function assign(subjectId: string, kind: string, selector: unknown, subjectType = 'user'): Promise<number> {
    const r = await pool.query(
      `insert into data.scope(org, name, kind, selector) values ($1, $2, $3, $4::jsonb) returning id`,
      [ORG, `${kind}|e2e|${subjectId}|${Math.random().toString(36).slice(2, 8)}`, kind, JSON.stringify(selector)],
    )
    const id = Number(r.rows[0].id)
    await pool.query(
      `insert into data.scope_assignment(org, subject_type, subject_id, scope_id) values ($1, $2, $3, $4)`,
      [ORG, subjectType, subjectId, id],
    )
    return id
  }

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.scope where org = $1', [ORG])   // assignment 随 cascade
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await upsertMetric(pool, ORG, SCOPE_METRIC, 'fixture')
    lastSql = ''
  })
  afterEach(() => { delete process.env.DATA_SCOPE_MODE })
  afterAll(async () => {
    await pool.query('delete from data.scope where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ enforce：有 brand+store scope ⇒ SQL 带复合键谓词，审计落 scope_plan', async () => {
    process.env.DATA_SCOPE_MODE = 'enforce'
    await assign('alice', 'brand', { system_book: ['3120'] })
    await assign('alice', 'store', { region_name: ['东部一区'] })
    await assign('alice', 'category', { all: true })   // 迁移给每个业务用户的兜底（品类不裁）

    const out = await runQuery(deps, ORG, req(), 'scope_e2e', {})
    expect(out.status).toBe('ok')
    expect(lastSql).toContain("AND system_book IN ('3120')")
    expect(lastSql).toContain('(system_book, branch_num) IN (')
    expect(lastSql).toContain("region_name IN ('东部一区')")
    // 谓词必须在 GROUP BY 之前（拼到后面 = SQL 语法错）
    expect(lastSql.indexOf('AND system_book IN')).toBeLessThan(lastSql.indexOf('GROUP BY'))

    const a = await pool.query(
      `select scope_plan, scope_denial from data.query_audit where org = $1 order by id desc limit 1`, [ORG],
    )
    expect(a.rows[0].scope_denial).toBeNull()
    expect(a.rows[0].scope_plan).toMatchObject({
      mode: 'enforce', applied: ['brand', 'store', 'category'], denial: null,
    })
  })

  it('★ enforce：只有品牌、没有门店 scope ⇒ 拒绝（D2），执行器一次都不跑，审计带 scope_denial', async () => {
    process.env.DATA_SCOPE_MODE = 'enforce'
    await assign('alice', 'brand', { system_book: ['3120'] })

    const out = await runQuery(deps, ORG, req(), 'scope_e2e', {})
    expect(out).toMatchObject({ status: 'denied', reason: 'range_denied', detail: 'no_store_scope' })
    expect(lastSql).toBe('')   // 没有拼出任何 SQL

    const a = await pool.query(
      `select verdict, reason, scope_plan, scope_denial from data.query_audit where org = $1 order by id desc limit 1`, [ORG],
    )
    expect(a.rows[0]).toMatchObject({ verdict: 'denied', reason: 'range_denied', scope_denial: 'no_store_scope' })
    expect(a.rows[0].scope_plan).toMatchObject({ mode: 'enforce', denial: 'no_store_scope' })
  })

  it('★ shadow：同样的用户不拒、SQL 不带范围谓词，但审计记下「本来会拒」', async () => {
    process.env.DATA_SCOPE_MODE = 'shadow'
    await assign('alice', 'brand', { system_book: ['3120'] })

    const out = await runQuery(deps, ORG, req(), 'scope_e2e', {})
    expect(out.status).toBe('ok')
    expect(lastSql).not.toContain("system_book IN ('3120')")

    const a = await pool.query(
      `select scope_plan, scope_denial from data.query_audit where org = $1 order by id desc limit 1`, [ORG],
    )
    expect(a.rows[0].scope_plan).toMatchObject({ mode: 'shadow', denial: 'no_store_scope' })
    expect(a.rows[0].scope_denial).toBe('no_store_scope')
  })

  it('管理员（data:manage）即便无任何 scope 也不裁、不拒', async () => {
    process.env.DATA_SCOPE_MODE = 'enforce'
    const out = await runQuery(deps, ORG, req({ scopes: ['data:query', 'data:manage'] }), 'scope_e2e', {})
    expect(out.status).toBe('ok')
    expect(lastSql).not.toContain('system_book IN')
    const a = await pool.query(
      `select scope_plan from data.query_audit where org = $1 order by id desc limit 1`, [ORG],
    )
    expect(a.rows[0].scope_plan).toMatchObject({ mode: 'enforce', applied: [], denial: null })
  })
})

// ── P2 Task 4：六面接线（部门可见性）——query 面代表用例 ─────────────────────────────
// 夹具树沿用 metric-visibility.test.ts 的种法（platform.org_node/org_membership 底层真表）；
// 归属列写侧暂无 API 面（P1 只建列），按任务书口径对夹具行直改库设 owner_dept / visible_depts。
// 独立 org（org-p2-vis-q）+ 独立合成租户（9307）隔离，afterAll 清场。
describePg('runQuery × 部门可见性（P2 Task 4）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ORG_V = 'org-p2-vis-q'
  const TENANT_V = 9307 // metric-visibility.test.ts 用 9207、reports 用 9107——错开
  const ROOT = 'org-p2-vis-q-root'
  const CHILD = 'org-p2-vis-q-child'
  const SIB = 'org-p2-vis-q-sib'
  const U_CHILD = 'org-p2-vis-q-u-child' // 直属 child
  const U_SIB = 'org-p2-vis-q-u-sib' // 直属 sib（child 的兄弟部门）

  const OWNED = {
    id: 'p2_vis_owned_daily', title: '部门归属指标', description: '',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.p2_vis_owned', groupBy: '', params: {},
  }
  const PLAIN = {
    id: 'p2_vis_plain_daily', title: '平台通用指标', description: '',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.p2_vis_plain', groupBy: '', params: {},
  }
  const SHARED = {
    id: 'p2_vis_shared_daily', title: '显式共享指标', description: '',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.p2_vis_shared', groupBy: '', params: {},
  }

  let lastSql = ''
  const deps = (): QueryDeps => ({
    pool,
    adoptedSources: new Set<string>(), // 夹具全是 L2 行（sourceSystem null）⇒ 源维度不裁
    execute: async (sql) => { lastSql = sql; return { columns: ['org', 'day'], rows: [['org-p2-vis-q', '2026-11-13']] } },
  })
  const reqOf = (over: Partial<Requester> = {}): Requester => {
    const scopes = ['data:query']
    return {
      userId: 'p2-vis-viewer', orgId: ORG_V, channel: 'session', keyId: null, scopes,
      hasScope: (c) => scopes.includes(c), ...over,
    }
  }

  beforeAll(async () => {
    await applyMigrations(pool)
    await applyPlatformMigrations(pool) // org 视图 / platform.tenant（单测无宿主，自己拉）
    await pool.query(
      'insert into platform.tenant(id, slug, casdoor_org) values ($1, $2, $3) on conflict (id) do nothing',
      [TENANT_V, 'org-p2-vis-q-fixture', ORG_V],
    )
    // 上一次跑挂残留也幂等：先清本租户再种
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT_V])
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT_V])
    const insDept = async (extId: string, parent: string | null, path: string) => {
      await pool.query(
        `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
         values ($1, $2, $3, $4, $5, 1)
         on conflict (tenant_id, ext_id) do update set parent_ext_id = excluded.parent_ext_id, path = excluded.path, status = 1`,
        [TENANT_V, extId, extId, parent, path],
      )
    }
    await insDept(ROOT, null, ROOT)
    await insDept(CHILD, ROOT, `${ROOT}.${CHILD}`)
    await insDept(SIB, null, SIB)
    const insMember = async (userName: string, extId: string) => {
      await pool.query(
        'insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary) values ($1, $2, $3, true) on conflict do nothing',
        [TENANT_V, userName, extId],
      )
    }
    await insMember(U_CHILD, CHILD)
    await insMember(U_SIB, SIB)

    await pool.query('delete from data.metrics where org = $1', [ORG_V])
    await upsertMetric(pool, ORG_V, OWNED, 'fixture')
    await upsertMetric(pool, ORG_V, PLAIN, 'fixture')
    await upsertMetric(pool, ORG_V, SHARED, 'fixture')
    // 写侧暂无归属 API 面（P1 只建列）：夹具直改库——owned 归 child；shared 归 sib、显式共享给 child
    await pool.query('update data.metrics set owner_dept = $1 where org = $2 and id = $3', [CHILD, ORG_V, OWNED.id])
    await pool.query('update data.metrics set owner_dept = $1, visible_depts = $2 where org = $3 and id = $4',
      [SIB, [CHILD], ORG_V, SHARED.id])
  })

  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG_V]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG_V]).catch(() => {})
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT_V]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT_V]).catch(() => {})
    await pool.query('delete from platform.tenant where id = $1', [TENANT_V]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('链上观看者（直属 child）：owned 指标查询 ok', async () => {
    const out = await runQuery(deps(), ORG_V,
      reqOf({ userId: U_CHILD, accountName: U_CHILD, tenantId: TENANT_V }), OWNED.id, {})
    expect(out.status).toBe('ok')
  })

  it('兄弟观看者（直属 sib）：owned 指标 **不可见**＝未声明（no-probe），不触仓库', async () => {
    lastSql = ''
    const out = await runQuery(deps(), ORG_V,
      reqOf({ userId: U_SIB, accountName: U_SIB, tenantId: TENANT_V }), OWNED.id, {})
    expect(out).toEqual({ status: 'denied', metricId: OWNED.id, reason: 'metric_not_declared' })
    expect(lastSql).toBe('') // 看不见 ⇒ 连 SQL 都没编译执行（404-no-probe 契约，不是报错）
  })

  it('回归锁：平台桶指标（owner_dept 空）对兄弟观看者**照常可见**', async () => {
    const out = await runQuery(deps(), ORG_V,
      reqOf({ userId: U_SIB, accountName: U_SIB, tenantId: TENANT_V }), PLAIN.id, {})
    expect(out.status).toBe('ok')
  })

  it('visible_depts 显式共享命中**直属**部门 ⇒ 兄弟部门开门（child 看到 sib 归属的指标）', async () => {
    const out = await runQuery(deps(), ORG_V,
      reqOf({ userId: U_CHILD, accountName: U_CHILD, tenantId: TENANT_V }), SHARED.id, {})
    expect(out.status).toBe('ok')
  })

  it('org 表无此人（无部门上下文）⇒ owned 不可见（fail-closed）', async () => {
    lastSql = ''
    const out = await runQuery(deps(), ORG_V,
      reqOf({ userId: 'org-p2-vis-q-ghost', tenantId: TENANT_V }), OWNED.id, {})
    expect(out).toEqual({ status: 'denied', metricId: OWNED.id, reason: 'metric_not_declared' })
    expect(lastSql).toBe('') // 同一 no-probe 契约：无上下文也按「看不见＝未声明」收口，不触仓库
  })

  it('requester 无 tenantId（租户数字 id 缺位）⇒ owned 不可见（fail-closed，宁少勿错）', async () => {
    // 部门名认识（accountName = U_CHILD）但没有 tenantId 就无从查 org 表 ⇒ 按「无 ctx」收口
    lastSql = ''
    const out = await runQuery(deps(), ORG_V,
      reqOf({ userId: U_CHILD, accountName: U_CHILD }), OWNED.id, {})
    expect(out).toEqual({ status: 'denied', metricId: OWNED.id, reason: 'metric_not_declared' })
    expect(lastSql).toBe('') // 同一 no-probe 契约：拒绝发生在授权层，SQL 从未编译执行
  })

  it('告警面钉死（P2 终审修复）：无 tenantId 的 fail-closed 收口必须记 metric_dept_ctx_unresolved warn', async () => {
    // structured warn 是这条错配态（配了归属但观看通道没带租户 id）的唯一观测面——没它
    // fail-closed 静默吞掉可见性。spy + finally 还原，不向同 worker 其他文件泄漏。
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = await runQuery(deps(), ORG_V,
        reqOf({ userId: U_CHILD, accountName: U_CHILD }), OWNED.id, {})
      expect(out).toEqual({ status: 'denied', metricId: OWNED.id, reason: 'metric_not_declared' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]![0])).toContain('metric_dept_ctx_unresolved')
    } finally {
      spy.mockRestore()
    }
  })
})
