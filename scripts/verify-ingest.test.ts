// verify-ingest.test.ts — W1 Task 5：平台侧摄入（OO 只读拉取）。
//
// **不连网、不连库**：`fetch` 全注入；`replay` / `upsert` / `recordCheck` / `loadSources` /
// 水位读写全部注入替身。真 OO / 真仓的验证归 Task 6 真机验收。
//
// 事件契约来自 Task 4（`{org, question, metricId, params, slicing, signal, sessionId, seq,
// userId, at}`；`params`/`slicing` 是 **JSON 字符串**）。本文件钉住：
//   强 → verified（strength=strong，由 Task 1 的 upsert 映射）/ 弱 → candidate /
//   负 → 丢弃只计数 / 重复投递幂等 / 重放失败 → candidate + error（不猜基线）/
//   org 缺失跳过 / 水位成功后才前进（写入失败或 HTTP 失败都不前进）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  authHeader,
  DEFAULT_WM_PATH,
  defaultWmPath,
  EMPTY_BASELINE,
  ingest,
  main,
  parseArgs,
  parseEvent,
  parseSince,
  readWatermark,
  searchClient,
  STREAM,
  writeWatermark,
} from './verify-ingest.mjs'
import { UnknownTenantError } from './tenant-sources'

const NOW_MS = Date.UTC(2026, 10, 4, 12, 0, 0)
const TS1 = 1_793_793_000_000_000
const TS2 = 1_793_793_000_000_001

const OPTS = {
  url: 'https://oo.test/',
  ooOrg: 'oo-org',
  token: 'read-token',
  wmPath: '/tmp/verify-ingest-test.watermark',
}

const BASELINE = {
  columns: ['value'],
  rowCount: 1,
  summary: { value: { sum: 1000, min: 1000, max: 1000, nulls: 0, numeric: true } },
}

/** 一条 OO `_search` 命中（形状 = Task 4 `verify.py` 写出的事件 + OO 的 `_timestamp`）。 */
function hit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _timestamp: TS1,
    org: 'acme',
    question: '上个月净销售额',
    metricId: 'lemeng:retail:net_sales',
    params: '{"bizday":{"from":"2026-10-01","to":"2026-10-31"}}',
    slicing: '{}',
    signal: 'strong',
    sessionId: 's1',
    seq: 1,
    userId: 'u1',
    at: '2026-11-01T00:00:00Z',
    ...over,
  }
}

function okOutcome() {
  return {
    status: 'ok', subject: 'acme', metricId: 'lemeng:retail:net_sales',
    columns: ['value'], rows: [['1000']], truncated: false,
  }
}

/**
 * 注入全部副作用。`upsert` 的替身按 **Task 1 的唯一键**（org, metricId, question, params,
 * slicing）去重——它模拟的是 DB 唯一索引的效果；真索引见迁移 032 / Task 1。
 */
function collect(hits: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  const wmWrites: number[] = []
  const upserts: { org: string; input: any }[] = []
  const records: { org: string; id: number; result: string }[] = []
  const replays: any[][] = []
  const store = new Map<string, any>()
  let wm: number | null = null
  let nextId = 1
  const deps: any = {
    fetch: async (_url: string, _init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ hits, total: hits.length }),
      text: async () => '',
    }),
    readWm: (_p: string) => wm,
    writeWm: (_p: string, v: number) => { wmWrites.push(v); wm = v },
    now: () => NOW_MS,
    loadSources: async () => new Set(['lemeng']),
    replay: async (...args: any[]) => { replays.push(args); return okOutcome() },
    summarize: () => BASELINE,
    upsert: async (_pool: any, org: string, input: any) => {
      const key = `${org}|${input.metricId}|${input.question}|${JSON.stringify(input.params)}|${JSON.stringify(input.slicing)}`
      upserts.push({ org, input })
      const existing = store.get(key)
      if (existing === undefined) {
        const row = {
          id: nextId++,
          org,
          ...input,
          // Task 1 的落库映射：自动强信号 → verified；其余 → candidate（重放失败强制 candidate）。
          status: input.forceCandidate === true ? 'candidate' : input.strength === 'strong' ? 'verified' : 'candidate',
        }
        store.set(key, row)
        return row.id
      }
      // 冲突语义的最小模拟（真语义由 Task 1 的 DB 测试钉住）：
      // preserveBaseline=true ⇒ 已有基线/切面不被空哨兵覆盖；verified 的 status 冻结。
      const next = { ...existing }
      if (input.preserveBaseline !== true) {
        next.baseline = input.baseline
        next.slicing = input.slicing
      }
      if (input.tolerance !== undefined) next.tolerance = input.tolerance
      if (existing.status !== 'verified' && existing.status !== 'rejected') {
        next.status = input.forceCandidate === true ? 'candidate' : input.strength === 'strong' ? 'verified' : 'candidate'
        next.verified_by = next.status === 'verified' ? 'auto:strong' : null
      }
      next.strength = input.strength === 'strong' || existing.strength === 'strong' ? 'strong' : existing.strength
      store.set(key, next)
      return existing.id
    },
    recordCheck: async (_pool: any, org: string, id: number, result: string) => {
      records.push({ org, id, result })
    },
    log: () => {},
    ...over,
  }
  return { deps, wmWrites, upserts, records, replays, store }
}

