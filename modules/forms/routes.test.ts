import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from './index'
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
    let res = await reqA(appA, 'POST', '/defs', { assetId: ASSET, body: schema })
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
    expect(payload.contract).toEqual(schema) // 回执带钉住版本契约（渲染历史按当时版本）
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
    await reqA(appA, 'POST', '/defs', { assetId: roAsset, body: roSchema })
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
    await reqA(appA, 'POST', '/defs', { assetId: `bad-${SUF}`, body: { type: 'object', properties: { a: { type: 'stringo' } } } })
    let res = await reqA(await appAs(publishA), 'POST', `/defs/bad-${SUF}/versions/1/publish`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('SCHEMA_COMPILE')

    await reqA(appA, 'POST', '/defs', { assetId: `dialect-${SUF}`, body: { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' } })
    res = await reqA(await appAs(publishA), 'POST', `/defs/dialect-${SUF}/versions/1/publish`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('SCHEMA_DIALECT')
  })

  it('生命周期冲突 → 409 LIFECYCLE_CONFLICT（重复发布同一 draft）', async () => {
    await reqA(appA, 'POST', '/defs', { assetId: `twice-${SUF}`, body: schema })
    await reqA(await appAs(publishA), 'POST', `/defs/twice-${SUF}/versions/1/publish`)
    const res = await reqA(await appAs(publishA), 'POST', `/defs/twice-${SUF}/versions/1/publish`)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('LIFECYCLE_CONFLICT')
  })

  it('无发布版本提交 → 409 NO_PUBLISHED_HEAD；不存在资产 → 404', async () => {
    await reqA(appA, 'POST', '/defs', { assetId: `nohead-${SUF}`, body: schema })
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
