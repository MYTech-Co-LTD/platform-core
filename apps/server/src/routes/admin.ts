// routes/admin.ts — /api/platform/admin/*：租户管理员代理（spec D4/D9，M3，issue #46）
//
// 三条结构锁死，不靠约定：
//  ① org 永远取自 c.get('tenant').casdoor_org——请求参数里没有任何能改变 org 的口子
//    （越界即结构上不可能，不是"校验拦截"）；
//  ② 整路由 requireScope('tenant:admin')——未挂码者连路由形状都探不到；
//  ③ 写操作（POST/PATCH/DELETE）校验 x-csrf-token 与当前会话一致（与 /logout 同款，防跨站强制管理）。
// 锚用户 tenantsub 不可见/不可改/不可删/不可授权（spec §6.2）。密码类敏感值不进 audit、不进日志。
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Pool } from 'pg'
import { csrfToken } from '@platform/auth-core'
import { normalizeEndpoint, platformStorageFromEnv, requireScope } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import type { TenantEnv, TenantRow } from '../tenant'
import type { CasdoorFactory, SessionEnv } from '../session-middleware'
import { probeStorage, type ProbeResult } from '../storage-probe'

/** 订阅锚用户名（casdoor-client ensureAnchorUser 同款；单处定义防漂移） */
export const ANCHOR_USER = 'tenantsub'

export interface AdminRoutesDeps {
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
  /** 权限码全集（平台内置 + 已装载模块）——授权页的可见宇宙 */
  permissions: () => ReadonlyArray<{ code: string; name: string }>
  /** 已装载模块（订阅页把 mod-<id> 映射回模块名） */
  modules: () => Array<{ id: string; name: string }>
  /**
   * 存储连通性探测（M3c，裁定 5：**只在请求路径之外**调用——保存时 + 显式「测试连接」）。
   * 可注入是为了让用例覆盖失败分类；**缺省 = 真探测**（`probeStorage`），生产走缺省即可。
   */
  probe?: (cfg: TenantStorageConfig) => Promise<ProbeResult>
}

/** 管理动作审计（platform.audit；与 auth.ts writeAudit 同款——await、失败即断） */
async function writeAudit(
  pool: Pool,
  tenantId: number,
  actor: string,
  action: 'admin.user.create' | 'admin.user.update' | 'admin.user.delete' | 'admin.grant' | 'admin.revoke'
    | 'admin.storage.update' | 'admin.storage.clear',
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [tenantId, actor, action, detail],
  )
}