// ── 事件解析 / 参数 / 凭据 ──────────────────────────────────────────────────────

describe('parseEvent（Task 4 事件契约）', () => {
  it('params / slicing 是 JSON 字符串 ⇒ parse 成对象', () => {
    const ev = parseEvent(hit())
    expect(ev).toMatchObject({
      signal: 'strong',
      org: 'acme',
      question: '上个月净销售额',
      metricId: 'lemeng:retail:net_sales',
      sessionId: 's1',
    })
    expect(ev.params).toEqual({ bizday: { from: '2026-10-01', to: '2026-10-31' } })
    expect(ev.slicing).toEqual({})
  })

  it('缺省 / 空串 / 空白串的 params / slicing ⇒ {}（不把空串当 JSON 解析）', () => {
    const ev = parseEvent(hit({ params: '', slicing: undefined }))
    expect(ev.params).toEqual({})
    expect(ev.slicing).toEqual({})
    expect(parseEvent(hit({ params: '   ', slicing: '\n' }))).toMatchObject({ params: {}, slicing: {} })
  })

  it('org 为空 ⇒ BadEventError(BAD_ORG)；question/metricId 缺失与非法 JSON ⇒ 抛错（不猜）', () => {
    expect(() => parseEvent(hit({ org: '  ' }))).toThrow(/org/)
    expect(() => parseEvent(hit({ question: '' }))).toThrow(/question/)
    expect(() => parseEvent(hit({ metricId: '' }))).toThrow(/metricId/)
    expect(() => parseEvent(hit({ params: 'not-json' }))).toThrow(/params/)
    expect(() => parseEvent(hit({ params: '[1,2]' }))).toThrow(/params/)
    expect(() => parseEvent(hit({ signal: 'unknown' }))).toThrow(/signal/)
  })
})

describe('parseArgs / parseSince', () => {
  it('默认 --once；--dry-run / --since 解析', () => {
    expect(parseArgs([])).toEqual({ once: true, dryRun: false })
    expect(parseArgs(['--once'])).toEqual({ once: true, dryRun: false })
    expect(parseArgs(['--dry-run'])).toEqual({ once: true, dryRun: true })
    expect(parseArgs(['--since=2026-11-05T00:00:00Z']))
      .toEqual({ once: true, dryRun: false, sinceUs: 1_793_836_800_000_000 })
  })

  it('缺值 / 未知键 / 位置参数 ⇒ 抛错（拼错不静默）', () => {
    expect(() => parseArgs(['--since'])).toThrow(/--since/)
    expect(() => parseArgs(['--since', '--dry-run'])).toThrow(/--since/)
    expect(() => parseArgs(['--bogus'])).toThrow(/无法识别/)
    expect(() => parseArgs(['x'])).toThrow(/无法识别/)
  })

  it('--since 接受 RFC3339 与秒/毫秒/微秒 epoch（按量级判）', () => {
    expect(parseSince('1793836800')).toBe(1_793_836_800_000_000)
    expect(parseSince('1793836800000')).toBe(1_793_836_800_000_000)
    expect(parseSince('1793836800000000')).toBe(1_793_836_800_000_000)
    expect(parseSince('2026-11-05T00:00:00Z')).toBe(1_793_836_800_000_000)
    expect(() => parseSince('yesterday')).toThrow(/--since/)
  })
})

describe('authHeader', () => {
  it('裸 token 补 Basic；已带 Basic/Bearer 前缀原样用；空 token 抛错', () => {
    expect(authHeader('abc')).toBe('Basic abc')
    expect(authHeader('Basic abc')).toBe('Basic abc')
    expect(authHeader('Bearer xyz')).toBe('Bearer xyz')
    expect(() => authHeader('  ')).toThrow(/OO_READ_TOKEN/)
  })
})

