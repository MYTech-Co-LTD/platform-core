import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from './index'
import { createFormsRouter } from './routes'

/** 假模型：按顺序回话（AI 起草测试用；不绑真供应商）。 */
function fakeModel(replies: string[]) {
  let i = 0
  return {
    async complete() {
      const r = replies[Math.min(i, replies.length - 1)]
      i += 1
      return r
    },
  }
}
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'

// API 面行为（issue #710）。⚠️ 计划注：**scope 门（如 manage 发 publish → 403）是宿主门卫
// 行为**——本测试壳不挂门卫（门卫在 apps/server/src/loader.ts，模块 import 宿主是分层违规），
// 该断言由 smoke 的真进程装配段（「模块 API 匿名不可达」）+ 宿主门卫既有测试覆盖；
// manifest 声明的正确性（publish 端点必须带 forms:publish）由 module.test 钉住。
// 本文件钉：org 钉死（主体只来自 identity）、机检错误码→状态码映射、业务链路。

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const SUF = Math.random().toString(36).slice(2, 8)
const ORG_A = `org-forms-routes-a-${SUF}`
const ORG_B = `org-forms-routes-b-${SUF}`
const ASSET = `form-${SUF}`

const schema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
}

// 探针互异（防假绿：两 org 必须分得开「谁的数据」）
expect(ORG_A).not.toBe(ORG_B)

