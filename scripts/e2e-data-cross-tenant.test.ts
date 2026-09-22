// scripts/e2e-data-cross-tenant.test.ts — 串租户回归套件（issue #150 / 计划 Task 12）的**判定逻辑**单测。
//
// 为什么断言面落在「纯判定函数」而不是「跑一遍 CLI」：套件的价值全在**「哪一条红了、为什么红」**。
// 四个断言面的判定逻辑抽成纯函数后，每一格都能用一个桩去钉；整体编排（真 fetch / 真 PG）在本机
// **没有两租户真栈**，跑不出有意义的结论（诚实边界见报告 §5）⇒ 真栈那一半归 T13。
//
// ── 本文件存在的**唯一硬理由**：那条「缓存副本被重放 ⇒ 必须红」的用例 ──────────────────
// 计划 L950–954 面②把这条点名为「**最可能漏的一条**」。它漏掉的方式很特别：**套件全绿而缺陷在场**
// ——因为「B 拿到 A 的缓存副本」与「B 拿到自己的数据」在**接口形状上完全一样**（都是 200 + 一坨
// 数据）。判定必须下探到**数据内容**（对侧租户的探针串），且**探针必须两侧都有**：只查「B 的
// 结果里没有 A 的探针」时，一个恒返回空数据的坏桩也能全绿。故本文件里 A/B 两侧的探针
// **互为对方的断言面**，并且**先验「正面能绿」**（B 的 body 里确实有 B 的探针）再验负面。
//
// ── 判定函数的统一形状（`{ violations, notes }`）──────────────────────────────────────
// 四个面一律回这个形状（**不在某个面上开特例**）：`violations` 非空 ⇒ 该面红；`notes` 是
// 「不是违规、但排障时非知道不可」的观察（如面②两侧 token 是否指向同一张卡）。两者**分开**
// 是刻意的：把 note 塞进 violations 会让套件恒红（噪），把 violation 降级成 note 就是假的绿灯。
//
// ── mock 的形状纪律（#51 教训：mock 比真机宽松 = 缺陷结构性不可见）──────────────────────
// 桩一律**照真机形状**造（形状取自仓内实现，不是想象）：
//   · 问数 = `POST /api/modules/data/query` → `{status:'ok',subject,metricId,columns,rows,truncated}`
//     （`modules/data/domain/query-service.ts` 的 `QueryOk`，rows 是**二维数组**不是对象数组）；
//   · 嵌入 = 平台 `GET …/reports/:id/embed-url` → `{url,expiresAt}`，url 形如
//     `<metabase>/public/dashboard/<JWT>`（`modules/data/domain/metabase.ts` 的 `embedDashboardUrl`），
//     JWT payload = `{resource:{dashboard:<id>}, params:{tenant:<org>}, exp}`（同文件 `signEmbedToken`）；
//   · 词表 = `{metrics:[{id,title,description}]}`（`routes/metrics.ts` 的 `publicView` 三字段）；
//   · MCP = `{jsonrpc,id,result:{tools:[{name,description,inputSchema}]}}`（`routes/mcp.ts` 的 `toTool`）。
// ⚠️ **故本文件的桩只覆盖「判定」这一层**：它不验真栈真的会拦（那是 T13 的面）。任何把
//    「需要真栈的断言」在这里改写成永远绿的写法，都是在制造假的绿灯。

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptsDir = join(repoRoot, 'scripts')

/**
 * 动态 import：模块缺席时**只红本段**，不连坐同文件既有用例
 * （与 `check-data-models.test.ts` 的 T11 段同一手法）。
 */
async function suite(): Promise<any> {
  return (await import('./e2e-data-cross-tenant.mjs')) as never
}

// ── 桩工厂：照真机形状 ────────────────────────────────────────────────────────────────

/** `QueryOk` 的二维 rows 形态（不是 `[{...}]` —— 那个形状真机上不存在）。 */
function queryOk(rows: unknown[][]): unknown {
  return {
    status: 'ok', subject: 'tenant', metricId: 'retail:net_sales',
    columns: ['org', 'customer', 'amount'], rows, truncated: false,
  }
}

/** 仿 `signEmbedToken`：base64url(header).base64url(payload).sig（sig 内容对判定无意义）。 */
function embedToken(dashboardId: number, tenant: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = enc({ alg: 'HS256', typ: 'JWT' })
  const body = enc({ resource: { dashboard: dashboardId }, params: { tenant }, exp: 9999999999 })
  return `${head}.${body}.NOT_A_REAL_SIGNATURE`
}