// ── OO `_search` HTTP 形态 ─────────────────────────────────────────────────────

describe('searchClient', () => {
  it('POST /api/<org>/<stream>/_search；Basic 鉴权；微秒时间窗；>= 水位 + seq 次级排序', async () => {
    const calls: { url: string; init: any }[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ hits: [], total: 0 }), text: async () => '' }
    }
    const search = searchClient(OPTS, fakeFetch as unknown as typeof fetch)
    await search({ cursorUs: 1_793_793_000_000_123, endUs: 1_793_793_000_456_789, from: 0, size: 7 })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://oo.test/api/oo-org/${STREAM}/_search`)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers.Authorization).toBe('Basic read-token')
    expect(calls[0]!.init.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(calls[0]!.init.body)
    expect(body.query).toMatchObject({
      start_time: 1_793_793_000_000_123,
      end_time: 1_793_793_000_456_789,
      from: 0,
      size: 7,
    })
    expect(body.query.sql).toContain(`from "${STREAM}"`)
    // >= 而非 >：同一微秒入库的边界组不能被跳过（review Important 4）
    expect(body.query.sql).toContain('where _timestamp >= 1793793000000123')
    expect(body.query.sql).toContain('order by _timestamp asc, seq asc, sessionId asc')
  })

  it('首次运行（无水位）不加 where，start_time=0', async () => {
    const calls: { url: string; init: any }[] = []
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ hits: [], total: 0 }), text: async () => '' }
    }
    const search = searchClient(OPTS, fakeFetch as unknown as typeof fetch)
    await search({ cursorUs: null, endUs: 1, from: 0, size: 10 })
    const body = JSON.parse(calls[0]!.init.body)
    expect(body.query.start_time).toBe(0)
    expect(body.query.sql).not.toContain('where _timestamp >=')
  })

  it('非 2xx ⇒ 抛错（带状态与响应片段），不当空结果', async () => {
    const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) })
    const search = searchClient(OPTS, fakeFetch as unknown as typeof fetch)
    await expect(search({ cursorUs: null, endUs: 1, from: 0, size: 10 }))
      .rejects.toThrow(/HTTP 401.*unauthorized/)
  })
})

// ── 核心摄入 ───────────────────────────────────────────────────────────────────

