// observability.test.ts — 「运行观测」路由层测试（#2681）。
//
// 分工：本文件验**装配与形状**（未登录 401、坏参数 400、体检行解析、单块降级不整体 500）；
// 真实数据形状归生产探针（页面打开即验）。取数用「永远空结果」的假 pool。
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { declaredScopeGate } from '@platform/sdk'
import type { Pool } from 'pg'
import mod from '../index'
import { buildTestApp, makeIdentity } from '../test-util'
import { clearObservabilityCache, lakeFromAssertions, parseAssertionTail } from './observability'
import type { ModuleVars } from './context'

const ORG = 'org-observability'
const identity = makeIdentity({ orgId: ORG })

/** 空结果 pool；`calls` 用来验缓存命中后不再查库。 */
function emptyPool(): { pool: Pool; calls: () => number } {
  let calls = 0
  const pool = {
    query: async () => { calls += 1; return { rows: [], rowCount: 0 } },
  } as unknown as Pool
  return { pool, calls: () => calls }
}

const DECLS = [
  { method: 'GET' as const, path: '/system-map/observability', scope: 'data:query' },
  { method: 'GET' as const, path: '/system-map/observability/recon', scope: 'data:query' },
]

function appWithGate(identityOverride?: ReturnType<typeof makeIdentity>) {
  const shell = new Hono<ModuleVars>()
  for (const p of ['/system-map/observability', '/system-map/observability/recon']) {
    if (identityOverride !== undefined) {
      shell.use(p, async (c, next) => {
        c.set('identity', identityOverride)
        c.set('tenant', { id: 1, casdoor_org: identityOverride.orgId })
        await next()
      })
    }
    shell.use(p, declaredScopeGate(DECLS))
  }
  const { pool } = emptyPool()
  shell.route('/', mod.createRouter({ pool }))
  return shell as unknown as Hono
}

describe('parseAssertionTail', () => {
  it('解析 `OK|WARN|ERR <check>: <detail>` 行，忽略其他输出', () => {
    const tail = [
      'OK dns: OK pg_duckdb→172.19.0.2',
      'OK fresh: OK max=2026-11-22（容差线 2026-11-20）',
      'WARN org_valid: WARN 读不动 staging.x（争用）',
      'ERR swap_offset: ERR relation "staging.fct_retail_swap_offset" does not exist',
      'warehouse-assertions[core]: 19 checks, 1 ERR (advisory 判红不翻 rc)',
      '',
    ].join('\n')
    const rows = parseAssertionTail(tail, 'core', '2026-11-22T07:15:49Z')
    expect(rows.map((r) => [r.check, r.verdict])).toEqual([
      ['dns', 'ok'],
      ['fresh', 'ok'],
      ['org_valid', 'warn'],
      ['swap_offset', 'err'],
    ])
    expect(rows[3].detail).toContain('does not exist')
    expect(rows[0].group).toBe('core')
  })

  it('空/无关输出 ⇒ 空数组（不伪造结果）', () => {
    expect(parseAssertionTail('', 'oo', '2026-11-22T00:00:00Z')).toEqual([])
    expect(parseAssertionTail('starting…\nDone.\n', 'oo', '2026-11-22T00:00:00Z')).toEqual([])
  })
})

describe('lakeFromAssertions（湖指标的唯一来源是 ㉑ 的 detail）', () => {
  const row = (detail: string) => [{ group: 'core' as const, check: 'lake_hygiene', verdict: 'ok' as const, detail, at: '2026-11-22T10:00:00Z' }]

  it('解析 k=v 段（含 WARN/ERR 行尾附带的 kv）', () => {
    const lake = lakeFromAssertions(row(
      'OK hour_files=17 hour_oldest=2026-11-22 day_files=1565 day_newest=2026-11-21 month_files=52 sealed_max=2026-11-21 month_index=2026-11 today=2026-11-22',
    ))
    expect(lake).toMatchObject({
      hourFiles: 17, hourOldest: '2026-11-22', dayFiles: 1565,
      dayNewest: '2026-11-21', monthFiles: 52, sealedMax: '2026-11-21', monthIndexMax: '2026-11',
    })
    expect(lake.error).toBeUndefined()
  })

  it('(空) 折成 null；非 OK 行（ERR 带 kv）同样可解析', () => {
    const lake = lakeFromAssertions(row('ERR 日区 glob 空 | hour_files=3 hour_oldest=(空) day_files=0 day_newest=(空) month_files=52 sealed_max=2026-11-21 month_index=2026-11'))
    expect(lake.hourFiles).toBe(3)
    expect(lake.hourOldest).toBeNull()
    expect(lake.dayNewest).toBeNull()
  })

  it('没有 lake_hygiene ⇒ error（不伪造数据）', () => {
    const lake = lakeFromAssertions([])
    expect(lake.error).toContain('lake_hygiene')
    expect(lake.hourFiles).toBeNull()
  })
})

describe('GET /system-map/observability', () => {
  afterEach(() => clearObservabilityCache())

  it('未登录 ⇒ 401（门卫在宿主；模块兜 org 空）', async () => {
    const app = appWithGate()
    const res = await app.request('/system-map/observability')
    expect(res.status).toBe(401)
  })

  it('登录后返回四块骨架 + warnings（空库时每块自己降级，不整体 500）', async () => {
    const app = buildTestApp(mod, identity, { pool: emptyPool().pool })
    const res = await app.request('/system-map/observability')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      generatedAt: string
      schedules: unknown[]
      assertions: { rows: unknown[] }
      lake: Record<string, unknown>
      materialization: unknown[]
      recon: unknown
      warnings: string[]
    }
    expect(typeof body.generatedAt).toBe('string')
    expect(Array.isArray(body.schedules)).toBe(true)
    expect(Array.isArray(body.assertions.rows)).toBe(true)
    expect(Array.isArray(body.materialization)).toBe(true)
    expect(body.lake).toBeTypeOf('object')
    expect(Array.isArray(body.warnings)).toBe(true)
  })

  it('30 秒缓存：第二次请求不再查库', async () => {
    const app = buildTestApp(mod, identity, { pool: emptyPool().pool })
    const first = await app.request('/system-map/observability')
    expect(first.status).toBe(200)
    const second = await app.request('/system-map/observability')
    expect(second.status).toBe(200)
    // 缓存体逐字相同（generatedAt 也不变 ⇒ 证实走了缓存而非重查）
    expect(await second.json()).toEqual(await first.json())
  })
})

describe('GET /system-map/observability/recon', () => {
  it('坏参数 ⇒ 400（book/日期/verdict 三处都拒）', async () => {
    const app = buildTestApp(mod, identity, { pool: emptyPool().pool })
    expect((await app.request('/system-map/observability/recon?book=12%2034')).status).toBe(400)
    expect((await app.request('/system-map/observability/recon?bizday=2026-1-2')).status).toBe(400)
    expect((await app.request('/system-map/observability/recon?verdict=whatever')).status).toBe(400)
  })

  it('未登录 ⇒ 401', async () => {
    const app = appWithGate()
    const res = await app.request('/system-map/observability/recon')
    expect(res.status).toBe(401)
  })
})
