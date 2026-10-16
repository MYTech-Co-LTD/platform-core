// routes.ts — forms API 面（issue #710，21 端点）。
// 纪律：门禁由宿主按 manifest api.internal 声明施加（模块零 requireScope——#710 计划注：
// scope 越权断言归 smoke 的真进程装配面与宿主门卫测试，模块测试壳不挂门卫）；
// 身份由宿主注入 c.get('identity')，org 永远只取 identity.orgId（主体钉死）。
// 错误一律机检错误码；DB 生命周期触发器冲突归并为 LIFECYCLE_CONFLICT/409（拒绝文案带版本与 kind）。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { compileGate } from './domain/contract'
import { generateDraft } from './domain/generator'
import { LlmError } from './domain/llm'
import type { ChatModel } from './domain/llm'
import { registerFormsMcpManage } from './mcp'
import * as store from './storage'
import { FormsError } from './storage'

const ASSET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const DICT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const DICT_KEY_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/

interface Ctx {
  identity: Identity
}

/** DB 生命周期触发器的拒绝族 → 409（拒绝文案原样透传——排障口径：带版本号与 kind）。 */
const LIFECYCLE_CONFLICT_RE =
  /immutable|not deletable|only draft can publish|cannot retire head|only published|not found|no published head|submissions follow head only|unknown kind|identity columns/

function fail(c: any, status: number, code: string, detail?: string) {
  return c.json({ error: code, ...(detail !== undefined ? { detail } : {}) }, status as 400)
}

async function handle(c: any, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof FormsError) {
      const map: Record<string, number> = {
        DICT_KEY_NOT_FOUND: 404, NO_PUBLISHED_HEAD: 409, HEAD_MOVED: 409,
      }
      return fail(c, map[e.code] ?? 400, e.code, e.detail)
    }
    const msg = (e as Error).message ?? ''
    if (LIFECYCLE_CONFLICT_RE.test(msg)) return fail(c, 409, 'LIFECYCLE_CONFLICT', msg)
    console.error('[forms] internal error:', e)
    return fail(c, 500, 'INTERNAL')
  }
}

function ctx(c: any): Ctx {
  return { identity: c.get('identity') as Identity }
}

/** AI 起草的描述上限（与 demo 的便签上限同一纪律：有界写入）。 */
const MAX_DESCRIPTION_LEN = 2000