export function adminRoutes(deps: AdminRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  // ② scope 门禁：整路由（未挂码 403 {error:'FORBIDDEN',need:'tenant:admin'}）
  app.use('*', requireScope('tenant:admin'))
  // ③ CSRF：写操作必须带与当前会话一致的 x-csrf-token（会话重签会轮换——前端每次现取 /session）
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const s = c.get('session')
      if (!s || c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
        return c.json({ error: 'CSRF' }, 403)
      }
    }
    await next()
  })

  // ---- 用户管理 ----

  app.get('/users', async (c) => {
    const org = c.get('tenant').casdoor_org
    const users = (await deps.casdoor(org).listUsers()).filter((u) => u.name !== ANCHOR_USER)
    return c.json({ users })
  })

  app.post('/users', async (c) => {
    const body = await c.req.json<{ username?: unknown; displayName?: unknown; password?: unknown }>().catch(() => null)
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const displayName = typeof body?.displayName === 'string' && body.displayName ? body.displayName : undefined
    // 用户名仅字母数字（Casdoor 用户名字符集实测拒绝 `_`，spec §1.2）；密码下限 8
    if (!/^[A-Za-z0-9]+$/.test(username) || username === ANCHOR_USER || password.length < 8) {
      return c.json({ error: 'INVALID' }, 400)
    }
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).createManagedUser({ name: username, displayName, password })
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.create', { user: username })
    return c.json({ name: username }, 201)
  })

  app.patch('/users/:name', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const body = await c.req.json<{ isForbidden?: unknown }>().catch(() => null)
    if (!body || typeof body.isForbidden !== 'boolean') return c.json({ error: 'INVALID' }, 400)
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).setUserForbidden(name, body.isForbidden)
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.update', { user: name, isForbidden: body.isForbidden })
    return c.json({ name })
  })

  app.patch('/users/:name/password', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const body = await c.req.json<{ password?: unknown }>().catch(() => null)
    const password = typeof body?.password === 'string' ? body.password : ''
    if (password.length < 8) return c.json({ error: 'INVALID' }, 400)
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).resetUserPassword(name, password)
    // 密码绝不进 detail（敏感值规矩）
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.update', { user: name, reset: true })
    return c.json({ name })
  })

  app.delete('/users/:name', async (c) => {
    const name = c.req.param('name')
    // 锚用户不可删；自己不可删自己（防管理员误自杀——交接先授权他人）
    if (name === ANCHOR_USER || name === c.get('identity').userId) {
      return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    }
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).deleteUser(name)
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.delete', { user: name })
    return c.json({ name })
  })

  // ---- 角色与授权（口径：权限码 ↔ 用户直挂，spec §6.7）----

  /** Casdoor 权限 users 全形（`org/name`）→ 短名；锚用户剔除 */
  function shortNames(users: string[]): string[] {
    return users
      .map((u) => (u.includes('/') ? (u.split('/').pop() ?? u) : u))
      .filter((u) => u !== ANCHOR_USER)
  }

  app.get('/permissions', async (c) => {
    const org = c.get('tenant').casdoor_org
    const universe = deps.permissions()
    const raw = await deps.casdoor(org).getPermissions()
    // getPermissions 不回 resources 之外的元数据——code→name 用宇宙表，raw 按 resources 反查
    const permissions = universe.map((u) => ({
      code: u.code,
      name: u.name,
      users: shortNames(raw.find((p) => p.resources?.includes(u.code))?.users ?? []),
    }))
    return c.json({ permissions })
  })

  app.post('/permissions/:code/users', async (c) => {
    const code = c.req.param('code')
    if (!deps.permissions().some((p) => p.code === code)) return c.json({ error: 'NO_SUCH_CODE' }, 404)
    const body = await c.req.json<{ user?: unknown }>().catch(() => null)
    const user = typeof body?.user === 'string' ? body.user : ''
    if (!/^[A-Za-z0-9]+$/.test(user) || user === ANCHOR_USER) return c.json({ error: 'INVALID' }, 400)
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).grantPermissionToUser(code, user)
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.grant', { code, user })
    return c.json({ ok: true })
  })

  app.delete('/permissions/:code/users/:user', async (c) => {
    const code = c.req.param('code')
    if (!deps.permissions().some((p) => p.code === code)) return c.json({ error: 'NO_SUCH_CODE' }, 404)
    const user = c.req.param('user')
    if (user === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).revokePermissionFromUser(code, user)
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.revoke', { code, user })
    return c.json({ ok: true })
  })

  // ---- 我的订阅（只读）----

  app.get('/subscriptions', async (c) => {
    const org = c.get('tenant').casdoor_org
    const subs = await deps.casdoor(org).listSubscriptions(org)
    const modules = new Map(deps.modules().map((m) => [m.id, m.name]))
    // plan 形如 `<org>/mod-<moduleId>`（或裸 `mod-<id>`）：取最后一段判 mod- 前缀；
    // 外来订阅（非 mod- 前缀，spec §1.2 已知 woke org 有支付流产生的）一律忽略
    const subscriptions = subs.flatMap((s) => {
      const last = String(s.plan ?? '').split('/').pop() ?? ''
      const m = /^mod-(.+)$/.exec(last)
      if (!m) return []
      return [{
        moduleId: m[1]!,
        moduleName: modules.get(m[1]!) ?? null,
        state: String(s.state ?? ''),
        startTime: s.startTime ?? null,
        endTime: s.endTime ?? null,
      }]
    })
    return c.json({ subscriptions })
  })

  // ---- 租户级存储配置（M3c，正典「租户级配置注入」）----
  //
  // org 锁、scope 门禁、写操作 CSRF 三道结构锁由本文件顶部三条中间件统一施加 —— 这里不重复实现。
  // 敏感值纪律：secret **绝不回显**（连字段都不出现）；AK 只回掩码；audit 只记 endpoint + bucket。
  //
  // 连通性验证**只在这里**（裁定 5）：保存前探测 + 显式「测试连接」。**明确不**在请求路径上探测——
  // 预签名是 SigV4 纯本地计算，请求路径上永远发现不了配置坏（正典该节已论证）。

  const storageProbe = deps.probe ?? probeStorage

  /** 五列现状（trim 后）。GET 与写前的「留空 = 保持原值」共用同一取法。 */
  function storageColumns(t: TenantRow): [string, string, string, string, string] {
    return [t.storage_endpoint, t.storage_region, t.storage_bucket, t.storage_access_key, t.storage_secret]
      .map((v) => (v ?? '').trim()) as [string, string, string, string, string]
  }

  type ParsedStorage =
    | { kind: 'ok'; cfg: TenantStorageConfig }
    | { kind: 'INVALID' }    // 形状不对（body 不是对象 / 字段类型不是字符串）
    | { kind: 'INCOMPLETE' } // 形状对但五元组凑不齐（fail-explicit 的第一道门）

  /**
   * PUT / POST 的 body → 完整五元组。**AK/SK 留空 = 保持原值**（凭据轮换时不必重贴）；
   * endpoint/region/bucket **没有**「留空 = 保持」语义 —— 它们是配置主体，缺了就是配置不全。
   * 库里也是空 + 本次也留空 ⇒ `INCOMPLETE`（**绝不静默存半套**：半套会让附件一定不可用，
   * 而 fail-explicit 要求这种状态在写入那一刻就被拒，而不是等用户拿到 503 才发现）。
   */
  function parseStorageInput(body: unknown, t: TenantRow): ParsedStorage {
    if (typeof body !== 'object' || body === null) return { kind: 'INVALID' }
    const b = body as Record<string, unknown>
    const field = (k: string): string | undefined | null => {
      const v = b[k]
      if (v === undefined || v === null) return undefined
      return typeof v === 'string' ? v.trim() : null // null = 类型不对
    }
    const raw = [field('endpoint'), field('region'), field('bucket'), field('accessKeyId'), field('secretAccessKey')]
    if (raw.some((v) => v === null)) return { kind: 'INVALID' }
    const [endpointIn, regionIn, bucketIn, akIn, skIn] = raw as Array<string | undefined>
    const [endpointOld, regionOld, bucketOld, akOld, skOld] = storageColumns(t)
    const endpoint = endpointIn || ''
    const region = regionIn || ''
    const bucket = bucketIn || ''
    const accessKeyId = akIn || akOld
    const secretAccessKey = skIn || skOld
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return { kind: 'INCOMPLETE' }
    // endpoint 必须**规范化后**落库：注入侧与 `storageRefOf` 的相等比较都建立在「已规范化」上，
    // 库里存未规范化串会让同一配置的 ref 对不上（存量附件读不出，且失败是静默的）
    const normalized = normalizeEndpoint(endpoint)
    // 拒绝带 userinfo 的 endpoint（`https://ak:sk@host`）：凭据有专门的两个字段，混进 URL 的话
    // 会被 `storageRefOf` 写进**每一行** storage_ref、也会进平台日志与审计——凭据纪律要求在此 fail-closed
    try {
      const u = new URL(normalized)
      if (u.username || u.password) return { kind: 'INVALID' }
    } catch {
      return { kind: 'INVALID' } // 规范化后仍解析不了 ⇒ 这个 endpoint 根本用不了
    }
    return { kind: 'ok', cfg: { kind: 's3', endpoint: normalized, region, bucket, accessKeyId, secretAccessKey } }
  }

  /** 探测失败的统一回法：**只回分类 + endpoint host**（原始错误进日志，含 tenant id、不含凭据） */
  function probeFailure(
    c: Context<TenantEnv & SessionEnv>,
    tenantId: number,
    cfg: TenantStorageConfig,
    r: ProbeResult & { ok: false },
  ) {
    // 失败形态进服务端日志（运维可查）：`r.detail` 已是「host: 码」形状 —— **不打印 cfg.endpoint 原文**，
    // 那串理论上可能带 userinfo；日志与响应都不该成为凭据的出口
    console.warn(`[admin.storage] 探测失败 tenant=${tenantId} bucket=${cfg.bucket} reason=${r.reason} detail=${r.detail}`)
    return c.json({ error: 'STORAGE_PROBE_FAILED', reason: r.reason, detail: r.detail }, 400)
  }

  app.get('/storage', async (c) => {
    const t = c.get('tenant')
    const cols = storageColumns(t)
    const configured = cols.every((v) => v !== '')
    return c.json({
      configured,
      // 部分填写在**读**这一侧也如实暴露：管理端要能看见「库里是半套」这个事实（否则用户只会看到 503）
      partial: cols.some((v) => v !== '') && !configured,
      endpoint: cols[0], region: cols[1], bucket: cols[2],
      // AK 只回掩码；secret **字段本身不存在**（不是「有但空」——空字段也会被前端当成「配过」）
      accessKeyIdMasked: cols[3] === '' ? '' : cols[3].slice(0, 4) + '****',
      // 注入侧只有一处实现（resolveTenantStorage），这里复用同一个 SDK 纯函数判定「有没有平台默认」
      platformFallback: platformStorageFromEnv(process.env) !== null,
    })
  })

  app.put('/storage', async (c) => {
    const t = c.get('tenant')
    const body = await c.req.json<unknown>().catch(() => null)
    const parsed = parseStorageInput(body, t)
    if (parsed.kind !== 'ok') return c.json({ error: parsed.kind }, 400)
    // 顺序是硬约束：**先探测、通过才写** —— 反了会留下「库里有配置、但探测没过」的中间态
    const result = await storageProbe(parsed.cfg)
    if (!result.ok) return probeFailure(c, t.id, parsed.cfg, result)
    await deps.pool.query(
      'update platform.tenant set storage_endpoint=$1, storage_region=$2, storage_bucket=$3,'
        + ' storage_access_key=$4, storage_secret=$5 where id=$6',
      [parsed.cfg.endpoint, parsed.cfg.region, parsed.cfg.bucket,
        parsed.cfg.accessKeyId, parsed.cfg.secretAccessKey, t.id],
    )
    // audit 只记 endpoint + bucket：AK/SK **绝不进 audit**（凭据不进审计面）
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.storage.update',
      { endpoint: parsed.cfg.endpoint, bucket: parsed.cfg.bucket })
    return c.json({ ok: true })
  })

  // 显式「测试连接」：**不写库**（事后场景：桶被删 / AK 轮换 / 网络策略变更）
  app.post('/storage/test', async (c) => {
    const t = c.get('tenant')
    const body = await c.req.json<unknown>().catch(() => null)
    const parsed = parseStorageInput(body, t)
    if (parsed.kind !== 'ok') return c.json({ error: parsed.kind }, 400)
    const result = await storageProbe(parsed.cfg)
    if (!result.ok) return probeFailure(c, t.id, parsed.cfg, result)
    return c.json({ ok: true })
  })

  // 清除配置 ⇒ 五列置 null ⇒ 回落平台默认（步 5 的回滚路径，机检在本组用例里）
  app.delete('/storage', async (c) => {
    const t = c.get('tenant')
    const cols = storageColumns(t)
    await deps.pool.query(
      'update platform.tenant set storage_endpoint=$1, storage_region=$2, storage_bucket=$3,'
        + ' storage_access_key=$4, storage_secret=$5 where id=$6',
      [null, null, null, null, null, t.id],
    )
    // 清掉的值记进 detail（取证用；仍只有 endpoint/bucket，无凭据）
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.storage.clear',
      { endpoint: cols[0], bucket: cols[2] })
    return c.json({ ok: true })
  })

  return app
}
