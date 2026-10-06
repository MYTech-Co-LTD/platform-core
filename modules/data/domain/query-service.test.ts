import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runQuery, type QueryDeps } from './query-service'
import { upsertMetric } from './metric-store'
import { applyMigrations } from '../test-util'
import type { Requester } from './authz'
import { DATA_WAREHOUSE_UNCONFIGURED } from './warehouse'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = Casdoor org）。**与 `req()` 的 `orgId` 同值**——生产上两者就是同一个值
 *  （隔离键取宿主注入的 `identity.orgId`，主体值取 `Requester.orgId`，同一租户同一 org），
 *  测试里让它们相等才不至于验一个现实中不存在的状态。 */
const ORG = 'org_a'

/** #452 真机形态（2026-10-06 run jrun_dtyVWZnnFaQ_pCCN 实测原文的形状，值部分换短例）。
 *  判据窄匹配只认「ETag on reading file」——测试钉的是形状，不是整句。 */
const RACE_MSG =
  'HTTP Error: ETag on reading file "s3://shanhai-data/lemeng/retail_order_line/system_book=3120/bizday=2026-10-06/hour=10/all.parquet" was initially "a" and now it returned "b", this likely means the remote file has changed.'

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
    await upsertMetric(pool, ORG, METRIC)
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
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
    const out = await runQuery(flaky, ORG, req(), 'sales_daily', {})
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

  it('race：非 ETag 错误不重试（calls=1）→ 原样 warehouse_error（窄匹配的回归护栏）', async () => {
    let calls = 0
    const bad: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,
      execute: async () => { calls++; throw new Error('boom') },
    }
    const out = await runQuery(bad, ORG, req(), 'sales_daily', {})
    expect(calls).toBe(1)
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_error')
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
})