/** 仿 Metabase `/public/dashboard/<token>` 的响应体（HTML 形态，数据在正文里）。 */
function embedBody(...markers: string[]): string {
  return `<html><body><div class="dashcard">${markers.join('</div><div class="dashcard">')}</div></body></html>`
}

/** 两租户的一组探针。 */
const PROBES = { a: 'ACME-CUSTOMER', b: 'BRAVO-CUSTOMER' }

/** 全套必需 env（真跑时由 openship job 注入；此处是**形状**，值是假的）。 */
function fullEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    E2E_PLATFORM_URL: 'https://platform.example.com',
    E2E_METRIC_ID: 'retail:net_sales',
    E2E_REPORT_ID: '7',
    E2E_TENANT_A_ORG: 'acme', E2E_TENANT_A_PAT: 'pat-a', E2E_TENANT_A_PROBE: PROBES.a,
    E2E_TENANT_B_ORG: 'bravo', E2E_TENANT_B_PAT: 'pat-b', E2E_TENANT_B_PROBE: PROBES.b,
    E2E_TENANT_A_PG_DSN: 'postgres://tenant_acme@warehouse:5432/warehouse',
    E2E_TENANT_A_S3_PATH: 's3://bucket/acme/rt/sales/',
    E2E_TENANT_B_S3_PATH: 's3://bucket/bravo/rt/sales/',
    E2E_TENANT_B_METRIC_IDS: 'bravo:bravo_only_metric',
    ...over,
  }
}

// ═══ 1. env 契约：缺参必须响亮失败（不许静默按默认值跑）══════════════════════════════════

describe('loadConfig：env 契约', () => {
  it('齐全 ⇒ 读出两租户 org/PAT/探针与凭据面', async () => {
    const { loadConfig } = await suite()
    const cfg = loadConfig(fullEnv())
    expect(cfg.tenantA.org).toBe('acme')
    expect(cfg.tenantB.probe).toBe(PROBES.b)
    expect(cfg.credential.foreignS3Path).toBe('s3://bucket/bravo/rt/sales/')
    expect(cfg.foreignMetricIds).toEqual(['bravo:bravo_only_metric'])
  })

  it('缺一个必需键 ⇒ 抛，且错误里**点名**缺的是哪个（不许静默按默认值跑）', async () => {
    const { loadConfig } = await suite()
    const env = fullEnv()
    delete env.E2E_TENANT_A_ORG
    expect(() => loadConfig(env)).toThrow(/E2E_TENANT_A_ORG/)
  })

  it('缺多个 ⇒ 一次全部列出（省掉「改一个跑一次」的往返）', async () => {
    const { loadConfig } = await suite()
    let msg = ''
    try {
      loadConfig({})
    } catch (e) {
      msg = (e as Error).message
    }
    for (const key of ['E2E_PLATFORM_URL', 'E2E_METRIC_ID', 'E2E_TENANT_B_PAT', 'E2E_TENANT_A_PG_DSN']) {
      expect(msg).toContain(key)
    }
  })

  it('两租户 org **同值** ⇒ 抛：那不是串租户测试，是同租户自比（会恒绿）', async () => {
    const { loadConfig } = await suite()
    expect(() => loadConfig(fullEnv({ E2E_TENANT_B_ORG: 'acme' }))).toThrow(/同值|相同|不是串租户/)
  })

  it('两租户探针**同值** ⇒ 抛：探针分不开两侧，「谁的数据」就无从判定', async () => {
    const { loadConfig } = await suite()
    expect(() => loadConfig(fullEnv({ E2E_TENANT_B_PROBE: PROBES.a }))).toThrow(/探针/)
  })

  it('同一租户的 S3 路径两侧同值 ⇒ 抛：凭据负测会退化成「读自己的」（恒绿）', async () => {
    const { loadConfig } = await suite()
    expect(() => loadConfig(fullEnv({ E2E_TENANT_B_S3_PATH: 's3://bucket/acme/rt/sales/' })))
      .toThrow(/S3|路径|恒绿/)
  })

  it('平台基址带尾斜杠 ⇒ 归一掉（否则拼出 `//api/modules/data`）', async () => {
    const { loadConfig } = await suite()
    expect(loadConfig(fullEnv({ E2E_PLATFORM_URL: 'https://platform.example.com/' })).platformUrl)
      .toBe('https://platform.example.com')
  })
})

