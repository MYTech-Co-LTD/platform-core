// routes.ts — forms API 面（issue #710，21 端点）。
// 纪律：门禁由宿主按 manifest api.internal 声明施加（模块零 requireScope——#710 计划注：
// scope 越权断言归 smoke 的真进程装配面与宿主门卫测试，模块测试壳不挂门卫）；
// 身份由宿主注入 c.get('identity')，org 永远只取 identity.orgId（主体钉死）。
// 错误一律机检错误码；DB 生命周期触发器冲突归并为 LIFECYCLE_CONFLICT/409（拒绝文案带版本与 kind）。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, NotifyPort, OrganizationPort } from '@platform/sdk'
import { validateApprovalBody } from './domain/approval'
import { isWecomBindingBody, itemWecomRefOf, validateWecomBinding } from './domain/wecom-binding'
import { compilePlan } from './domain/approval-compile'
import { compileGate } from './domain/contract'
import {
  EngineHttpError, approversOfNode, currentNodeOf, firstNodeTitleFor, planHasApprover,
} from './domain/engine-client'
import type { EngineClient, EngineResolver } from './domain/engine-client'
import { generateDraft } from './domain/generator'
import { LlmError } from './domain/llm'
import type { ChatModel } from './domain/llm'
import { registerFormsMcpManage, registerFormsMcpRead } from './mcp'
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
    // 引擎明确拒绝（409 = 已决策/已终结）与引擎不可用（502）要分开——前者是业务事实，
    // 后者才是故障；混成一个码会让「重复审批」被当成服务不可用。
    if (e instanceof EngineHttpError) {
      return e.status === 409
        ? fail(c, 409, 'ENGINE_CONFLICT', e.detail)
        : fail(c, 502, 'ENGINE_HTTP_ERROR', e.detail)
    }
    if (e instanceof FormsError) {
      const map: Record<string, number> = {
        DICT_KEY_NOT_FOUND: 404, NO_PUBLISHED_HEAD: 409, HEAD_MOVED: 409,
        // 审批面（OA P1）
        OA_NOT_ENABLED: 409,
        ORG_UNAVAILABLE: 503,
        EMPTY_NODE: 409,
        APPROVERS_UNRESOLVED: 409,
        QUORUM_EXCEEDS_APPROVERS: 409,
        SELF_APPROVAL_FORBIDDEN: 409,
        APPROVAL_TEMPLATE_NOT_FOUND: 409,
        APPROVAL_TEMPLATE_NOT_PUBLISHED: 409,
        PROVIDER_MISMATCH: 409,
        PROVIDER_UNSUPPORTED: 409,
        NOT_APPROVAL_MODE: 409,
        ENGINE_UNAVAILABLE: 502,
        ENGINE_BAD_RESPONSE: 502,
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

/** 导出面的分页上限（服务端定，调用方不能越过——防一次拉全库）。 */
const EXPORT_DEFAULT_LIMIT = 500
const EXPORT_MAX_LIMIT = 2000

/** 标准审批镜像列表页的分页上限（console 一屏量级；导出面另有自己的 2000 上限）。 */
const APPROVAL_LIST_DEFAULT_LIMIT = 100
const APPROVAL_LIST_MAX_LIMIT = 500

export function createFormsRouter({
  pool,
  chatModel = null,
  orgPort = null,
  notify = null,
  engineFor = async () => null,
}: {
  pool: Pool
  chatModel?: ChatModel | null
  /** 组织查询面（宿主注入；未注入 ⇒ 审批编译回 503 ORG_UNAVAILABLE，不当「没人」）。 */
  orgPort?: OrganizationPort | null
  /** 通知端口（宿主注入；未注入 ⇒ 事件静默不投递——不是致命错误，但要在报告里可见）。 */
  notify?: NotifyPort | null
  /** 租户 → 引擎 client（无映射 ⇒ null ⇒ 409 OA_NOT_ENABLED）。 */
  engineFor?: EngineResolver
}) {
  const r = new Hono<{ Variables: { identity: Identity } }>()

  /** 审批模板的编译（dry-run / publish / 提交前的共用闸）。 */
  const compileFor = async (
    org: string, assetId: string, version: number, body: unknown,
    requester: string, payload: Record<string, unknown>,
  ) => {
    const parsed = validateApprovalBody(body)
    if (!parsed.ok) throw new FormsError(parsed.code, parsed.detail)
    if (parsed.body.provider !== 'inapp') {
      // wecom_native 绑定不是节点链：没有可编译的「应用内计划」
      throw new FormsError('PROVIDER_MISMATCH', 'wecom_native 绑定不是应用内审批节点链，不能编译计划')
    }
    if (orgPort === null) {
      throw new FormsError('ORG_UNAVAILABLE', '组织查询面未注入，无法解析审批人')
    }
    return compilePlan({ org, templateRef: { id: assetId, version }, requester, payload, body: parsed.body }, orgPort)
  }

  /** 该身份是否本部门的部门管理员（详情页的第三种可见性；查不了 ⇒ false）。 */
  const isDeptAdmin = async (identity: Identity): Promise<boolean> => {
    if (orgPort === null) return false
    const dept = await orgPort.primaryDeptOf(identity.orgId, identity.userId)
    if (dept === null) return false
    const admins = await orgPort.listDeptAdmins(identity.orgId, [dept])
    return admins.includes(identity.userId)
  }

  const engineOrThrow = async (org: string): Promise<EngineClient> => {
    const client = await engineFor(org)
    if (client === null) throw new FormsError('OA_NOT_ENABLED', `租户 ${org} 未开通应用内审批（无引擎映射）`)
    return client
  }

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
      // 标准审批（P2）：`provider=wecom_native` 的事项模板必须引用**已发布**的绑定资产。
      // 绑定退役/仍在草稿 ⇒ 引用它的模板不能新发布（否则深链指向一条平台不认识的模板）。
      if ((draftBody as { provider?: unknown }).provider === 'wecom_native') {
        const ref = itemWecomRefOf(draftBody)
        if (!ref.ok) return fail(c, 400, ref.code, ref.detail)
        const status = await store.assetVersionStatus(
          pool, identity.orgId, 'approval_def', ref.ref.id, ref.ref.version,
        )
        if (status === null) {
          return fail(c, 409, 'APPROVAL_BINDING_NOT_FOUND', `标准审批绑定 ${ref.ref.id} v${ref.ref.version} 不存在`)
        }
        if (status !== 'published') {
          return fail(
            c, 409, 'APPROVAL_BINDING_NOT_PUBLISHED',
            `标准审批绑定 ${ref.ref.id} v${ref.ref.version} 不是已发布（${status}）——绑定草稿/退役期不能新发布引用它的模板`,
          )
        }
        const bindingBody = await store.bodyAt(pool, identity.orgId, ref.ref.id, ref.ref.version, 'approval_def')
        if (!isWecomBindingBody(bindingBody)) {
          return fail(c, 409, 'PROVIDER_MISMATCH', `引用的审批资产 ${ref.ref.id} v${ref.ref.version} 不是 wecom_native 绑定`)
        }
      }
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

  // ── 审批模板（OA P1 / spec §6.1；与表单定义共用同一生命周期，kind='approval_def'） ──
  // 权限分三档：view（读/解析）、manage（起草/编辑/dry-run）、publish（发布，人 gate）。
  // AI 工具面只到 manage——发布只能人走 console（"AI 永不发布"）。

  r.get('/approval-defs', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      return c.json({ defs: await store.listDefs(pool, identity.orgId, 'approval_def') })
    }),
  )

  r.get('/approval-defs/:assetId', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const assetId = c.req.param('assetId')
      const versions = await store.listVersions(pool, identity.orgId, assetId, 'approval_def')
      if (versions.length === 0) return fail(c, 404, 'ASSET_NOT_FOUND', `审批模板 ${assetId} 不存在`)
      const head = await store.headVersion(pool, identity.orgId, assetId, 'approval_def')
      return c.json({ assetId, head, versions })
    }),
  )

  r.post('/approval-defs', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const body = (await c.req.json().catch(() => null)) as { assetId?: unknown; body?: unknown } | null
      const assetId = typeof body?.assetId === 'string' ? body.assetId : ''
      if (!ASSET_ID_RE.test(assetId)) return fail(c, 400, 'ASSET_ID_INVALID', 'assetId 必须匹配 ^[a-z][a-z0-9-]{0,63}$')
      // 两条 provider 走两条资产面：绑定只经 /approval-bindings（发布门是 forms:global-manage，
      // 不是 forms:approval:publish），这里显式拒绝，避免同一 assetId 被两种语义混用。
      if (isWecomBindingBody(body?.body)) {
        return fail(c, 400, 'PROVIDER_MISMATCH', 'wecom_native 绑定请走 /approval-bindings（平台管理员面）')
      }
      const version = await store.newDraft(pool, identity.orgId, assetId, body?.body, identity.userId, 'approval_def')
      await store.audit(pool, identity.orgId, identity.userId, 'approval.draft', assetId, { version })
      return c.json({ assetId, version }, 201)
    }),
  )

  r.put('/approval-defs/:assetId/versions/:v', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null
      if (isWecomBindingBody(body?.body)) {
        return fail(c, 400, 'PROVIDER_MISMATCH', 'wecom_native 绑定请走 /approval-bindings（平台管理员面）')
      }
      await store.updateDraft(pool, identity.orgId, c.req.param('assetId'), version, body?.body, 'approval_def')
      return c.json({ ok: true })
    }),
  )

  r.delete('/approval-defs/:assetId/versions/:v', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      await store.dropDraft(pool, identity.orgId, c.req.param('assetId'), version, 'approval_def')
      return c.json({ ok: true })
    }),
  )

  // dry-run（spec §8.3）：给定样例 payload + 发起人，返回解析后的完整计划。**只读**，不写库。
  // 指定 version 时预览该版本（草稿期可反复试），否则 head 优先、无 head 取最新版本。
  r.post('/approval-defs/:assetId/dry-run', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const assetId = c.req.param('assetId')
      const body = (await c.req.json().catch(() => null)) as
        { version?: unknown; payload?: unknown; requester?: unknown } | null
      const versions = await store.listVersions(pool, identity.orgId, assetId, 'approval_def')
      if (versions.length === 0) return fail(c, 404, 'ASSET_NOT_FOUND', `审批模板 ${assetId} 不存在`)
      let version: number
      if (body?.version !== undefined) {
        version = typeof body.version === 'number' ? body.version : Number.NaN
      } else {
        const head = await store.headVersion(pool, identity.orgId, assetId, 'approval_def')
        version = head ?? versions[0].version
      }
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const raw = await store.bodyAt(pool, identity.orgId, assetId, version, 'approval_def')
      if (raw === null) return fail(c, 404, 'ASSET_NOT_FOUND', `版本 v${version} 不存在`)
      const requester = typeof body?.requester === 'string' && body.requester.length > 0
        ? body.requester
        : identity.userId
      const payload = body?.payload !== null && typeof body?.payload === 'object'
        ? (body!.payload as Record<string, unknown>)
        : {}
      const plan = await compileFor(identity.orgId, assetId, version, raw, requester, payload)
      return c.json({ plan })
    }),
  )

  // 发布 = 人 gate（scope forms:approval:publish）+ **编译闸**：dry-run 不过就不许发。
  // 发布时把解析后的计划写审计（spec §8.3）；任一节点解析为空 ⇒ 409（block_publish）。
  r.post('/approval-defs/:assetId/versions/:v/publish', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const assetId = c.req.param('assetId')
      const raw = await store.bodyAt(pool, identity.orgId, assetId, version, 'approval_def')
      if (raw === null) return fail(c, 404, 'ASSET_NOT_FOUND', `版本 v${version} 不存在`)
      const body = (await c.req.json().catch(() => null)) as
        { payload?: unknown; requester?: unknown } | null
      const requester = typeof body?.requester === 'string' && body.requester.length > 0
        ? body.requester
        : identity.userId
      const payload = body?.payload !== null && typeof body?.payload === 'object'
        ? (body!.payload as Record<string, unknown>)
        : {}
      const plan = await compileFor(identity.orgId, assetId, version, raw, requester, payload)
      const empty = plan.nodes.filter((n) => n.approvers.length === 0).map((n) => n.key)
      if (empty.length > 0) {
        return fail(c, 409, 'EMPTY_NODE', `节点解析后没有审批人（block_publish）：${empty.join(', ')}`)
      }
      await store.publish(pool, identity.orgId, assetId, version, identity.userId, 'approval_def')
      await store.audit(pool, identity.orgId, identity.userId, 'approval.publish', assetId, {
        version, requester, plan,
      })
      return c.json({ ok: true })
    }),
  )

  // ── 标准审批绑定（OA P2 / issue #2385）：`provider=wecom_native` 的绑定资产 ──
  // 资产 kind 仍是 `approval_def`（绑定就是「审批的另一种 provider」，T5 对账按
  // kind=approval_def + body->>'provider'='wecom_native' 读）；body = WecomBindingBody。
  // **全端点限平台管理员**（forms:global-manage，platformOnly）：这是发布门的 scope 落点——
  // 普通 forms:approval:publish 不能发布绑定。绑定不建 submission、不进 case-engine。

  /** 绑定资产视图：任一版本是 wecom_native 即算（创建后的草稿期也要在管理面可见）。 */
  const bindingsOf = async (org: string) => {
    const defs = await store.listDefs(pool, org, 'approval_def')
    const out: Array<store.DefSummaryRow & { versions: store.VersionRow[] }> = []
    for (const d of defs) {
      const versions = await store.listVersions(pool, org, d.assetId, 'approval_def')
      if (!versions.some((v) => isWecomBindingBody(v.body))) continue
      out.push({ ...d, versions })
    }
    return out
  }

  r.get('/approval-bindings', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      return c.json({ bindings: await bindingsOf(identity.orgId) })
    }),
  )

  r.get('/approval-bindings/:assetId', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const assetId = c.req.param('assetId')
      const versions = await store.listVersions(pool, identity.orgId, assetId, 'approval_def')
      if (!versions.some((v) => isWecomBindingBody(v.body))) {
        return fail(c, 404, 'ASSET_NOT_FOUND', `绑定 ${assetId} 不存在`)
      }
      const head = await store.headVersion(pool, identity.orgId, assetId, 'approval_def')
      return c.json({ assetId, head, versions })
    }),
  )

  r.post('/approval-bindings', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const body = (await c.req.json().catch(() => null)) as { assetId?: unknown; body?: unknown } | null
      const assetId = typeof body?.assetId === 'string' ? body.assetId : ''
      if (!ASSET_ID_RE.test(assetId)) return fail(c, 400, 'ASSET_ID_INVALID', 'assetId 必须匹配 ^[a-z][a-z0-9-]{0,63}$')
      const parsed = validateWecomBinding(body?.body)
      if (!parsed.ok) return fail(c, 400, parsed.code, parsed.detail)
      // 同一 assetId 只能是一种语义：已有非绑定版本（应用内审批模板）⇒ 不许改作绑定
      const existing = await store.listVersions(pool, identity.orgId, assetId, 'approval_def')
      if (existing.some((v) => !isWecomBindingBody(v.body))) {
        return fail(c, 409, 'ASSET_KIND_MISMATCH', `资产 ${assetId} 已是应用内审批模板，不能改作 wecom_native 绑定`)
      }
      const version = await store.newDraft(pool, identity.orgId, assetId, parsed.body, identity.userId, 'approval_def')
      await store.audit(pool, identity.orgId, identity.userId, 'binding.draft', assetId, {
        version, processCode: parsed.body.processCode,
      })
      return c.json({ assetId, version }, 201)
    }),
  )

  r.put('/approval-bindings/:assetId/versions/:v', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const assetId = c.req.param('assetId')
      const versions = await store.listVersions(pool, identity.orgId, assetId, 'approval_def')
      if (!versions.some((v) => isWecomBindingBody(v.body))) {
        return fail(c, 404, 'ASSET_NOT_FOUND', `绑定 ${assetId} 不存在`)
      }
      const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null
      const parsed = validateWecomBinding(body?.body)
      if (!parsed.ok) return fail(c, 400, parsed.code, parsed.detail)
      await store.updateDraft(pool, identity.orgId, assetId, version, parsed.body, 'approval_def')
      await store.audit(pool, identity.orgId, identity.userId, 'binding.draft.update', assetId, { version })
      return c.json({ ok: true })
    }),
  )

  r.delete('/approval-bindings/:assetId/versions/:v', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      await store.dropDraft(pool, identity.orgId, c.req.param('assetId'), version, 'approval_def')
      return c.json({ ok: true })
    }),
  )

  // 发布门：manifest 已把本端点声明为 `forms:global-manage`（宿主门卫施加），这里再按身份
  // 判一次——门卫未装配的测试壳/未来的直接调用都不能绕过「绑定发布只属平台管理员」。
  r.post('/approval-bindings/:assetId/versions/:v/publish', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      if (!identity.hasScope('forms:global-manage')) {
        return fail(c, 403, 'FORBIDDEN', '发布 wecom_native 绑定需要 forms:global-manage（平台管理员）')
      }
      const version = Number(c.req.param('v'))
      if (!Number.isInteger(version)) return fail(c, 400, 'BAD_VERSION', 'version 必须是整数')
      const assetId = c.req.param('assetId')
      const raw = await store.bodyAt(pool, identity.orgId, assetId, version, 'approval_def')
      if (raw === null) return fail(c, 404, 'ASSET_NOT_FOUND', `版本 v${version} 不存在`)
      const parsed = validateWecomBinding(raw)
      if (!parsed.ok) {
        return fail(c, 400, parsed.code, `绑定不完整，不能发布：${parsed.detail}`)
      }
      await store.publish(pool, identity.orgId, assetId, version, identity.userId, 'approval_def')
      await store.audit(pool, identity.orgId, identity.userId, 'binding.publish', assetId, {
        version, processCode: parsed.body.processCode,
      })
      return c.json({ ok: true })
    }),
  )

  // ── 提交 ──

  // 分流（OA P1）：事项模板 body.mode='approval' ⇒ 编译计划 + 建引擎 case；其余保持收集路径逐字不变。
  // mode 从**提交将钉住的 head 版本**读（与表单提交同一基准；不读请求参数，防客户端自选）。
  r.post('/defs/:assetId/submissions', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const assetId = c.req.param('assetId')
      const body = (await c.req.json().catch(() => null)) as { payload?: unknown } | null
      const head = await store.headVersion(pool, identity.orgId, assetId)
      if (head !== null) {
        const defBody = await store.bodyAt(pool, identity.orgId, assetId, head)
        if (store.itemModeOf(defBody) === 'approval') {
          const result = await store.submitApproval(pool, identity.orgId, assetId, body?.payload, identity.userId, {
            orgPort,
            engineFor,
            title: `${assetId} - ${identity.displayName || identity.userId}`,
          })
          return c.json(result, 201)
        }
      }
      const result = await store.submit(pool, identity.orgId, assetId, body?.payload, identity.userId)
      return c.json(result, 201)
    }),
  )

  // 撤回（OA P1 / spec §10.4）：仅提交人 + 仅 pending。引擎 409（已有决策）原样映射 409。
  r.post('/submissions/:id/withdraw', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const id = c.req.param('id')
      if (!/^\d+$/.test(id)) return fail(c, 404, 'SUBMISSION_NOT_FOUND')
      const sub = await store.getOwnPendingSubmission(pool, identity.orgId, id, identity.userId)
      if (sub === null) return fail(c, 404, 'SUBMISSION_NOT_FOUND')
      const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null
      const reason = typeof body?.reason === 'string' ? body.reason : ''
      if (sub.caseRef !== null) {
        const engine = await engineOrThrow(identity.orgId)
        await engine.withdraw(sub.caseRef, identity.orgId, { actor: identity.userId, reason })
      }
      await store.markWithdrawn(pool, identity.orgId, id, identity.userId)
      await store.audit(pool, identity.orgId, identity.userId, 'approval.withdraw', id, {
        assetId: sub.assetId, caseId: sub.caseRef, reason,
      })
      return c.json({ ok: true })
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

  // ── 应用内审批代理（OA P1 / spec §9.3、§10.3） ──
  // 授权口径（关键）：**审批动作按计划快照授权，不按权限码放行**。scope 只是宽档
  // （forms:view / forms:fill——审批人是普通员工，不该额外授权），真正的门在 handler 里：
  // 「当前节点审批人 / 发起人 / 部门管理员」。
  // ⚠️ `/approvals/mine` 必须先于 `/approvals/:caseId` 注册（否则 'mine' 被当成 caseId）。

  r.get('/approvals/mine', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const rows = await store.listPendingApprovalsFor(pool, identity.orgId, identity.userId)
      return c.json({
        approvals: rows.map((row) => ({
          submissionId: row.id,
          caseId: row.caseRef,
          title: `${row.assetId} - ${row.submittedBy}`,
          requester: row.submittedBy,
          nodeTitle: firstNodeTitleFor(row.plan, identity.userId) ?? '',
          submittedAt: row.submittedAt,
        })),
      })
    }),
  )

  r.get('/approvals/:caseId', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const caseId = c.req.param('caseId')
      const sub = await store.getSubmissionByCaseRef(pool, identity.orgId, caseId)
      if (sub === null) return fail(c, 404, 'SUBMISSION_NOT_FOUND')
      const allowed = sub.submittedBy === identity.userId
        || planHasApprover(sub.plan, identity.userId)
        || (await isDeptAdmin(identity))
      if (!allowed) return fail(c, 403, 'FORBIDDEN')
      // 引擎详情拿不到不影响页面把「已知的提交」显示出来——降级为 case:null + 原因
      let caseDetail: unknown = null
      let engineError: string | null = null
      try {
        caseDetail = await (await engineOrThrow(identity.orgId)).getCase(caseId, identity.orgId)
      } catch (e) {
        engineError = (e as FormsError).code ?? 'ENGINE_UNAVAILABLE'
      }
      const contract = await store.bodyAt(pool, identity.orgId, sub.assetId, sub.version)
      return c.json({
        submission: {
          id: sub.id,
          assetId: sub.assetId,
          version: sub.version,
          payload: sub.payload,
          submittedBy: sub.submittedBy,
          submittedAt: sub.submittedAt,
          status: sub.status,
          caseId: sub.caseRef,
          plan: sub.plan,
          decidedAt: sub.decidedAt,
          decisionAction: sub.decisionAction,
          decisionComment: sub.decisionComment,
        },
        contract,
        case: caseDetail,
        engineError,
      })
    }),
  )

  r.post('/approvals/:caseId/decision', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const caseId = c.req.param('caseId')
      const body = (await c.req.json().catch(() => null)) as {
        nodeKey?: unknown; action?: unknown; comment?: unknown; targetAssignee?: unknown
      } | null
      const action = typeof body?.action === 'string' ? body.action : ''
      if (!['approve', 'reject', 'reassign', 'veto'].includes(action)) {
        return fail(c, 400, 'ACTION_INVALID', 'action 只能是 approve / reject / reassign / veto')
      }
      const comment = typeof body?.comment === 'string' ? body.comment.trim() : ''
      if ((action === 'reject' || action === 'veto') && comment.length === 0) {
        return fail(c, 400, 'COMMENT_REQUIRED', '驳回/否决必须填写意见（产品约束，服务端强制）')
      }
      const targetAssignee = typeof body?.targetAssignee === 'string' ? body.targetAssignee : ''
      if (action === 'reassign' && targetAssignee.length === 0) {
        return fail(c, 400, 'TARGET_REQUIRED', '改派必须指定 targetAssignee')
      }
      const sub = await store.getSubmissionByCaseRef(pool, identity.orgId, caseId)
      if (sub === null) return fail(c, 404, 'SUBMISSION_NOT_FOUND')
      if (sub.status !== 'pending_approval') return fail(c, 409, 'NOT_PENDING', `该提交已是终态（${sub.status}）`)
      const engine = await engineOrThrow(identity.orgId)
      const caseDetail = await engine.getCase(caseId, identity.orgId)
      const current = currentNodeOf(caseDetail)
      if (current === null) return fail(c, 409, 'ENGINE_NO_CURRENT_NODE', '引擎未返回当前节点')
      const requested = typeof body?.nodeKey === 'string' ? body.nodeKey : ''
      if (requested.length > 0 && requested !== current) {
        return fail(c, 409, 'NOT_CURRENT_NODE', `请求节点 ${requested} 不是当前节点 ${current}`)
      }
      // 计划快照（提交时钉住）是平台侧授权依据——不信任引擎回传的 plan
      if (!approversOfNode(sub.plan, current).includes(identity.userId)) {
        return fail(c, 403, 'FORBIDDEN', `你不是节点 ${current} 的审批人`)
      }
      await engine.decide(caseId, identity.orgId, {
        nodeKey: current,
        action,
        decidedBy: identity.userId,
        ...(comment.length > 0 ? { comment } : {}),
        ...(targetAssignee.length > 0 ? { targetAssignee } : {}),
      })
      await store.audit(pool, identity.orgId, identity.userId, 'approval.decision', String(sub.id), {
        caseId, nodeKey: current, action, comment: comment.length > 0 ? comment : null,
        targetAssignee: targetAssignee.length > 0 ? targetAssignee : null,
      })
      return c.json({ ok: true, nodeKey: current })
    }),
  )

  // ── 引擎回调（spec §10.6）：scope forms:case:callback（服务账号专用） ──
  // 幂等键 = still-pending 的 (org, case_ref)：重复 final 只写一次，第二次 deduped:true。
  r.post('/approval-callback', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      if (!raw || typeof raw !== 'object') return fail(c, 400, 'BAD_BODY', '回调 body 必须是对象')
      if (raw.org !== identity.orgId) return fail(c, 403, 'ORG_MISMATCH', '回调 org 与会话租户不一致')
      const caseId = typeof raw.caseId === 'string' ? raw.caseId : ''
      if (caseId.length === 0) return fail(c, 400, 'CASE_ID_REQUIRED', '回调缺 caseId')
      if (raw.final === false) return c.json({ ok: true, skipped: 'non_final' })
      const action = raw.action
      if (action !== 'approved' && action !== 'rejected' && action !== 'withdrawn') {
        return fail(c, 400, 'ACTION_INVALID', 'action 只能是 approved / rejected / withdrawn')
      }
      let submissionId: string | null = null
      if (typeof raw.externalRef === 'string' && raw.externalRef.length > 0) {
        const m = /^forms:submission:(\d+)$/.exec(raw.externalRef)
        if (!m) return fail(c, 400, 'EXTERNAL_REF_INVALID', 'externalRef 必须是 forms:submission:<id>')
        submissionId = m[1]
      }
      const decidedAtRaw = typeof raw.decidedAt === 'string' ? raw.decidedAt : ''
      const decidedAt = decidedAtRaw.length > 0 ? new Date(decidedAtRaw) : new Date()
      if (Number.isNaN(decidedAt.getTime())) return fail(c, 400, 'DECIDED_AT_INVALID', 'decidedAt 不是合法时间')
      const updated = await store.applyFinalDecision(pool, {
        org: identity.orgId,
        caseId,
        submissionId,
        action,
        decidedAt,
        comment: typeof raw.comment === 'string' ? raw.comment : null,
      })
      if (updated === null) return c.json({ ok: true, deduped: true })
      await store.audit(pool, identity.orgId, identity.userId, 'approval.callback', updated.id, {
        caseId, action, decidedBy: raw.decidedBy ?? null, decidedAt: decidedAt.toISOString(),
      })
      // 通知 fail-open：投递失败不得把「已落库的终态」变成回调失败（引擎会重试并撞幂等）
      if (notify !== null) {
        try {
          const link = typeof raw.link === 'string' && raw.link.length > 0
            ? raw.link
            : `${process.env.PLATFORM_CONSOLE_BASE_URL ?? ''}/m/oa/approvals/${encodeURIComponent(caseId)}`
          await notify.emit(identity, {
            eventKey: 'forms.approval.decided',
            eventId: `forms:submission:${updated.id}:decided`,
            scope: caseId,
            payload: {
              submissionId: updated.id,
              caseId,
              action,
              decidedBy: typeof raw.decidedBy === 'string' ? raw.decidedBy : '',
              decidedAt: decidedAt.toISOString(),
              submitter: typeof raw.submitter === 'string' ? raw.submitter : '',
              link,
            },
          })
        } catch (e) {
          console.error('[forms] notify emit failed (fail-open):', e)
        }
      }
      return c.json({ ok: true, submissionId: updated.id })
    }),
  )

  // ── 导出面（出湖管线的「源」，M1.4 / #729） ──
  // 按键集游标拉提交：`after_id` 起步、`limit` 有服务端上限。**org 由身份取**（PAT 跨租户已被宿主拒）。
  r.get('/export/submissions', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const rawAfter = c.req.query('after_id') ?? '0'
      if (!/^\d+$/.test(rawAfter)) return fail(c, 400, 'BAD_AFTER_ID', 'after_id 必须是非负整数')
      const rawLimit = c.req.query('limit')
      const limit = rawLimit === undefined ? EXPORT_DEFAULT_LIMIT : Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_MAX_LIMIT) {
        return fail(c, 400, 'BAD_LIMIT', `limit 必须是 1..${EXPORT_MAX_LIMIT} 的整数`)
      }
      const rows = await store.exportSubmissions(pool, identity.orgId, Number(rawAfter), limit)
      const last = rows.at(-1)
      return c.json({
        rows,
        // 游标推进：有行就推到最后一行；无行保持原值（调用方据此判「追平了」）
        next_after_id: last === undefined ? rawAfter : last.submission_id,
        has_more: rows.length === limit,
      })
    }),
  )

  // ── 标准审批镜像（OA P2 Task 7 / issue #2385）：org 内只读列表 + 数据面导出 ──
  // 写入面只在宿主回调路由（经 forms 端口调用 upsertExternalApproval）与小时级对账脚本；
  // 本组端点**只读**：镜像行不建 forms.submission、不进 case-engine（计划 §已知边界）。
  // scope 用宽档 forms:view（与 /approvals/mine、/export/submissions 同款）——数据面 org 由
  // 身份钉死，授权不靠请求参数。

  r.get('/standard-approvals', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const rawLimit = c.req.query('limit')
      const limit = rawLimit === undefined ? APPROVAL_LIST_DEFAULT_LIMIT : Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > APPROVAL_LIST_MAX_LIMIT) {
        return fail(c, 400, 'BAD_LIMIT', `limit 必须是 1..${APPROVAL_LIST_MAX_LIMIT} 的整数`)
      }
      return c.json({ approvals: await store.listExternalApprovals(pool, identity.orgId, limit) })
    }),
  )

  // 导出 = 出湖管线的「源」：id 键集游标（after_id 起步），字段 = 镜像列。
  // `detail` 可得才带（不可得为 null——不假装有标准表单字段）。
  r.get('/standard-approvals/export', (c) =>
    handle(c, async () => {
      const { identity } = ctx(c)
      const rawAfter = c.req.query('after_id') ?? '0'
      if (!/^\d+$/.test(rawAfter)) return fail(c, 400, 'BAD_AFTER_ID', 'after_id 必须是非负整数')
      const rawLimit = c.req.query('limit')
      const limit = rawLimit === undefined ? EXPORT_DEFAULT_LIMIT : Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_MAX_LIMIT) {
        return fail(c, 400, 'BAD_LIMIT', `limit 必须是 1..${EXPORT_MAX_LIMIT} 的整数`)
      }
      const rows = await store.exportExternalApprovals(pool, identity.orgId, Number(rawAfter), limit)
      const last = rows.at(-1)
      return c.json({
        rows,
        // 游标推进：有行就推到最后一行；无行保持原值（调用方据此判「追平了」）
        next_after_id: last === undefined ? rawAfter : last.approval_id,
        has_more: rows.length === limit,
      })
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

  // MCP 面（2026-11-16 能力网关 Task 8）：
  //   · 读面 `/mcp`（forms:view）：只 list_forms（摘要，不回 draft body）；
  //   · 管理面 `/mcp-manage`（forms:manage）：list_forms + generate_form_draft。
  // 两面都**不暴露任何发布类工具**（AI 永不发布，forms:publish 仅 HTTP 人 gate）。
  registerFormsMcpRead(r, { pool, chatModel })
  registerFormsMcpManage(r, { pool, chatModel })

  return r
}