describe('ingest', () => {
  it('强信号 → source=auto / strength=strong（Task 1 映射为 verified）+ 水位推进', async () => {
    const c = collect([hit()])
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ fetched: 1, strong: 1, weak: 0, negative: 0, written: 1 })
    expect(c.upserts).toHaveLength(1)
    const input = c.upserts[0]!.input
    expect(input).toMatchObject({
      source: 'auto', strength: 'strong', metricId: 'lemeng:retail:net_sales', sessionId: 's1',
    })
    expect(input.params).toEqual({ bizday: { from: '2026-10-01', to: '2026-10-31' } })
    expect(input.slicing).toEqual({})
    expect(input.forceCandidate).toBeUndefined()
    expect([...c.store.values()][0]!.status).toBe('verified')

    // 重放：带 org、平台回归特权身份、params 已 parse 成对象
    expect(c.replays).toHaveLength(1)
    expect(c.replays[0]![1]).toBe('acme')
    expect(c.replays[0]![2].userId).toBe('(regression)')
    expect(c.replays[0]![4]).toEqual({ bizday: { from: '2026-10-01', to: '2026-10-31' } })
    // 水位 = 该记录的 _timestamp（成功后才写）
    expect(c.wmWrites).toEqual([TS1])
  })

  it('弱信号 → source=auto / strength=weak（candidate）', async () => {
    const c = collect([hit({ signal: 'weak' })])
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ weak: 1, written: 1 })
    expect(c.upserts[0]!.input).toMatchObject({ source: 'auto', strength: 'weak' })
    expect([...c.store.values()][0]!.status).toBe('candidate')
  })

  it('负信号 ⇒ 丢弃（不入集、不重放）但计入统计，水位照常越过', async () => {
    const c = collect([hit({ signal: 'negative' })])
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ negative: 1, written: 0 })
    expect(c.upserts).toHaveLength(0)
    expect(c.replays).toHaveLength(0)
    expect(c.wmWrites).toEqual([TS1])
  })

  it('重复投递幂等：同一事件两次 → 唯一键只落一行，水位不重复前进', async () => {
    const c = collect([hit()])
    await ingest(OPTS, c.deps)
    await ingest(OPTS, c.deps)

    expect(c.upserts).toHaveLength(2)
    expect(c.upserts[0]!.input).toEqual(c.upserts[1]!.input)
    expect([...c.store.keys()]).toHaveLength(1)
    // 第二次 max(_timestamp) 未超过已有水位 ⇒ 不再写水位
    expect(c.wmWrites).toEqual([TS1])
  })

  it('重放非 ok（denied）⇒ candidate + last_check_result=error，不猜基线', async () => {
    const c = collect([hit()], {
      replay: async () => ({ status: 'denied', metricId: 'lemeng:retail:net_sales', reason: 'metric_not_declared' }),
    })
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ replayError: 1, written: 1, strong: 0 })
    expect(c.upserts[0]!.input).toMatchObject({
      source: 'auto', strength: 'strong', forceCandidate: true, preserveBaseline: true,
    })
    // 明确哨兵基线（不是用编造的数值冒充基线）
    expect(c.upserts[0]!.input.baseline).toEqual(EMPTY_BASELINE)
    expect(c.records).toEqual([{ org: 'acme', id: 1, result: 'error' }])
    expect([...c.store.values()][0]!.status).toBe('candidate')
    expect(c.wmWrites).toEqual([TS1])
  })

  it('既有 verified 行 + 重放失败 ⇒ 好基线/status 不变，只记 last_check_result=error', async () => {
    const c = collect([hit()])
    await ingest(OPTS, c.deps)
    const key = [...c.store.keys()][0]!
    const before = { ...c.store.get(key)! }
    expect(before.status).toBe('verified')
    expect(before.baseline).toEqual(BASELINE)

    // 第二轮同一事件重投，重放失败（压缩水位后同微秒边界会被 >= 重读，正是要覆盖的场景）
    c.deps.replay = async () => ({
      status: 'denied', metricId: 'lemeng:retail:net_sales', reason: 'metric_not_declared',
    })
    await ingest(OPTS, c.deps)

    const after = c.store.get(key)!
    expect(after.status).toBe('verified')
    expect(after.baseline).toEqual(before.baseline)
    expect(c.upserts[c.upserts.length - 1]!.input).toMatchObject({ forceCandidate: true, preserveBaseline: true })
    expect(c.records).toEqual([{ org: 'acme', id: before.id, result: 'error' }])
  })

  it('重放抛异常 ⇒ 同样 candidate + error（异常与「口径红」都可辨、不猜）', async () => {
    const c = collect([hit()], {
      replay: async () => { throw new Error('warehouse down') },
    })
    const r = await ingest(OPTS, c.deps)

    expect(r.counters.replayError).toBe(1)
    expect(c.upserts[0]!.input).toMatchObject({ forceCandidate: true, preserveBaseline: true })
    expect(c.records).toEqual([{ org: 'acme', id: 1, result: 'error' }])
  })

  it('org 缺失 ⇒ 跳过并计数（不猜、不重放、不落库）', async () => {
    const c = collect([hit({ org: '' }), hit({ _timestamp: TS2, org: undefined })])
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ fetched: 2, skippedOrg: 2, written: 0 })
    expect(c.upserts).toHaveLength(0)
    expect(c.replays).toHaveLength(0)
    // 已检查过的记录不再重读；水位越过整批
    expect(c.wmWrites).toEqual([TS2])
  })

  it('未知租户按类型化 code 跳过（文案不参与判定）；普通「未知租户」文案不翻转行为', async () => {
    // 1) 类型化错误（文案故意不含「未知租户」）⇒ 跳过该条
    const typed = collect([hit()], {
      loadSources: async () => { throw new UnknownTenantError('ghost') },
    })
    const r = await ingest(OPTS, typed.deps)
    expect(r.counters).toMatchObject({ skippedUnknownTenant: 1, written: 0 })
    expect(typed.upserts).toHaveLength(0)
    expect(typed.wmWrites).toEqual([TS1])

    // 2) 等价 code 的普通对象（兼容其它模块抛法）
    const coded = collect([hit()], {
      loadSources: async () => {
        const err: any = new Error('tenant missing')
        err.code = 'UNKNOWN_TENANT'
        throw err
      },
    })
    expect((await ingest(OPTS, coded.deps)).counters.skippedUnknownTenant).toBe(1)

    // 3) 只有文案、没有 code ⇒ 不再被当成未知租户（必须炸整轮，不静默越过数据）
    const textOnly = collect([hit()], {
      loadSources: async () => { throw new Error('未知租户但无 code') },
    })
    await expect(ingest(OPTS, textOnly.deps)).rejects.toThrow(/未知租户但无 code/)
    expect(textOnly.wmWrites).toEqual([])
  })

  it('同一 _timestamp 的记录跨轮不丢（>= 水位；边界组重读靠唯一键幂等）', async () => {
    const a = hit({ _timestamp: TS1, metricId: 'lemeng:a', question: '问题 A', sessionId: 's1', seq: 1 })
    const b = hit({ _timestamp: TS1, metricId: 'lemeng:b', question: '问题 B', sessionId: 's2', seq: 2 })
    const batches = [[a], [a, b]]
    let round = 0
    const search = async ({ cursorUs }: any) => {
      expect(cursorUs).toBe(round === 0 ? null : TS1)
      const hits = batches[round] ?? []
      round += 1
      return { hits, total: hits.length }
    }
    const c = collect([], { search })
    await ingest(OPTS, c.deps)
    await ingest(OPTS, c.deps)

    const ids = c.upserts.map((u) => u.input.metricId)
    expect(ids).toContain('lemeng:a')
    expect(ids).toContain('lemeng:b')
    expect(c.store.size).toBe(2)
    // 第二轮 max(_timestamp) 与已存水位相同 ⇒ 不再写水位
    expect(c.wmWrites).toEqual([TS1])
  })

  it('缺 _timestamp 的毒丸记录只跳过该条（计数），不阻塞整轮/水位', async () => {
    const poison = hit({ _timestamp: 'bad', metricId: 'lemeng:poison' })
    const good = hit({ _timestamp: TS2 })
    const c = collect([poison, good])
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ fetched: 2, skippedBadTimestamp: 1, written: 1 })
    expect(c.upserts.map((u) => u.input.metricId)).toEqual(['lemeng:retail:net_sales'])
    expect(c.wmWrites).toEqual([TS2])

    // 整批都是毒丸：不抛错、不写水位（下轮会再报，计数可见）
    const only = collect([hit({ _timestamp: undefined })])
    const r2 = await ingest(OPTS, only.deps)
    expect(r2.counters).toMatchObject({ fetched: 1, skippedBadTimestamp: 1, written: 0 })
    expect(only.wmWrites).toEqual([])
  })

  it('params/slicing 缺省按 {} 继续，但计数可见（不静默吞契约缺口）', async () => {
    const c = collect([hit({ params: '', slicing: '   ' })])
    const r = await ingest(OPTS, c.deps)

    expect(r.counters).toMatchObject({ defaultedParams: 1, defaultedSlicing: 1, written: 1 })
    expect(c.upserts[0]!.input.params).toEqual({})
    expect(c.upserts[0]!.input.slicing).toEqual({})
  })

  it('--since 晚于已存水位 ⇒ 拒绝运行（不静默跳过区间）', async () => {
    const c = collect([hit()])
    c.deps.readWm = () => TS1
    await expect(ingest({ ...OPTS, sinceUs: TS2 }, c.deps)).rejects.toThrow(/--since.*水位/)
    expect(c.upserts).toHaveLength(0)
    expect(c.wmWrites).toEqual([])
  })

  it('水位成功后才前进：落库失败 ⇒ 抛错且不写水位；成功 ⇒ 推进到批次最大 _timestamp', async () => {
    const bad = collect([hit()], {
      upsert: async () => { throw new Error('db down') },
    })
    await expect(ingest(OPTS, bad.deps)).rejects.toThrow(/db down/)
    expect(bad.wmWrites).toEqual([])

    // 批次中途失败：前一条已写也必须整轮不落水位（否则重跑会跳过未处理的后一条）
    let calls = 0
    const partial = collect([hit({ _timestamp: TS1 }), hit({ _timestamp: TS2, metricId: 'lemeng:retail:sales' })], {
      upsert: async (_pool: any, org: string, input: any) => {
        calls += 1
        if (calls === 2) throw new Error('db down on second')
        return 1
      },
    })
    await expect(ingest(OPTS, partial.deps)).rejects.toThrow(/db down on second/)
    expect(partial.wmWrites).toEqual([])

    const good = collect([hit({ _timestamp: TS1 }), hit({ _timestamp: TS2 })])
    await ingest(OPTS, good.deps)
    expect(good.wmWrites).toEqual([TS2])
  })

  it('OO 查询失败 ⇒ 抛错且水位不动', async () => {
    const c = collect([])
    c.deps.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) })
    await expect(ingest(OPTS, c.deps)).rejects.toThrow(/HTTP 500/)
    expect(c.wmWrites).toEqual([])
  })

  it('--since 早于已有水位：重读旧事件但水位只前进不回退', async () => {
    const c = collect([hit({ _timestamp: TS1 })])
    c.deps.readWm = () => TS2 // 已有水位比这条记录新
    await ingest({ ...OPTS, sinceUs: TS1 - 1 }, c.deps)

    expect(c.upserts).toHaveLength(1)
    expect(c.wmWrites).toEqual([])
  })

  it('--dry-run：只统计不重放、不落库、不写水位', async () => {
    const c = collect([hit()])
    const r = await ingest({ ...OPTS, dryRun: true }, c.deps)

    expect(r.counters).toMatchObject({ fetched: 1, wouldIngest: 1, written: 0 })
    expect(c.replays).toHaveLength(0)
    expect(c.upserts).toHaveLength(0)
    expect(c.wmWrites).toEqual([])
  })
})