// ═══ 2. 面①：问数 API — 结果集不含对侧租户的 org 值 ═════════════════════════════════════

describe('judgeQueryResult：面① 问数 API（词表裁剪 + 主体钉死的数据面实测）', () => {
  it('只有自己租户的数据 ⇒ 无 violation', async () => {
    const { judgeQueryResult } = await suite()
    const out = judgeQueryResult({
      tenant: 'acme', probe: PROBES.a, foreignProbe: PROBES.b,
      outcome: queryOk([['acme', PROBES.a, 100], ['acme', PROBES.a, 250]]),
    })
    expect(out.violations).toEqual([])
  })

  it('结果里出现**对侧租户的探针** ⇒ violation，且 message 点出具体值', async () => {
    const { judgeQueryResult } = await suite()
    const out = judgeQueryResult({
      tenant: 'acme', probe: PROBES.a, foreignProbe: PROBES.b,
      outcome: queryOk([['acme', PROBES.a, 100], ['bravo', PROBES.b, 999]]),
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations[0].surface).toBe('query')
    expect(out.violations[0].message).toContain(PROBES.b)
    expect(out.violations[0].message).toContain('bravo')
  })

  it('**空结果集不算违规，也不算通过**：正面信号缺失要显式报出来（否则坏桩恒绿）', async () => {
    const { judgeQueryResult } = await suite()
    const out = judgeQueryResult({
      tenant: 'acme', probe: PROBES.a, foreignProbe: PROBES.b,
      outcome: queryOk([]),
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations[0].message).toMatch(/空|探针/)
  })

  it('问数**没成功**（denied / error）⇒ violation：把「没跑到」当通过是最典型的假绿', async () => {
    const { judgeQueryResult } = await suite()
    for (const outcome of [
      { status: 'denied', metricId: 'retail:net_sales', reason: 'not_authorized' },
      { status: 'error', metricId: 'retail:net_sales', reason: 'warehouse_error', detail: 'boom' },
    ]) {
      const out = judgeQueryResult({
        tenant: 'acme', probe: PROBES.a, foreignProbe: PROBES.b, outcome,
      })
      expect(out.violations.length).toBeGreaterThan(0)
      expect(out.violations[0].surface).toBe('query')
    }
  })

  it('**自己租户的探针缺席**（一个都没出现）⇒ violation：不能只验「没有对方的」', async () => {
    const { judgeQueryResult } = await suite()
    const out = judgeQueryResult({
      tenant: 'acme', probe: PROBES.a, foreignProbe: PROBES.b,
      outcome: queryOk([['acme', 'SOMEONE-ELSE', 100]]),
    })
    expect(out.violations.length).toBeGreaterThan(0)
  })
})

// ═══ 3. 面②：嵌入缓存重放 —— 本套件的「最可能漏的一条」 ════════════════════════════════

describe('decodeEmbedToken', () => {
  it('解出 resource.dashboard 与 params.tenant（这是「锁死本租户」的可机检落点）', async () => {
    const { decodeEmbedToken } = await suite()
    expect(decodeEmbedToken(embedToken(42, 'acme'))).toEqual({ dashboardId: 42, tenant: 'acme' })
  })

  it('畸形 token ⇒ 抛（读不出就是读不出，不许回落成 `{tenant: undefined}` 把判据放空）', async () => {
    const { decodeEmbedToken } = await suite()
    expect(() => decodeEmbedToken('not-a-jwt')).toThrow()
    expect(() => decodeEmbedToken('a.!!!not-base64-json!!!.c')).toThrow()
  })
})

describe('judgeEmbedReplay：面② 嵌入缓存重放（计划点名的「最可能漏的一条」）', () => {
  it('两侧各自拿到自己的数据（正面先绿）⇒ 无 violation', async () => {
    const { judgeEmbedReplay } = await suite()
    const out = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 42, tenant: 'acme' }, body: embedBody(PROBES.a) },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'bravo' }, body: embedBody(PROBES.b) },
      probes: PROBES,
    })
    expect(out.violations).toEqual([])
  })

  it('★ B 的响应**复用 A 的 body**（缓存副本被重放）⇒ 必须红，且 message 点名「重放」', async () => {
    const { judgeEmbedReplay } = await suite()
    // 桩：B 的请求拿到了 A 的那份数据（Metabase 结果缓存的 key 若不含 locked 参数，就是这个形态）
    const aBody = embedBody(PROBES.a)
    const out = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 42, tenant: 'acme' }, body: aBody },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'bravo' }, body: aBody },
      probes: PROBES,
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations[0].surface).toBe('embed-replay')
    expect(out.violations[0].message).toMatch(/重放|缓存/)
    expect(out.violations[0].message).toContain(PROBES.a)
  })

  it('B 的 token 里 tenant ≠ B 的 org ⇒ violation（locked 参数被改写 = 数据门失守）', async () => {
    const { judgeEmbedReplay } = await suite()
    const out = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 42, tenant: 'acme' }, body: embedBody(PROBES.a) },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'acme' }, body: embedBody(PROBES.b) },
      probes: PROBES,
    })
    expect(out.violations.some((x: any) => x.surface === 'embed-replay' && /tenant/.test(x.message)))
      .toBe(true)
  })

  it('B 的 body 里**连 B 的探针都没有** ⇒ violation：分不清「没重放」与「根本没数据」', async () => {
    const { judgeEmbedReplay } = await suite()
    const out = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 42, tenant: 'acme' }, body: embedBody(PROBES.a) },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'bravo' }, body: embedBody() },
      probes: PROBES,
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations.some((x: any) => /正面|探针.*缺席|没有.*探针|空/.test(x.message))).toBe(true)
  })

  it('A 侧自己就拿到了 B 的数据 ⇒ violation（同一个判据的反方向）', async () => {
    const { judgeEmbedReplay } = await suite()
    const out = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 42, tenant: 'acme' }, body: embedBody(PROBES.b) },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'bravo' }, body: embedBody(PROBES.b) },
      probes: PROBES,
    })
    expect(out.violations.some((x: any) => x.surface === 'embed-replay')).toBe(true)
  })

  it('两侧 token 指向**同一张 dashboard** vs 不同 ⇒ notes 里如实记下（重放风险的结构面）', async () => {
    const { judgeEmbedReplay } = await suite()
    const same = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 42, tenant: 'acme' }, body: embedBody(PROBES.a) },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'bravo' }, body: embedBody(PROBES.b) },
      probes: PROBES,
    })
    const diff = judgeEmbedReplay({
      a: { org: 'acme', claims: { dashboardId: 41, tenant: 'acme' }, body: embedBody(PROBES.a) },
      b: { org: 'bravo', claims: { dashboardId: 42, tenant: 'bravo' }, body: embedBody(PROBES.b) },
      probes: PROBES,
    })
    expect(same.notes.some((n: string) => /同一张|共享/.test(n))).toBe(true)
    expect(diff.notes.some((n: string) => /不同|各自|互不/.test(n))).toBe(true)
  })
})

