import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runQuery, type QueryDeps } from './query-service'
import { L1_ORG, upsertL1Metric, upsertMetric } from './metric-store'
import { applyMigrations } from '../test-util'
import { MAX_QUERY_ROWS, type Requester } from './authz'
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
        ...METRIC, id: 'sales_total_fixture',
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
      ...METRIC, id: L1_TOTAL_PREFIX + 'auto',
      selectSql: 'SELECT sum(v) AS value, org, bizday FROM qp3_total_auto',
      groupBy: 'org, bizday',
      sourceSystem: 'lemeng', totalable: true, slaDays: 1, freshnessRelations: [],
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
        ...METRIC, id: L1_TOTAL_PREFIX + 'sem',
        selectSql: 'SELECT sum(v) AS value, org, bizday FROM qp3_total_auto',
        groupBy: 'org, bizday',
        sourceSystem: 'lemeng', totalable: true, slaDays: 1, freshnessRelations: [],
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