describePg('forms API（routes）', () => {
  let pool: Pool
  let appA: Hono
  let appB: Hono

  const manageA = makeIdentity({ orgId: ORG_A, scopes: ['forms:manage'] })
  const publishA = makeIdentity({ orgId: ORG_A, userId: 'human-1', scopes: ['forms:publish'] })
  const fillA = makeIdentity({ orgId: ORG_A, userId: 'filler-1', scopes: ['forms:fill'] })
  const viewA = makeIdentity({ orgId: ORG_A, userId: 'viewer-1', scopes: ['forms:view'] })

  const reqA = (app: Hono, method: string, path: string, body?: unknown) =>
    app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) })

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    const ctx = { pool }
    appA = buildTestApp(mod, manageA, ctx)
    appB = buildTestApp(mod, makeIdentity({ orgId: ORG_B, scopes: ['forms:manage'] }), ctx)
  })

  afterAll(async () => {
    for (const [t, org] of [['submission', [ORG_A, ORG_B]], ['asset_head', [ORG_A, ORG_B]], ['asset_version', [ORG_A, ORG_B]], ['dict_item', [ORG_A, ORG_B]], ['mcp_audit', [ORG_A, ORG_B]]] as const) {
      await pool.query(`delete from forms.${t} where org = any($1)`, [org]).catch(() => {})
    }
    await pool.end()
  })

  it('全链：起草(manage) → 发布(publish) → 提交(fill) → 读回(含钉住版本契约)', async () => {
    let res = await reqA(appA, 'POST', '/defs', { assetId: ASSET, body: { schema } })
    expect(res.status).toBe(201)
    expect((await res.json()).version).toBe(1)

    res = await reqA(await appAs(publishA), 'POST', `/defs/${ASSET}/versions/1/publish`)
    expect(res.status).toBe(200)

    res = await reqA(await appAs(fillA), 'POST', `/defs/${ASSET}/submissions`, { payload: { name: '李四' } })
    expect(res.status).toBe(201)
    const { id, version } = (await res.json()) as { id: string; version: number }
    expect(version).toBe(1)

    res = await reqA(await appAs(viewA), 'GET', `/submissions/${id}`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { submission: { submittedBy: string; payload: unknown }; contract: unknown }
    expect(payload.submission.submittedBy).toBe('filler-1')
    expect(payload.submission.payload).toEqual({ name: '李四' })
    expect(payload.contract).toEqual({ schema }) // 回执带钉住版本契约（渲染历史按当时版本）
  })

  // 辅助：同一身份换壳（buildTestApp 按身份注入）
  async function appAs(identity: ReturnType<typeof makeIdentity>): Promise<Hono> {
    return buildTestApp(mod, identity, { pool })
  }

  it('org 钉死：B org 列表空、直敲 A 的提交 id → 404（主体只来自身份解析）', async () => {
    let res = await (await appAs(makeIdentity({ orgId: ORG_B, scopes: ['forms:view'] }))).request(`/defs/${ASSET}`)
    expect(res.status).toBe(404)
    res = await (await appAs(makeIdentity({ orgId: ORG_B, scopes: ['forms:view'] }))).request('/defs')
    const body = (await res.json()) as { defs: unknown[] }
    expect(body.defs).toEqual([])
    // A 的 submission id：先取一条，再用 B 的身份读
    const list = await (await reqA(await appAs(viewA), 'GET', `/defs/${ASSET}/submissions`)).json() as { submissions: Array<{ id: string }> }
    expect(list.submissions.length).toBeGreaterThan(0)
    res = await (await appAs(makeIdentity({ orgId: ORG_B, scopes: ['forms:view'] }))).request(`/submissions/${list.submissions[0].id}`)
    expect(res.status).toBe(404)
  })

  it('错误码映射：RESERVED_KEY/UNKNOWN_FIELD → 400（不静默忽略）', async () => {
    for (const payload of [{ name: 'x', org: 'evil' }, { name: 'x', hacker: 1 }]) {
      const res = await reqA(await appAs(fillA), 'POST', `/defs/${ASSET}/submissions`, { payload })
      expect(res.status, JSON.stringify(payload)).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(['RESERVED_KEY', 'UNKNOWN_FIELD']).toContain(body.error)
    }
  })

  it('AI 起草（#724）：未配 LLM → 503 LLM_NOT_CONFIGURED（可解释，不是 500）', async () => {
    const res = await reqA(appA, 'POST', '/generate', { description: '门店巡检' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('LLM_NOT_CONFIGURED')
  })

  it('AI 起草：描述缺失/超长 → 400（有界写入）', async () => {
    const gen = buildTestApp({ manifest: mod.manifest, createRouter: () => createFormsRouter({ pool, chatModel: fakeModel(['x']) }) } as never, manageA, { pool })
    for (const [body, code] of [
      [{}, 'DESCRIPTION_REQUIRED'],
      [{ description: '   ' }, 'DESCRIPTION_REQUIRED'],
      [{ description: 'x'.repeat(2001) }, 'DESCRIPTION_TOO_LONG'],
    ] as const) {
      const res = await reqA(gen, 'POST', '/generate', body)
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(code)
    }
  })

  it('AI 起草全链：描述 → 契约草案 → 落 draft（未发布）；重名 → 409 不覆盖', async () => {
    const aiAsset = `ai-${SUF}`
    const reply = JSON.stringify({
      assetId: aiAsset,
      schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] },
      uiSchema: { name: { 'ui:placeholder': '请输入' } },
    })
    const gen = buildTestApp({ manifest: mod.manifest, createRouter: () => createFormsRouter({ pool, chatModel: fakeModel([reply]) }) } as never, manageA, { pool })
    const res = await reqA(gen, 'POST', '/generate', { description: '门店巡检登记' })
    expect(res.status).toBe(201)
    const out = (await res.json()) as { assetId: string; version: number; repairUsed: boolean; body: { schema: unknown } }
    expect(out.assetId).toBe(aiAsset)
    expect(out.version).toBe(1)
    expect(out.repairUsed).toBe(false)
    expect(out.body.schema).toBeTruthy()

    // 落库了，但**只是 draft**——表里 head 为空（AI 永不发布）
    const detail = await (await reqA(appA, 'GET', `/defs/${aiAsset}`)).json() as { head: number | null; versions: { status: string }[] }
    expect(detail.head).toBeNull()
    expect(detail.versions.map((v) => v.status)).toEqual(['draft'])

    // 重名（同 assetId）再起草 → 409，不静默新建版本
    const again = await reqA(gen, 'POST', '/generate', { description: '另一个表' })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toBe('ASSET_ID_TAKEN')
  })

  it('★ AI 起草防假绿：模型两轮都吐坏契约 → 422 且**库里一笔 draft 都不落**', async () => {
    const bad = JSON.stringify({
      assetId: `bad-${SUF}`,
      schema: { type: 'object', properties: { region: { type: 'string', title: '地区' } } },
      uiSchema: { region: { 'ui:widget': 'cascader' } }, // 渲染层不认识
    })
    const gen = buildTestApp({ manifest: mod.manifest, createRouter: () => createFormsRouter({ pool, chatModel: fakeModel([bad, bad]) }) } as never, manageA, { pool })
    const res = await reqA(gen, 'POST', '/generate', { description: '省市区三级联动' })
    expect(res.status).toBe(422)
    const out = (await res.json()) as { error: string; detail: string }
    expect(out.error).toBe('CONTRACT_REJECTED')
    expect(out.detail).toContain('UNSUPPORTED_WIDGET')

    const after = await reqA(appA, 'GET', `/defs/bad-${SUF}`)
    expect(after.status).toBe(404) // 坏契约没有落库
  })

  it('MCP 管理面（#724）：initialize/tools.list/tools.call 全链；通知回 202；未知方法 -32601', async () => {
    const mcpAsset = `mcp-${SUF}`
    const reply = JSON.stringify({
      assetId: mcpAsset,
      schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] },
    })
    const gen = buildTestApp({ manifest: mod.manifest, createRouter: () => createFormsRouter({ pool, chatModel: fakeModel([reply]) }) } as never, manageA, { pool })
    const call = (body: unknown) => gen.request('/mcp-manage', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

    let res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(res.status).toBe(200)
    const init = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.serverInfo.name).toBe('platform-forms-mcp-manage')

    res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = (await res.json()) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['list_forms', 'generate_form_draft'])

    res = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_form_draft', arguments: { description: '门店巡检登记' } } })
    const out = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect(out.result.isError).toBe(false)
    const payload = JSON.parse(out.result.content[0].text) as { assetId: string; version: number; status: string }
    expect(payload).toMatchObject({ assetId: mcpAsset, version: 1, status: 'draft' })

    // 通知（无 id）→ 202 空体
    res = await call({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)

    // 未知方法 → JSON-RPC 错误信封（HTTP 200）
    res = await call({ jsonrpc: '2.0', id: 9, method: 'nope' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32601)
  })

  it('导出面（M1.4 #729）：键集游标不重不漏；org 隔离；参数越界 400', async () => {
    const expAsset = `exp-${SUF}`
    await reqA(appA, 'POST', '/defs', { assetId: expAsset, body: { schema } })
    await reqA(await appAs(publishA), 'POST', `/defs/${expAsset}/versions/1/publish`)
    // 造 3 笔提交
    for (const n of ['甲', '乙', '丙']) {
      const r = await reqA(await appAs(fillA), 'POST', `/defs/${expAsset}/submissions`, { payload: { name: n } })
      expect(r.status).toBe(201)
    }
    const all = await (await reqA(await appAs(viewA), 'GET', `/defs/${expAsset}/submissions`)).json() as { submissions: { id: string; version: number; assetId: string }[] }
    expect(all.submissions.length).toBeGreaterThanOrEqual(3)

    // 全量拉（after_id=0）→ 含本租户全部资产的行；形状齐
    const page1 = await (await reqA(await appAs(viewA), 'GET', '/export/submissions?after_id=0&limit=1000')).json() as
      { rows: { submission_id: string; org: string; form_def_id: string; submitted_at: string; payload: { name: string } }[]; next_after_id: string; has_more: boolean }
    expect(page1.rows.length).toBeGreaterThanOrEqual(3)
    expect(page1.rows.every((r) => r.org === ORG_A)).toBe(true) // 只本租户
    const mine = page1.rows.filter((r) => r.form_def_id === expAsset)
    expect(mine.map((r) => r.payload.name).sort()).toEqual(['丙', '乙', '甲'].sort())
    // 键集序：id 升序
    const ids = page1.rows.map((r) => Number(r.submission_id))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))

    // 游标：逐条翻页 ⇒ 并集 == 全量、且无重复（不重不漏）
    const seen: string[] = []
    let cursor = '0'
    for (let i = 0; i < 20; i++) {
      const p = await (await reqA(await appAs(viewA), 'GET', `/export/submissions?after_id=${cursor}&limit=1`)).json() as
        { rows: { submission_id: string }[]; next_after_id: string; has_more: boolean }
      if (p.rows.length === 0) break
      seen.push(p.rows[0].submission_id)
      cursor = p.next_after_id
      if (!p.has_more) break
    }
    expect(new Set(seen).size).toBe(seen.length) // 无重复
    expect(seen).toEqual(page1.rows.map((r) => r.submission_id)) // 与全量逐条相同（无漏）

    // 追平后：无行、游标不动
    const drained = await (await reqA(await appAs(viewA), 'GET', `/export/submissions?after_id=${cursor}&limit=10`)).json() as
      { rows: unknown[]; next_after_id: string; has_more: boolean }
    expect(drained.rows).toEqual([])
    expect(drained.next_after_id).toBe(cursor)
    expect(drained.has_more).toBe(false)

    // org 隔离：B 租户拉不到 A 的行
    const bRows = await (await reqA(await appAs(makeIdentity({ orgId: ORG_B, scopes: ['forms:view'] })), 'GET', '/export/submissions?after_id=0&limit=1000')).json() as { rows: unknown[] }
    expect(bRows.rows).toEqual([])

    // 参数越界
    for (const q of ['after_id=x', 'after_id=-1', 'limit=0', `limit=${2001}`, 'limit=abc']) {
      const r = await reqA(await appAs(viewA), 'GET', `/export/submissions?${q}`)
      expect(r.status, q).toBe(400)
    }
  })

  it('readOnly 服务端复验（#722）：契约声明 readOnly 的字段→400 READONLY_FIELD；不带→放行', async () => {
    const roAsset = `ro-${SUF}`
    const roSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: '姓名' },
        storeNo: { type: 'string', title: '门店号', readOnly: true },
      },
      required: ['name'],
    }
    await reqA(appA, 'POST', '/defs', { assetId: roAsset, body: { schema: roSchema } })
    await reqA(await appAs(publishA), 'POST', `/defs/${roAsset}/versions/1/publish`)

    const denied = await reqA(await appAs(fillA), 'POST', `/defs/${roAsset}/submissions`, {
      payload: { name: '张三', storeNo: 'S001' },
    })
    expect(denied.status).toBe(400)
    expect(((await denied.json()) as { error: string }).error).toBe('READONLY_FIELD')

    const ok = await reqA(await appAs(fillA), 'POST', `/defs/${roAsset}/submissions`, { payload: { name: '张三' } })
    expect(ok.status).toBe(201)
  })

  it('发布门编译闸：draft 期自由，publish 时坏契约 → 400 指到方言/编译', async () => {
    await reqA(appA, 'POST', '/defs', { assetId: `bad-${SUF}`, body: { schema: { type: 'object', properties: { a: { type: 'stringo' } } } } })
    let res = await reqA(await appAs(publishA), 'POST', `/defs/bad-${SUF}/versions/1/publish`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('SCHEMA_COMPILE')

    await reqA(appA, 'POST', '/defs', { assetId: `dialect-${SUF}`, body: { schema: { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' } } })
    res = await reqA(await appAs(publishA), 'POST', `/defs/dialect-${SUF}/versions/1/publish`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('SCHEMA_DIALECT')
  })

  it('生命周期冲突 → 409 LIFECYCLE_CONFLICT（重复发布同一 draft）', async () => {
    await reqA(appA, 'POST', '/defs', { assetId: `twice-${SUF}`, body: { schema } })
    await reqA(await appAs(publishA), 'POST', `/defs/twice-${SUF}/versions/1/publish`)
    const res = await reqA(await appAs(publishA), 'POST', `/defs/twice-${SUF}/versions/1/publish`)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('LIFECYCLE_CONFLICT')
  })

  it('无发布版本提交 → 409 NO_PUBLISHED_HEAD；不存在资产 → 404', async () => {
    await reqA(appA, 'POST', '/defs', { assetId: `nohead-${SUF}`, body: { schema } })
    const res = await reqA(await appAs(fillA), 'POST', `/defs/nohead-${SUF}/submissions`, { payload: { name: 'x' } })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('NO_PUBLISHED_HEAD')

    const res404 = await reqA(await appAs(viewA), 'GET', `/defs/never-existed`)
    expect(res404.status).toBe(404)
    expect(((await res404.json()) as { error: string }).error).toBe('ASSET_NOT_FOUND')
  })

  it('字典端点：manage 写 / view 读 / resolve 与 options', async () => {
    let res = await reqA(appA, 'POST', '/dicts', { dictId: `d-${SUF}`, key: 'k1', label: '甲' })
    expect(res.status).toBe(201)
    res = await (await appAs(viewA)).request(`/dicts/d-${SUF}/options`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { options: Array<{ key: string }> }).options.map((o) => o.key)).toEqual(['k1'])

    res = await reqA(await appAs(manageA), 'PUT', `/dicts/d-${SUF}/keys/k1`, { enabled: false })
    expect(res.status).toBe(200)
    res = await (await appAs(viewA)).request(`/dicts/d-${SUF}/resolve?keys=k1`)
    const resolved = (await res.json()) as { resolved: Record<string, { label: string; enabled: boolean }> }
    expect(resolved.resolved['k1']).toEqual({ label: '甲', enabled: false }) // 退役值可渲染历史

    res = await reqA(await appAs(manageA), 'PUT', `/dicts/d-${SUF}/keys/nope`, { label: 'x' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('DICT_KEY_NOT_FOUND')
  })

  it('全局字典端点：global-manage 写、无 org 维度（P4 单列）', async () => {
    const gManage = makeIdentity({ orgId: ORG_A, userId: 'platform-admin', scopes: ['forms:global-manage'] })
    let res = await reqA(await appAs(gManage), 'POST', '/global-dicts', { dictId: `g-${SUF}`, key: 'gk', label: '全局' })
    expect(res.status).toBe(201)
    res = await (await appAs(viewA)).request(`/global-dicts/g-${SUF}/options`)
    expect(((await res.json()) as { options: Array<{ key: string }> }).options.map((o) => o.key)).toEqual(['gk'])
    // 全局字典对所有 org 可见（B org 的 view 身份也读得到）
    res = await (await appAs(makeIdentity({ orgId: ORG_B, scopes: ['forms:view'] }))).request(`/global-dicts/g-${SUF}/options`)
    expect(((await res.json()) as { options: Array<{ key: string }> }).options.map((o) => o.key)).toEqual(['gk'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 审批（OA P1 / issue #2363）：模板 dry-run/发布门、提交建 case、代理授权、回调幂等、撤回
// ════════════════════════════════════════════════════════════════════════════
describePg('forms 审批（OA P1）', () => {
  let pool: Pool
  let engine: ReturnType<typeof makeEngine>
  let emitted: Array<{ eventKey: string; eventId: string; payload: Record<string, unknown> }>
  let notify: { emit: (identity: unknown, input: never) => Promise<{ accepted: boolean }> }

  const OA_ORG = `org-forms-oa-${SUF}`
  const TEMPLATE = `leave-${SUF}`
  const ITEM = `leave-item-${SUF}`

  const orgPort = {
    async listSubtreeMembers() { return ['u1', 'u-lead'] },
    async listDeptLeaders() { return ['u-lead'] },
    async listDeptAdmins() { return ['u-admin'] },
    async listRoleMembers(_org: string, role: string) { return role === 'hr' ? ['u-hr'] : [] },
    async primaryDeptOf(_org: string, user: string) { return user === 'u-nodept' ? null : 'dept-10' },
  }

  function makeEngine() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const cases = new Map<string, Record<string, unknown>>()
    let n = 0
    const client = {
      async createCase(body: Record<string, unknown>) {
        calls.push({ url: '/cases', body })
        const caseId = `case-${++n}`
        cases.set(caseId, { caseId, currentNode: 'leader', body })
        return { caseId, runId: 'run-1' }
      },
      async getCase(id: string, org: string) {
        // 查询面：org 走 query（case-engine #122 / T9 要求每次调用都携 org）
        calls.push({ url: `/cases/${id}`, body: { org } })
        return cases.get(id) ?? { currentNode: 'leader' }
      },
      async listCases(_org: string) { return [] },
      async decide(id: string, org: string, body: Record<string, unknown>) {
        calls.push({ url: `/cases/${id}/decision`, body: { ...body, org } })
        return { ok: true }
      },
      async withdraw(id: string, org: string, body: Record<string, unknown>) {
        calls.push({ url: `/cases/${id}/withdraw`, body: { ...body, org } })
        return { ok: true }
      },
    }
    return { calls, client }
  }

  const identity = (userId: string, scopes: string[]) => makeIdentity({ orgId: OA_ORG, userId, scopes })
  const mgr = () => identity('u-mgr', ['forms:view', 'forms:manage', 'forms:publish', 'forms:approval:view', 'forms:approval:manage', 'forms:approval:publish'])
  const publisher = () => identity('u-pub', ['forms:approval:view', 'forms:approval:publish'])
  const filler = () => identity('u1', ['forms:fill', 'forms:view'])
  const approver = () => identity('u-lead', ['forms:fill', 'forms:view'])
  const stranger = () => identity('u-stranger', ['forms:fill', 'forms:view'])
  const service = () => identity('case-engine', ['forms:case:callback'])
  /** 平台管理员（forms:global-manage 是 platformOnly；租户管理员授权宇宙里没有它）。 */
  const platformAdmin = () => identity('u-platform', ['forms:global-manage', 'forms:approval:view'])

  const appFor = (who: ReturnType<typeof makeIdentity>, opts: { engineFor?: () => Promise<unknown> } = {}) =>
    buildTestApp({
      manifest: mod.manifest,
      createRouter: () => createFormsRouter({
        pool,
        orgPort,
        notify: notify as never,
        engineFor: (opts.engineFor ?? (async () => engine.client)) as never,
      }),
    } as never, who, { pool })

  const req = (app: Hono, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    })

  const subCount = async (): Promise<number> => {
    const { rows } = await pool.query(
      "select count(*)::int n from forms.submission where org=$1 and kind='form_def'", [OA_ORG])
    return rows[0].n
  }

  const validBody = {
    provider: 'inapp',
    nodes: [
      { key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }], quorum: 'all' },
      {
        key: 'hr', title: 'HR', approvers: [{ source: 'role', role: 'hr' }], quorum: 'any',
      },
    ],
    conditions: [{
      when: { field: 'amount', op: 'gt', value: 5000 },
      addNode: { key: 'cfo', title: '财务负责人', approvers: [{ source: 'role', role: 'hr' }], quorum: 'all' },
    }],
    rejectionPolicy: 'first_reject_ends',
    selfApproval: 'skip',
    dedupe: 'first_occurrence',
  }

  const itemBody = (templateVersion = 1) => ({
    mode: 'approval',
    schema: {
      type: 'object',
      properties: { reason: { type: 'string' }, amount: { type: 'number' } },
      required: ['reason'],
    },
    approvalRef: { id: TEMPLATE, version: templateVersion },
    provider: 'inapp',
  })

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    engine = makeEngine()
    emitted = []
    notify = {
      async emit(_identity: unknown, input: never) {
        emitted.push(input)
        return { accepted: true }
      },
    }
  })

  afterAll(async () => {
    for (const t of ['submission', 'audit', 'asset_head', 'asset_version', 'dict_item']) {
      await pool.query(`delete from forms.${t} where org = $1`, [OA_ORG]).catch(() => {})
    }
    await pool.end()
  })

  it('审批模板：起草(manage) → dry-run → publish(publish)，head 指到发布版本；条件节点参与编译', async () => {
    let res = await req(appFor(mgr()), 'POST', '/approval-defs', { assetId: TEMPLATE, body: validBody })
    expect(res.status).toBe(201)

    res = await req(appFor(mgr()), 'POST', `/approval-defs/${TEMPLATE}/dry-run`, {
      payload: { amount: 6000 }, requester: 'u1',
    })
    expect(res.status).toBe(200)
    const dry = (await res.json()) as { plan: { nodes: Array<{ key: string; approvers: string[] }>; appliedConditions: string[] } }
    expect(dry.plan.nodes.map((n) => n.key)).toEqual(['leader', 'hr', 'cfo'])
    expect(dry.plan.nodes[0].approvers).toEqual(['u-lead'])
    expect(dry.plan.appliedConditions).toEqual(['cfo'])

    // 未命中的条件不追加
    res = await req(appFor(mgr()), 'POST', `/approval-defs/${TEMPLATE}/dry-run`, {
      payload: { amount: 100 }, requester: 'u1',
    })
    expect(((await res.json()) as { plan: { nodes: Array<{ key: string }> } }).plan.nodes.map((n) => n.key))
      .toEqual(['leader', 'hr'])

    res = await req(appFor(publisher()), 'POST', `/approval-defs/${TEMPLATE}/versions/1/publish`, { payload: { amount: 100 } })
    expect(res.status).toBe(200)

    res = await req(appFor(mgr()), 'GET', `/approval-defs/${TEMPLATE}`)
    expect(((await res.json()) as { head: number | null }).head).toBe(1)

    // 发布审计带了计划快照（spec §8.3）
    const { rows } = await pool.query(
      "select detail from forms.audit where org=$1 and action='approval.publish' and target=$2 order by id desc limit 1",
      [OA_ORG, TEMPLATE])
    expect(rows[0].detail.version).toBe(1)
    expect(rows[0].detail.plan.nodes.length).toBeGreaterThan(0)
  })

  it('dry-run 失败（发起人无主部门）⇒ publish 409 且 head 不变（版本仍是 draft）', async () => {
    const asset = `nodept-${SUF}`
    await req(appFor(mgr()), 'POST', '/approval-defs', {
      assetId: asset,
      body: { provider: 'inapp', nodes: [{ key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }] }] },
    })
    const res = await req(appFor(publisher()), 'POST', `/approval-defs/${asset}/versions/1/publish`, {
      requester: 'u-nodept',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('APPROVERS_UNRESOLVED')

    const detail = await (await req(appFor(mgr()), 'GET', `/approval-defs/${asset}`)).json() as
      { head: number | null; versions: Array<{ status: string }> }
    expect(detail.head).toBeNull()
    expect(detail.versions.map((v) => v.status)).toEqual(['draft'])
  })

  it('发布门：坏 DSL → 400（NODES_EMPTY）；空节点（全解析为空）→ 409 EMPTY_NODE', async () => {
    const bad = `bad-${SUF}`
    await req(appFor(mgr()), 'POST', '/approval-defs', { assetId: bad, body: { provider: 'inapp', nodes: [] } })
    let res = await req(appFor(publisher()), 'POST', `/approval-defs/${bad}/versions/1/publish`, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('NODES_EMPTY')

    const empty = `emptynode-${SUF}`
    await req(appFor(mgr()), 'POST', '/approval-defs', {
      assetId: empty,
      body: { provider: 'inapp', nodes: [{ key: 'self', title: '自己', approvers: [{ source: 'user', users: ['u-pub'] }] }] },
    })
    res = await req(appFor(publisher()), 'POST', `/approval-defs/${empty}/versions/1/publish`, {})
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('EMPTY_NODE')
  })

  it('标准审批绑定（P2）：平台管理员建/发绑定；事项模板 schema=null 可发布；非平台管理员发绑定 403', async () => {
    const binding = `expense-bind-${SUF}`
    const bindingBody = {
      provider: 'wecom_native',
      processCode: 'PC-EXPENSE-001',
      deepLink: 'https://open.work.weixin.qq.com/oa/approval?template=PC-EXPENSE-001',
      name: '差旅报销（企微标准审批）',
      verifiedChain: ['2026-11-16 真机提交 SP-01 → 回调到达'],
      verifiedAt: '2026-11-16T10:00:00Z',
    }

    let res = await req(appFor(platformAdmin()), 'POST', '/approval-bindings', {
      assetId: binding, body: bindingBody,
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { version: number }).version).toBe(1)

    // 绑定不完整 ⇒ 400（缺 deepLink/verifiedAt 等）
    res = await req(appFor(platformAdmin()), 'POST', '/approval-bindings', {
      assetId: `bad-bind-${SUF}`,
      body: { provider: 'wecom_native', processCode: 'PC-BAD' },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('BINDING_INCOMPLETE')

    // 普通审批发布 scope（forms:approval:publish）不能发布绑定 ⇒ 403（发布门只属平台管理员）
    res = await req(appFor(publisher()), 'POST', `/approval-bindings/${binding}/versions/1/publish`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('FORBIDDEN')

    res = await req(appFor(platformAdmin()), 'POST', `/approval-bindings/${binding}/versions/1/publish`)
    expect(res.status).toBe(200)

    // 列表只出绑定资产（应用内审批模板不在内）
    res = await req(appFor(platformAdmin()), 'GET', '/approval-bindings')
    const list = (await res.json()) as { bindings: Array<{ assetId: string }> }
    expect(list.bindings.map((b) => b.assetId)).toContain(binding)
    expect(list.bindings.map((b) => b.assetId)).not.toContain(TEMPLATE)

    // 事项模板 provider=wecom_native 且 schema=null，引用**已发布**绑定 ⇒ 可发布
    const item = `expense-item-${SUF}`
    res = await req(appFor(mgr()), 'POST', '/defs', {
      assetId: item,
      body: { mode: 'approval', provider: 'wecom_native', schema: null, approvalRef: { id: binding, version: 1 } },
    })
    expect(res.status).toBe(201)
    res = await req(appFor(mgr()), 'POST', `/defs/${item}/versions/1/publish`)
    expect(res.status).toBe(200)

    // 引用不存在的绑定版本 ⇒ 409，不落发布
    const item2 = `expense-item2-${SUF}`
    await req(appFor(mgr()), 'POST', '/defs', {
      assetId: item2,
      body: { mode: 'approval', provider: 'wecom_native', schema: null, approvalRef: { id: binding, version: 2 } },
    })
    res = await req(appFor(mgr()), 'POST', `/defs/${item2}/versions/1/publish`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('APPROVAL_BINDING_NOT_FOUND')

    // 绑定退役 ⇒ 引用它的模板不能**新**发布。
    // （DB 触发器不许 retire head：先出 v2 并发布，再把 v1 退役）
    res = await req(appFor(platformAdmin()), 'POST', '/approval-bindings', { assetId: binding, body: bindingBody })
    expect(res.status).toBe(201)
    res = await req(appFor(platformAdmin()), 'POST', `/approval-bindings/${binding}/versions/2/publish`)
    expect(res.status).toBe(200)
    await pool.query('select forms.retire($1,$2,$3,$4)', [OA_ORG, 'approval_def', binding, 1])
    const item3 = `expense-item3-${SUF}`
    await req(appFor(mgr()), 'POST', '/defs', {
      assetId: item3,
      body: { mode: 'approval', provider: 'wecom_native', schema: null, approvalRef: { id: binding, version: 1 } },
    })
    res = await req(appFor(mgr()), 'POST', `/defs/${item3}/versions/1/publish`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('APPROVAL_BINDING_NOT_PUBLISHED')
  })

  it('审批提交：写 pending_approval + 计划快照 → 建引擎 case（externalRef）→ 回填 case_ref', async () => {
    let res = await req(appFor(mgr()), 'POST', '/defs', { assetId: ITEM, body: itemBody() })
    expect(res.status).toBe(201)
    res = await req(appFor(mgr()), 'POST', `/defs/${ITEM}/versions/1/publish`)
    expect(res.status).toBe(200)

    const before = engine.calls.length
    res = await req(appFor(filler()), 'POST', `/defs/${ITEM}/submissions`, {
      payload: { reason: '家事', amount: 6000 },
    })
    expect(res.status).toBe(201)
    const out = (await res.json()) as { id: string; caseId: string; status: string }
    expect(out.status).toBe('pending_approval')

    const { rows } = await pool.query('select * from forms.submission where org=$1 and id=$2', [OA_ORG, out.id])
    expect(rows[0].status).toBe('pending_approval')
    expect(rows[0].provider).toBe('inapp')
    expect(rows[0].case_ref).toBe(out.caseId)
    expect(rows[0].approval_plan.nodes.map((n: { key: string }) => n.key)).toEqual(['leader', 'hr', 'cfo'])

    expect(engine.calls.length).toBe(before + 1)
    const created = engine.calls.at(-1)!
    expect(created.url).toBe('/cases')
    expect(created.body).toMatchObject({
      org: OA_ORG,
      externalRef: `forms:submission:${out.id}`,
      planVersion: 1,
      provider: 'inapp',
      type: 'approval',
      requesterId: 'u1',
      title: `${ITEM} - 测试用户`,
    })
    // 计划快照与库里一致（在途单按提交时的计划执行，不受模板改版影响）
    expect((created.body.plan as { nodes: Array<{ key: string }> }).nodes.map((n) => n.key)).toEqual(['leader', 'hr', 'cfo'])
  })

  it('审批代理：mine 只列我的；detail 授权（审批人/陌生人）；decision 校验当前节点与意见', async () => {
    const mine = await (await req(appFor(approver()), 'GET', '/approvals/mine')).json() as
      { approvals: Array<{ title: string; caseId: string | null; nodeTitle: string }> }
    expect(mine.approvals.length).toBe(1)
    expect(mine.approvals[0].title).toBe(`${ITEM} - u1`)
    expect(mine.approvals[0].nodeTitle).toBe('直属主管')

    const strangers = await (await req(appFor(stranger()), 'GET', '/approvals/mine')).json() as { approvals: unknown[] }
    expect(strangers.approvals).toEqual([])

    const caseId = mine.approvals[0].caseId!
    let res = await req(appFor(approver()), 'GET', `/approvals/${caseId}`)
    expect(res.status).toBe(200)
    const detail = (await res.json()) as { submission: { status: string }; case: { currentNode: string }; contract: unknown }
    expect(detail.submission.status).toBe('pending_approval')
    expect(detail.case.currentNode).toBe('leader')
    expect(detail.contract).toMatchObject({ schema: itemBody().schema })
    // 引擎查询面必须携 org（T9 org 校验；缺省即 403）
    expect(engine.calls.filter((c) => c.url === `/cases/${caseId}`).at(-1)!.body).toMatchObject({ org: OA_ORG })

    res = await req(appFor(stranger()), 'GET', `/approvals/${caseId}`)
    expect(res.status).toBe(403)

    res = await req(appFor(stranger()), 'POST', `/approvals/${caseId}/decision`, { action: 'approve' })
    expect(res.status).toBe(403)

    // 驳回必须填意见（服务端强制；前端只是把按钮禁用）
    res = await req(appFor(approver()), 'POST', `/approvals/${caseId}/decision`, { action: 'reject' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('COMMENT_REQUIRED')

    // 非当前节点 key → 409（防前端拿旧页面乱点）
    res = await req(appFor(approver()), 'POST', `/approvals/${caseId}/decision`, { action: 'approve', nodeKey: 'hr' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('NOT_CURRENT_NODE')

    res = await req(appFor(approver()), 'POST', `/approvals/${caseId}/decision`, { action: 'approve' })
    expect(res.status).toBe(200)
    const decideCall = engine.calls.filter((c) => c.url === `/cases/${caseId}/decision`).at(-1)!
    expect(decideCall.body).toMatchObject({ nodeKey: 'leader', action: 'approve', decidedBy: 'u-lead', org: OA_ORG })
  })

  it('回调：终态幂等（第二次 deduped，decided_at 不变）+ 通知事件一次；org 不一致 403', async () => {
    const { rows } = await pool.query(
      "select id, case_ref from forms.submission where org=$1 and status='pending_approval' limit 1", [OA_ORG])
    const { id, case_ref: caseId } = rows[0]
    const body = {
      org: OA_ORG, caseId, externalRef: `forms:submission:${id}`, final: true,
      action: 'approved', decidedBy: 'u-hr', decidedAt: '2026-11-16T00:00:00Z', comment: '准',
      submitter: 'u1',
    }

    let res = await req(appFor(service()), 'POST', '/approval-callback', body)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { submissionId: string }).submissionId).toBe(String(id))
    const first = await pool.query('select status, decided_at from forms.submission where id=$1', [id])
    expect(first.rows[0].status).toBe('approved')

    res = await req(appFor(service()), 'POST', '/approval-callback', body)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { deduped?: boolean }).deduped).toBe(true)
    const second = await pool.query('select status, decided_at from forms.submission where id=$1', [id])
    expect(second.rows[0].decided_at).toEqual(first.rows[0].decided_at)

    // 通知只发一次（幂等写成功的那次），eventId 确定性
    const decisions = emitted.filter((e) => e.eventKey === 'forms.approval.decided')
    expect(decisions.length).toBe(1)
    expect(decisions[0].eventId).toBe(`forms:submission:${id}:decided`)
    expect(decisions[0].payload).toMatchObject({ submissionId: String(id), action: 'approved', submitter: 'u1' })

    // org 不一致：服务账号也只能回自己的租户
    res = await req(appFor(service()), 'POST', '/approval-callback', { ...body, org: 'other-org' })
    expect(res.status).toBe(403)

    // 非终态回调不改状态
    res = await req(appFor(service()), 'POST', '/approval-callback', { ...body, caseId, final: false })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { skipped?: string }).skipped).toBe('non_final')

    // withdrawn 终态：withdrawn_at 同步落（状态词表与时间列不能只写一半）
    res = await req(appFor(filler()), 'POST', `/defs/${ITEM}/submissions`, { payload: { reason: '撤回回调' } })
    const pending2 = (await res.json()) as { id: string; caseId: string }
    res = await req(appFor(service()), 'POST', '/approval-callback', {
      org: OA_ORG, caseId: pending2.caseId, externalRef: `forms:submission:${pending2.id}`,
      final: true, action: 'withdrawn', decidedBy: 'u1', decidedAt: '2026-11-16T01:00:00Z',
    })
    expect(res.status).toBe(200)
    const withdrawn = await pool.query('select status, withdrawn_at from forms.submission where id=$1', [pending2.id])
    expect(withdrawn.rows[0].status).toBe('withdrawn')
    expect(withdrawn.rows[0].withdrawn_at).not.toBeNull()
  })

  it('撤回：提交人 + 仅 pending；引擎收到 withdraw；他人/重复撤回 404', async () => {
    // 新造一笔在途单（用同一事项模板）
    let res = await req(appFor(filler()), 'POST', `/defs/${ITEM}/submissions`, { payload: { reason: '再请一次' } })
    expect(res.status).toBe(201)
    const id = ((await res.json()) as { id: string }).id

    res = await req(appFor(stranger()), 'POST', `/submissions/${id}/withdraw`, {})
    expect(res.status).toBe(404)

    const before = engine.calls.length
    res = await req(appFor(filler()), 'POST', `/submissions/${id}/withdraw`, { reason: '计划取消' })
    expect(res.status).toBe(200)
    expect(engine.calls.length).toBe(before + 1)
    expect(engine.calls.at(-1)!.url).toMatch(/\/withdraw$/)
    // 撤回也必须携 org（引擎按它做租户校验）
    expect(engine.calls.at(-1)!.body).toMatchObject({ org: OA_ORG, actor: 'u1', reason: '计划取消' })

    const { rows } = await pool.query('select status, withdrawn_at from forms.submission where id=$1', [id])
    expect(rows[0].status).toBe('withdrawn')
    expect(rows[0].withdrawn_at).not.toBeNull()

    // 已终态再撤 → 404（不是 409：对提交人来说「这笔可撤回的单不存在了」）
    res = await req(appFor(filler()), 'POST', `/submissions/${id}/withdraw`, {})
    expect(res.status).toBe(404)
  })

  it('无引擎映射 ⇒ 提交 409 OA_NOT_ENABLED 且不落行（fail-closed）', async () => {
    const before = await subCount()
    const res = await req(appFor(filler(), { engineFor: async () => null }), 'POST', `/defs/${ITEM}/submissions`, {
      payload: { reason: '没开 OA' },
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('OA_NOT_ENABLED')
    expect(await subCount()).toBe(before)
  })

  it('建 case 失败补偿：submission 标 withdrawn（不留 pending 孤儿）+ 审计', async () => {
    const broken = {
      async createCase(): Promise<{ caseId: string }> { throw new Error('engine down') },
      async getCase(_id: string, _org: string): Promise<never> { throw new Error('engine down') },
      async listCases(_org: string): Promise<never[]> { return [] },
      async decide(): Promise<never> { throw new Error('engine down') },
      async withdraw(): Promise<never> { throw new Error('engine down') },
    }
    const before = await subCount()
    const res = await req(appFor(filler(), { engineFor: async () => broken }), 'POST', `/defs/${ITEM}/submissions`, {
      payload: { reason: '引擎挂了' },
    })
    expect(res.status).toBe(502)
    expect(await subCount()).toBe(before + 1)
    const { rows } = await pool.query(
      "select status from forms.submission where org=$1 and submitted_by='u1' order by id desc limit 1", [OA_ORG])
    expect(rows[0].status).toBe('withdrawn')
    const audit = await pool.query(
      "select 1 from forms.audit where org=$1 and action='approval.submit.failed' order by id desc limit 1", [OA_ORG])
    expect(audit.rows.length).toBe(1)
  })
})