// ═══ 4. 面③：凭据负测 — 从数据面反向验结构性隔离 ═══════════════════════════════════════

describe('judgeCredentialProbe：面③ 凭据负测（T11 的 USER MAPPING/SCOPE 隔离的反证）', () => {
  it('正对照能读自己的 + 负测被 SCOPE 拦住 ⇒ 无 violation', async () => {
    const { judgeCredentialProbe } = await suite()
    const out = judgeCredentialProbe({
      ownPath: 's3://bucket/acme/rt/sales/', foreignPath: 's3://bucket/bravo/rt/sales/',
      positive: { ok: true, error: '' },
      negative: { ok: false, error: 'Permission Error: not authorized to read this SCOPE (bravo)' },
    })
    expect(out.violations).toEqual([])
  })

  it('负测**读成功了** ⇒ violation（凭据没收紧 —— 结构性隔离的反证失败）', async () => {
    const { judgeCredentialProbe } = await suite()
    const out = judgeCredentialProbe({
      ownPath: 's3://bucket/acme/rt/sales/', foreignPath: 's3://bucket/bravo/rt/sales/',
      positive: { ok: true, error: '' },
      negative: { ok: true, error: '' },
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations[0].surface).toBe('credential')
    expect(out.violations[0].message).toContain('s3://bucket/bravo/rt/sales/')
  })

  it('**正对照读不了自己的** ⇒ 也 violation：环境本身坏了，负测的「通过」毫无意义（空转防护）', async () => {
    const { judgeCredentialProbe } = await suite()
    const out = judgeCredentialProbe({
      ownPath: 's3://bucket/acme/rt/sales/', foreignPath: 's3://bucket/bravo/rt/sales/',
      positive: { ok: false, error: 'connection refused' },
      negative: { ok: false, error: 'connection refused' },
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations.some((x: any) => /正对照/.test(x.message))).toBe(true)
  })

  it('负测的失败原因**分不出是不是隔离**（如连不上）⇒ 不能让负测算通过', async () => {
    const { judgeCredentialProbe } = await suite()
    const out = judgeCredentialProbe({
      ownPath: 's3://bucket/acme/rt/sales/', foreignPath: 's3://bucket/bravo/rt/sales/',
      positive: { ok: true, error: '' },
      negative: { ok: false, error: 'could not connect to endpoint' },
    })
    // 连不上 ≠ 被 SCOPE 拦住 ⇒ 「负测失败」这个信号不可采信，必须报出来
    expect(out.violations.some((x: any) => /不可采信|分不出|无法判定|不像隔离/.test(x.message)))
      .toBe(true)
  })
})

// ═══ 5. 面④：L2 词表 — 看不到对侧 org 定义的指标 ═══════════════════════════════════════

describe('judgeCatalog：面④ L2 词表（GET /metrics 与 MCP tools/list）', () => {
  const FOREIGN = ['bravo:bravo_only_metric']

  it('两条通道都看不到对侧指标 ⇒ 无 violation', async () => {
    const { judgeCatalog } = await suite()
    const out = judgeCatalog({
      foreignMetricIds: FOREIGN,
      metrics: { metrics: [{ id: 'retail:net_sales', title: '净销', description: '' }] },
      tools: {
        jsonrpc: '2.0', id: 1,
        result: { tools: [{ name: 'retail:net_sales', description: '净销', inputSchema: { type: 'object', properties: {}, required: [] } }] },
      },
    })
    expect(out.violations).toEqual([])
  })

  it('GET /metrics 里出现对侧指标 id ⇒ violation（surface=catalog）', async () => {
    const { judgeCatalog } = await suite()
    const out = judgeCatalog({
      foreignMetricIds: FOREIGN,
      metrics: { metrics: [{ id: FOREIGN[0], title: '泄了', description: '' }] },
      tools: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations[0].surface).toBe('catalog')
    expect(out.violations[0].message).toContain(FOREIGN[0])
  })

  it('MCP tools/list 里出现对侧指标 ⇒ violation（**两条通道各判各的**，不许只判一条）', async () => {
    const { judgeCatalog } = await suite()
    const out = judgeCatalog({
      foreignMetricIds: FOREIGN,
      metrics: { metrics: [] },
      tools: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: FOREIGN[0], description: '', inputSchema: {} }] } },
    })
    expect(out.violations.some((x: any) => /mcp|tools/i.test(x.message))).toBe(true)
  })

  it('响应形状坏了（缺 metrics / tools 数组）⇒ violation，不许当「空词表」放过', async () => {
    const { judgeCatalog } = await suite()
    const out = judgeCatalog({
      foreignMetricIds: FOREIGN,
      metrics: { error: 'INTERNAL' },
      tools: {},
    })
    expect(out.violations.length).toBeGreaterThan(0)
    expect(out.violations.some((x: any) => /形状|读不出/.test(x.message))).toBe(true)
  })

  it('MCP **协议级错误**（result.tools 缺席、回 error）⇒ violation，不许当空词表', async () => {
    const { judgeCatalog } = await suite()
    const out = judgeCatalog({
      foreignMetricIds: FOREIGN,
      metrics: { metrics: [] },
      tools: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } },
    })
    expect(out.violations.length).toBeGreaterThan(0)
  })
})

