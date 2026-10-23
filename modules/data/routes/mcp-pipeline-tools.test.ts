// mcp-pipeline-tools.test.ts — 管理面「提案片」的行为（写总闸 + 审计单点 + 不认领返回 null）。
//
// 审计落库用真 PG（DATABASE_URL）；其余项不需要库。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { defaultPipelineWiring, makePipelineTools, verdictOf } from './mcp-pipeline-tools'
import type { McpDeps } from './mcp-rpc'
import type { Requester } from '../domain/authz'

const root = mkdtempSync(join(tmpdir(), 'pl-tools-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'pipelines'), { recursive: true })
writeFileSync(join(root, 'pipelines', 'lemeng.a.b.json'), JSON.stringify({
  name: 'lemeng.a.b', nodes: [{ id: 's', type: 'source', data: { componentId: 'src.rest' } }, { id: 'k', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/a.csv' } } }], edges: [],
}))

const requester: Requester = {
  userId: 'u', orgId: 'acme', channel: 'pat', keyId: 7, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
}
// 审计单点是**无条件**的（ok/denied/error 都写），所以假 pool 必须像一次成功的 insert：
// 回一行 `id/created_at`（writeAudit 的返回值要读它）。返回 `{ rows: [] }` 会让审计抛
// TypeError，把「审计写不进去」伪装成工具调用失败。
const depsOf = (over: Partial<McpDeps> = {}): McpDeps => ({
  pool: { query: async () => ({ rows: [{ id: 1, created_at: new Date() }] }) } as never,
  org: 'acme', requester, adoptedSources: new Set(), ...over,
})
const wiring = (env: Record<string, string | undefined> = {}) => ({
  roots: { pipelinesRoot: root, contractsRoot: join(root, 'contracts') }, env, runs: null,
})

describe('makePipelineTools.list', () => {
  it('空身份 ⇒ 空工具面', async () => {
    expect(await makePipelineTools(wiring()).list(depsOf({ requester: null }))).toEqual([])
  })
  it('持身份 ⇒ 7 个工具，且不外泄 requiredScope/mutating 等治理字段', async () => {
    const list = await makePipelineTools(wiring()).list(depsOf())
    expect(list.map((t) => t.name)).toHaveLength(7)
    for (const t of list) {
      expect('requiredScope' in t).toBe(false)
      expect('mutating' in t).toBe(false)
      expect(t.inputSchema).toMatchObject({ type: 'object' })
    }
  })
})

describe('makePipelineTools.call', () => {
  it('非本片工具 ⇒ null（交下一片）', async () => {
    const g = makePipelineTools(wiring())
    expect(await g.call(depsOf(), 'list_metrics', {})).toBeNull()
  })
  it('读工具正常派发', async () => {
    const g = makePipelineTools(wiring())
    const out = await g.call(depsOf(), 'list_pipelines', {})
    expect(out!.isError).toBe(false)
    expect(JSON.parse(out!.text)).toMatchObject({ status: 'ok', count: 1 })
  })
  it('写工具在总闸关时 denied/mutating_disabled（默认 false）', async () => {
    const g = makePipelineTools(wiring({ DATA_MCP_ALLOW_MUTATING: '' }))
    for (const name of ['run_pipeline_sandbox', 'propose_pipeline_change', 'propose_contract_change']) {
      const out = await g.call(depsOf(), name, {})
      expect(out!.isError).toBe(true)
      expect(JSON.parse(out!.text)).toMatchObject({ status: 'denied', reason: 'mutating_disabled', name })
    }
  })
  it('总闸开 ⇒ 写工具真正执行（非法入参仍是工具级错误）', async () => {
    const g = makePipelineTools(wiring({ DATA_MCP_ALLOW_MUTATING: 'true' }))
    const out = await g.call(depsOf(), 'propose_contract_change', { contract: {}, title: 't', rationale: 'r' })
    expect(JSON.parse(out!.text)).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
  })
  it('空身份调用任何工具 ⇒ denied/unauthenticated', async () => {
    const g = makePipelineTools(wiring())
    const out = await g.call(depsOf({ requester: null }), 'list_pipelines', {})
    expect(JSON.parse(out!.text)).toMatchObject({ status: 'denied', reason: 'unauthenticated' })
  })
  it('★ 审计写不进去 ⇒ 调用 reject（不被伪装成 tool_exception，也不写假错行）', async () => {
    const g = makePipelineTools(wiring())
    // impl 会成功；审计（reply）必须把**第一次**插入的错误往上抛。
    // 假 pool 刻意做成「只失败一次」：若谁把 reply 放回 try，catch 会再写一次审计（第二次成功）
    // 并回 {status:'error',reason:'tool_exception'} —— 本用例就会从 reject 变成 resolve 而红。
    // 用「永远 reject」的 pool 测不出这个结构差异（旧结构下第二次也 reject，照样 reject）。
    // 计数只认审计 INSERT（将来该 impl 若读库，不该把读查询算成「第二次审计」）。
    let auditInserts = 0
    const pool = {
      query: async (sql: unknown) => {
        if (typeof sql !== 'string' || !/insert\s+into\s+data\.query_audit/i.test(sql)) {
          return { rows: [] }
        }
        auditInserts += 1
        if (auditInserts === 1) throw new Error('boom')
        return { rows: [{ id: 1, created_at: new Date() }] }
      },
    } as never
    await expect(g.call(depsOf({ pool }), 'list_pipelines', {})).rejects.toThrow('boom')
    expect(auditInserts).toBe(1)   // 没有第二次 INSERT（也就不会有 error/tool_exception 假错行）
  })
})

describe('defaultPipelineWiring：运行记录来源按 env 决定', () => {
  it('DATA_RUN_DIRS 未配置 ⇒ runs=null（seam 语义不变）', () => {
    expect(defaultPipelineWiring({}).runs).toBeNull()
    expect(defaultPipelineWiring({ DATA_RUN_DIRS: '  ' }).runs).toBeNull()
  })
  it('配置了 ⇒ 接只读文件源', () => {
    expect(defaultPipelineWiring({ DATA_RUN_DIRS: '3120=/run/duckle-runs/3120' }).runs).not.toBeNull()
  })
})

describe('verdictOf：审计判决按 status 分类（unknown/not_found ≠ denied）', () => {
  it('unknown / not_found 即使 isError 也记 ok', () => {
    expect(verdictOf({ status: 'unknown', reason: 'runs_source_not_wired' }, true))
      .toEqual({ verdict: 'ok', reason: 'runs_source_not_wired' })
    expect(verdictOf({ status: 'not_found' }, true)).toEqual({ verdict: 'ok', reason: 'not_found' })
  })
  it('denied / refused / error 按 status（不看 isError）', () => {
    expect(verdictOf({ status: 'denied', reason: 'mutating_disabled' }, true))
      .toEqual({ verdict: 'denied', reason: 'mutating_disabled' })
    // refused = 草案没过校验、工具明确拒绝产出 ⇒ 也是「判了拒」（安全复核要能看出反复提非法草案）
    expect(verdictOf({ status: 'refused', reason: 'invalid_draft' }, true))
      .toEqual({ verdict: 'denied', reason: 'invalid_draft' })
    expect(verdictOf({ status: 'error', reason: 'tool_exception' }, true))
      .toEqual({ verdict: 'error', reason: 'tool_exception' })
  })
  it('not_executed（沙箱校验过了但没跑）⇒ ok + reason 透传（不是拒，也不等于跑过）', () => {
    expect(verdictOf({ status: 'not_executed', reason: 'sandbox_runner_unavailable' }, false))
      .toEqual({ verdict: 'ok', reason: 'sandbox_runner_unavailable' })
  })
  it('无 status 且 isError ⇒ denied/tool_error（未知形状不静默变 ok）', () => {
    expect(verdictOf({ detail: 'x' }, true)).toEqual({ verdict: 'denied', reason: 'tool_error' })
    expect(verdictOf({ detail: 'x' }, false)).toEqual({ verdict: 'ok', reason: '' })
  })
  it('ok 行 reason 为空串（写库时转 null）', () => {
    expect(verdictOf({ status: 'ok', count: 1 }, false)).toEqual({ verdict: 'ok', reason: '' })
  })
})

// ── 审计：真库（写 data.query_audit）────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
describePg('审计单点（需要 DATABASE_URL）', () => {
  const ORG = 'org-wave3-audit'
  const ORG_ANON = 'org-wave3-audit-anon'
  const pool = new Pool({ connectionString: dbUrl })
  // 上次运行崩溃可能留下残留行 ⇒ 精确数组断言会直接红。跑前先清（防 flaky）。
  beforeAll(async () => {
    await pool.query('delete from data.query_audit where org = any($1)', [[ORG, ORG_ANON]])
  })
  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = any($1)', [[ORG, ORG_ANON]])
    await pool.end()
  })
  it('每条调用（ok / not_found / unknown / denied）都落一行，verdict 不把「空」当「拒」', async () => {
    const g = makePipelineTools(wiring())
    const deps = depsOf({ pool, org: ORG })
    await g.call(deps, 'list_pipelines', {})
    await g.call(deps, 'get_pipeline', { id: 'nope' })
    await g.call(deps, 'list_pipeline_runs', {})
    await g.call(deps, 'propose_pipeline_change', { id: 'x' })
    const { rows } = await pool.query<{ tool: string; verdict: string; reason: string | null }>(
      'select tool, verdict, reason from data.query_audit where org = $1 order by id', [ORG])
    expect(rows.map((r) => r.tool)).toEqual([
      'list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'propose_pipeline_change'])
    // not_found（问的客体不存在）与 unknown（读不到）都是 **ok**；只有真被拒（写闸关）才是 denied。
    expect(rows.map((r) => r.verdict)).toEqual(['ok', 'ok', 'ok', 'denied'])
    // reason 是区分三种「空」的唯一抓手：'' 落 null，其余透传。
    expect(rows.map((r) => r.reason)).toEqual([null, 'not_found', 'runs_source_not_wired', 'mutating_disabled'])
  })

  it('空身份路径也落一行审计（userId = anonymous，verdict = denied）', async () => {
    const g = makePipelineTools(wiring())
    await g.call(depsOf({ pool, org: ORG_ANON, requester: null }), 'list_pipelines', {})
    const { rows } = await pool.query<{ user_id: string; tool: string; verdict: string; reason: string }>(
      'select user_id, tool, verdict, reason from data.query_audit where org = $1 order by id', [ORG_ANON])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: '(anonymous)', tool: 'list_pipelines', verdict: 'denied', reason: 'unauthenticated',
    })
  })
})