export function createFormsRouter({ pool, chatModel = null }: { pool: Pool; chatModel?: ChatModel | null }) {
  const r = new Hono<{ Variables: { identity: Identity } }>()

  // ── 表单定义（生命周期） ──

  r.get('/defs', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      return c.json({ defs: await store.listDefs(pool, identity.orgId) })
    }),
  )

  r.get('/defs/:assetId', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const assetId = c.req.param('assetId')
      const versions = await store.listVersions(pool, identity.orgId, assetId)
      if (versions.length === 0) return fail(c, 404, 'ASSET_NOT_FOUND', `表单 ${assetId} 不存在`)
      const head = await store.headVersion(pool, identity.orgId, assetId)
      return c.json({ assetId, head, versions })
    }),
  )

  r.post('/defs', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const body = (await c.req.json().catch(() => null)) as { assetId?: unknown; body?: unknown } | null
      const assetId = typeof body?.assetId === 'string' ? body.assetId : ''
      if (!ASSET_ID_RE.test(assetId)) return fail(c, 400, 'ASSET_ID_INVALID', 'assetId 必须匹配 ^[a-z][a-z0-9-]{0,63}$')
      const version = await store.newDraft(pool, identity.orgId, assetId, body?.body, identity.userId)
      return c.json({ assetId, version }, 201)
    }),
  )

  // AI 起草（#724）：描述 → 契约草案 → 落 **draft**（**永不自动发布**；人过 forms:publish 门）。
  // 端点顺序无关，放在 /defs/:assetId 之前只为可读性（'/generate' 与 ':assetId' 不会互相吞）。
  r.post('/generate', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      if (chatModel === null) {
        return fail(c, 503, 'LLM_NOT_CONFIGURED', '未配置 FORMS_LLM_* 或 DATA_LLM_*（三键全在才算配好），AI 起草不可用')
      }
      const b = (await c.req.json().catch(() => null)) as { description?: unknown } | null
      const description = typeof b?.description === 'string' ? b.description.trim() : ''
      if (description.length === 0) return fail(c, 400, 'DESCRIPTION_REQUIRED', '需要 { description: string }')
      if (description.length > MAX_DESCRIPTION_LEN) {
        return fail(c, 400, 'DESCRIPTION_TOO_LONG', `描述上限 ${MAX_DESCRIPTION_LEN} 字`)
      }
      let result: Awaited<ReturnType<typeof generateDraft>>
      try {
        result = await generateDraft({ model: chatModel, description })
      } catch (e) {
        if (e instanceof LlmError) return fail(c, 502, 'LLM_UPSTREAM_FAILED', e.message)
        throw e
      }
      if (!result.ok) return fail(c, 422, result.code, result.detail)
      // 重名**报错不覆盖**（AI 可能把不同表单起同一个名；静默新建版本 = 悄悄改掉别人在用的表单）
      if (await store.assetExists(pool, identity.orgId, result.assetId)) {
        return fail(c, 409, 'ASSET_ID_TAKEN', `表单 ${result.assetId} 已存在——请换个名字后重试`)
      }
      const version = await store.newDraft(pool, identity.orgId, result.assetId, result.body, identity.userId)
      return c.json(
        { assetId: result.assetId, version, body: result.body, repairUsed: result.repairUsed },
        201,
      )
    }),
  )

  r.put('/defs/:assetId/versions/:v', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null
      await store.updateDraft(pool, identity.orgId, c.req.param('assetId'), version, body?.body)
      return c.json({ ok: true })
    }),
  )

  r.delete('/defs/:assetId/versions/:v', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      await store.dropDraft(pool, identity.orgId, c.req.param('assetId'), version)
      return c.json({ ok: true })
    }),
  )

  // 发布 = 人 gate（scope 层：forms:publish，宿主门卫施加）+ 编译闸（draft 期自由，
  // 上线前契约必须编译通过且引用可解析——写时校验纪律）。
  r.post('/defs/:assetId/versions/:v/publish', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const assetId = c.req.param('assetId')
      const draftBody = await store.bodyAt(pool, identity.orgId, assetId, version)
      if (draftBody === null) return fail(c, 404, 'ASSET_NOT_FOUND', `版本 v${version} 不存在`)
      const gate = compileGate(draftBody)
      if (!gate.ok) return fail(c, 400, gate.code, gate.detail)
      await store.publish(pool, identity.orgId, assetId, version, identity.userId)
      return c.json({ ok: true })
    }),
  )

  r.post('/defs/:assetId/rollback', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const body = (await c.req.json().catch(() => null)) as { version?: unknown } | null
      const version = typeof body?.version === 'number' ? body.version : Number.NaN
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'rollback 需要 { version: int }')
      await store.rollbackTo(pool, identity.orgId, c.req.param('assetId'), version)
      return c.json({ ok: true })
    }),
  )

  r.post('/defs/:assetId/versions/:v/retire', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      await store.retire(pool, identity.orgId, c.req.param('assetId'), version)
      return c.json({ ok: true })
    }),
  )

  // ── 提交 ──

  r.post('/defs/:assetId/submissions', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const body = (await c.req.json().catch(() => null)) as { payload?: unknown } | null
      const result = await store.submit(pool, identity.orgId, c.req.param('assetId'), body?.payload, identity.userId)
      return c.json(result, 201)
    }),
  )

  r.get('/defs/:assetId/submissions', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      return c.json({ submissions: await store.listSubmissions(pool, identity.orgId, c.req.param('assetId')) })
    }),
  )

  r.get('/submissions/:id', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const id = c.req.param('id')
      if (!/^\d+$/.test(id)) return fail(c, 404, 'SUBMISSION_NOT_FOUND')
      const sub = await store.getSubmission(pool, identity.orgId, id)
      if (sub === null) return fail(c, 404, 'SUBMISSION_NOT_FOUND')
      // 回执带钉住版本的契约：历史按当时版本渲染（§14.1）；org 在载荷外由会话钉死
      const contract = await store.bodyAt(pool, identity.orgId, sub.assetId, sub.version)
      return c.json({ submission: sub, contract })
    }),
  )

  // ── 字典（租户私有 / 平台全局：P4 分档，同名不同表） ──

  const dictRoutes = (base: string, scope: store.DictScope) => {
    const orgOf = (c: any): string | null => (scope === 'tenant' ? (c.get('identity') as Identity).orgId : null)

    r.get(`${base}`, (c) =>
      handle(c, async () => c.json({ dicts: await store.listDicts(pool, scope, orgOf(c)) })),
    )

    r.get(`${base}/:dictId/options`, (c) =>
      handle(c, async () => {
        const dictId = c.req.param('dictId')
        if (!DICT_ID_RE.test(dictId)) return fail(c, 400, 'DICT_ID_INVALID')
        return c.json({ options: await store.dictOptions(pool, scope, orgOf(c), dictId) })
      }),
    )

    r.get(`${base}/:dictId/resolve`, (c) =>
      handle(c, async () => {
        const dictId = c.req.param('dictId')
        if (!DICT_ID_RE.test(dictId)) return fail(c, 400, 'DICT_ID_INVALID')
        const raw = c.req.query('keys') ?? ''
        const keys = raw.split(',').map((k) => k.trim()).filter((k) => k.length > 0 && k.length <= 128)
        const resolved = await store.dictResolve(pool, scope, orgOf(c), dictId, keys)
        return c.json({ resolved: Object.fromEntries(resolved) })
      }),
    )

    r.post(`${base}`, (c) =>
      handle(c, async () => {
        const b = (await c.req.json().catch(() => null)) as
          | { dictId?: unknown; key?: unknown; label?: unknown; sortNo?: unknown }
          | null
        const dictId = typeof b?.dictId === 'string' ? b.dictId : ''
        const key = typeof b?.key === 'string' ? b.key : ''
        const label = typeof b?.label === 'string' ? b.label : ''
        if (!DICT_ID_RE.test(dictId)) return fail(c, 400, 'DICT_ID_INVALID')
        if (!DICT_KEY_RE.test(key)) return fail(c, 400, 'DICT_KEY_INVALID')
        if (!label) return fail(c, 400, 'LABEL_REQUIRED')
        const sortNo = typeof b?.sortNo === 'number' && Number.isInteger(b.sortNo) ? b.sortNo : 0
        await store.addDictKey(pool, scope, orgOf(c), dictId, key, label, (c.get('identity') as Identity).userId, sortNo)
        return c.json({ ok: true }, 201)
      }),
    )

    r.put(`${base}/:dictId/keys/:key`, (c) =>
      handle(c, async () => {
        const dictId = c.req.param('dictId')
        const key = c.req.param('key')
        if (!DICT_ID_RE.test(dictId) || !DICT_KEY_RE.test(key)) return fail(c, 400, 'DICT_ID_INVALID')
        const b = (await c.req.json().catch(() => null)) as
          | { label?: unknown; sortNo?: unknown; enabled?: unknown }
          | null
        const patch: { label?: string; sortNo?: number; enabled?: boolean } = {}
        if (typeof b?.label === 'string') patch.label = b.label
        if (typeof b?.sortNo === 'number' && Number.isInteger(b.sortNo)) patch.sortNo = b.sortNo
        if (typeof b?.enabled === 'boolean') patch.enabled = b.enabled
        if (Object.keys(patch).length === 0) return fail(c, 400, 'EMPTY_PATCH', '需要 label / sortNo / enabled 至少一项')
        await store.updateDictKey(pool, scope, orgOf(c), dictId, key, patch)
        return c.json({ ok: true })
      }),
    )
  }

  dictRoutes('/dicts', 'tenant')
  dictRoutes('/global-dicts', 'global')

  // 管理面 MCP 端点（#724）：外部 agent 可起草表单；**不暴露任何发布类工具**（AI 永不发布）
  registerFormsMcpManage(r, { pool, chatModel })

  return r
}