// ═══ 6. 编排：干净 ⇒ exit 0；任一面违规 ⇒ exit 1 ═══════════════════════════════════════

describe('runSuite：四面编排（I/O 全桩）', () => {
  function jsonResponse(body: unknown): unknown {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  function textResponse(body: string): unknown {
    return { ok: true, status: 200, json: async () => ({}), text: async () => body }
  }

  /** 全绿的一组桩：四个面都返回「符合预期」的响应。 */
  function healthyDeps(): any {
    const cfg = loadConfigStub()
    return {
      config: cfg,
      fetch: async (url: string) => {
        if (url.includes('/api/modules/data/query')) {
          return jsonResponse(queryOk([['acme', PROBES.a, 100]]))
        }
        if (url.includes('/embed-url')) {
          const who = url.includes('/reports/a/') ? cfg.tenantA : cfg.tenantB
          return jsonResponse({
            url: `https://mb.example.com/public/dashboard/${embedToken(42, who.org)}`,
            expiresAt: '2026-09-22T12:10:00.000Z',
          })
        }
        if (url.includes('/public/dashboard/')) {
          const token = url.split('/public/dashboard/')[1]
          const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
          const probe = claims.params.tenant === cfg.tenantA.org ? cfg.tenantA.probe : cfg.tenantB.probe
          return textResponse(embedBody(probe))
        }
        if (url.includes('/metrics')) {
          return jsonResponse({ metrics: [{ id: cfg.metricId, title: '净销', description: '' }] })
        }
        if (url.includes('/mcp')) {
          return jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: cfg.metricId, description: '', inputSchema: {} }] } })
        }
        throw new Error(`桩没覆盖的 URL：${url}`)
      },
      // 凭据面：正对照能读、负测被 SCOPE 拦住
      readParquet: async (s3Path: string) => (s3Path === cfg.credential.ownS3Path
        ? { ok: true, error: '' }
        : { ok: false, error: 'Permission Error: not authorized to read this SCOPE' }),
    }
  }

  /** 供编排用的配置（`loadConfig` 的产物形状；此处直接构造，省掉 env 往返）。 */
  function loadConfigStub(): any {
    return {
      platformUrl: 'https://platform.example.com',
      metricIds: ['retail:net_sales'],
      metricId: 'retail:net_sales',
      reportIdA: 'a',
      reportIdB: 'b',
      tenantA: { org: 'acme', pat: 'pat-a', probe: PROBES.a },
      tenantB: { org: 'bravo', pat: 'pat-b', probe: PROBES.b },
      credential: {
        dsn: 'postgres://tenant_acme@warehouse:5432/warehouse',
        ownS3Path: 's3://bucket/acme/rt/sales/',
        foreignS3Path: 's3://bucket/bravo/rt/sales/',
      },
      foreignMetricIds: ['bravo:bravo_only_metric'],
    }
  }

  it('四面全绿 ⇒ violations 空', async () => {
    const { runSuite } = await suite()
    const out = await runSuite(healthyDeps())
    expect(out.violations).toEqual([])
  })

  it('**把面②的桩改成「B 拿 A 的 body」** ⇒ violations 非空且含 embed-replay（端到端那条必须能红）', async () => {
    const { runSuite } = await suite()
    const deps = healthyDeps()
    const inner = deps.fetch
    deps.fetch = async (url: string) => {
      if (url.includes('/public/dashboard/')) {
        // 无论谁的 token，都返回 A 的那份 —— 就是缓存重放的形态
        return textResponse(embedBody(deps.config.tenantA.probe))
      }
      return inner(url)
    }
    const out = await runSuite(deps)
    expect(out.violations.some((v: any) => v.surface === 'embed-replay')).toBe(true)
  })

  it('面①的桩改成「返回对方租户的数据」⇒ 端到端也要红', async () => {
    const { runSuite } = await suite()
    const deps = healthyDeps()
    const inner = deps.fetch
    deps.fetch = async (url: string) => (url.includes('/api/modules/data/query')
      ? jsonResponse(queryOk([['bravo', PROBES.b, 999]]))
      : inner(url))
    const out = await runSuite(deps)
    expect(out.violations.some((v: any) => v.surface === 'query')).toBe(true)
  })
})

// ═══ 7. CLI 对外契约：缺参 ⇒ 非 0 + 明确提示 ═══════════════════════════════════════════

describe('CLI 契约（真起进程）', () => {
  function runCli(args: string[], env: Record<string, string>): { status: number; out: string } {
    try {
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', join(scriptsDir, 'e2e-data-cross-tenant.mjs'), ...args],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
      )
      return { status: 0, out: stdout }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      if (typeof err.status !== 'number') throw e
      return { status: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
    }
  }

  it('--help ⇒ exit 0，且列出全部 env 键（人照着就能把真跑参数凑齐）', () => {
    const { status, out } = runCli(['--help'], {})
    expect(status).toBe(0)
    for (const key of ['E2E_PLATFORM_URL', 'E2E_TENANT_A_PAT', 'E2E_TENANT_B_PROBE', 'E2E_TENANT_A_PG_DSN', 'E2E_TENANT_B_METRIC_IDS']) {
      expect(out).toContain(key)
    }
  })

  it('缺参 ⇒ **非 0** + 点名缺哪个（不许静默按默认值跑）', () => {
    const { status, out } = runCli([], {})
    expect(status).not.toBe(0)
    expect(out).toContain('E2E_PLATFORM_URL')
  })
})