// ── 水位文件 ───────────────────────────────────────────────────────────────────

describe('水位文件', () => {
  it('不存在 ⇒ null；写入（含建目录）后可读回；默认路径按流一份', () => {
    expect(DEFAULT_WM_PATH).toBe('/var/lib/askdata/verify-ingest.askdata_verified.watermark')
    expect(defaultWmPath('other_stream')).toBe('/var/lib/askdata/verify-ingest.other_stream.watermark')
    const dir = mkdtempSync(join(tmpdir(), 'verify-ingest-'))
    try {
      const path = join(dir, 'nested', 'wm')
      expect(readWatermark(path)).toBeNull()
      writeWatermark(path, 1_793_836_800_000_000)
      expect(readWatermark(path)).toBe(1_793_836_800_000_000)
      expect(readFileSync(path, 'utf8').trim()).toBe('1793836800000000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── CLI 入口 ───────────────────────────────────────────────────────────────────

describe('main', () => {
  it('缺 OO_READ_* ⇒ exit 2（环境问题 ≠ 数据问题）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await main([], {})).toBe(2)
      expect(await main([], { OO_READ_URL: 'u', OO_READ_ORG: 'o' })).toBe(2)
      // 非 dry-run 还要求 DATABASE_URL
      expect(await main([], { OO_READ_URL: 'u', OO_READ_ORG: 'o', OO_READ_TOKEN: 't' })).toBe(2)
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })

  it('--dry-run 不要求 DATABASE_URL（跳过 DB/租户源校验）；有完整依赖时走通并返回 0', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const c = collect([hit()])
      let loads = 0
      const code = await main(
        ['--dry-run'],
        { OO_READ_URL: 'https://oo.test', OO_READ_ORG: 'oo-org', OO_READ_TOKEN: 't' },
        { ...c.deps, loadSources: async () => { loads += 1; return new Set(['lemeng']) } },
      )
      expect(code).toBe(0)
      expect(loads).toBe(0) // 无 DB ⇒ 不访问租户源（也不会 null.query）
      expect(c.upserts).toHaveLength(0)
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })

  it('--dry-run + 有 DATABASE_URL ⇒ 建池并做租户源校验（不再 null.query TypeError）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const c = collect([hit()])
      let loads = 0
      const code = await main(
        ['--dry-run'],
        {
          OO_READ_URL: 'https://oo.test', OO_READ_ORG: 'oo-org', OO_READ_TOKEN: 't',
          DATABASE_URL: 'postgres://fake',
        },
        {
          ...c.deps,
          loadSources: async () => { loads += 1; return new Set(['lemeng']) },
          pool: { end: async () => {} },
        },
      )
      expect(code).toBe(0)
      expect(loads).toBe(1)
      expect(c.upserts).toHaveLength(0)
      expect(c.wmWrites).toEqual([])
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })

  it('注入 pool 时 main 不自己建池（真跑一轮）', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const c = collect([hit()])
      const code = await main(
        [],
        {
          OO_READ_URL: 'https://oo.test', OO_READ_ORG: 'oo-org', OO_READ_TOKEN: 't',
          DATABASE_URL: 'postgres://fake',
        },
        { ...c.deps, pool: { end: async () => {} } },
      )
      expect(code).toBe(0)
      expect(c.upserts).toHaveLength(1)
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  })
})
