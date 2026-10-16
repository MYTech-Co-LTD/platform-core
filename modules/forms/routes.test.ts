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
    for (const [t, org] of [['submission', [ORG_A, ORG_B]], ['asset_head', [ORG_A, ORG_B]], ['asset_version', [ORG_A, ORG_B]], ['dict_item', [ORG_A, ORG_B]]] as const) {
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
