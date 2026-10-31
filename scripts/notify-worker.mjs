#!/usr/bin/env node
// scripts/notify-worker.mjs — 薄 CLI；组合根在 modules/notify/worker-deps.ts。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runOnceCli } from '../modules/notify/worker-deps.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-worker: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  // scripts/ 可以读 platform schema（B1 只约束 modules/**）；module 侧只收注入
  /** @param {string} key */
  const getEventDecl = async (key) => {
    const { rows } = await pool.query(
      'select payload_schema, recipients, scope_key from platform.event_catalog where key=$1 and active',
      [key],
    )
    const r = rows[0]
    return r
      ? {
          key, title: '',
          payload: r.payload_schema,
          recipients: r.recipients,
          scope: r.scope_key ? { key: r.scope_key } : undefined,
        }
      : null
  }
  // 权限码持有者（Casdoor 直挂 ∪ 角色展开）：宿主侧能力，缺凭据时降级为「不解析」
  // （→ 只能靠 manual literal 规则；**不静默假装没人持有**，有 warn）
  let resolveScopeHolderNames
  /** 部门 → 成员展开（缺 Casdoor 凭据时不注入 ⇒ 部门规则显式阻塞，不静默发 0 人） */
  let deptMembers
  if (process.env.CASDOOR_URL && process.env.CASDOOR_ADMIN_USER && process.env.CASDOOR_ADMIN_PWD) {
    const { createScopeHolderResolver } = await import('../apps/server/src/scope-holders.ts')
    const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
    /** @param {string} org */
    const casdoorFor = (org) => new CasdoorClient({
      origin: String(process.env.CASDOOR_URL),
      clientId: process.env.CASDOOR_CLIENT_ID ?? '',
      clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
      org,
      adminUser: String(process.env.CASDOOR_ADMIN_USER),
      adminPwd: String(process.env.CASDOOR_ADMIN_PWD),
    })
    resolveScopeHolderNames = createScopeHolderResolver(casdoorFor)
    // 部门展开（组织架构 Phase C）：平台 org 表（只读视图）+ Casdoor isForbidden 过滤。
    // 同一份 casdoorFor 工厂，语义与宿主装载期一致（缺凭据 ⇒ 不注入 ⇒ 部门规则显式阻塞）。
    const { createChannelAddressResolver } = await import('../apps/server/src/channel-address.ts')
    deptMembers = createChannelAddressResolver({ pool, casdoorFor }).resolveDeptMembers
  } else {
    console.warn('notify-worker: 缺 CASDOOR_* 凭据 ⇒ scope_holders / 部门收件人不解析（仅 manual literal 规则可用）')
  }

  // 健康端点：镜像的 HEALTHCHECK 打 `127.0.0.1:${PORT:-13000}/healthz`（与 server 同镜像继承），
  // worker 本无 HTTP 面 ⇒ 恒 unhealthy（2026-10-27 生产实测 Up 26m (unhealthy)）。
  // 这里起一个**只读**的极简端点，回答「worker 进程还活着 + 心跳新鲜」。
  // 端口用 WORKER_HEALTH_PORT（缺省 13000，与镜像 HEALTHCHECK 的 ${PORT:-13000} 对齐）；
  // 只绑回环，不对外暴露。
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? process.env.PORT ?? 13000)
  const { createServer } = await import('node:http')
  const healthServer = createServer(async (req, res) => {
    if (req.url !== '/healthz') { res.writeHead(404); res.end('not found'); return }
    try {
      const { rows } = await pool.query(
        "select 1 from notify.worker_heartbeat where beat_at > now()-interval '2 minutes'")
      const ok = rows.length > 0
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' })
      res.end(ok ? 'ok' : 'stale heartbeat')
    } catch (e) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end(e instanceof Error ? e.message : String(e))
    }
  })
  healthServer.listen(healthPort, '127.0.0.1', () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), health: `127.0.0.1:${healthPort}/healthz` }))
  })

  const once = process.argv.includes('--once')

  /**
   * 集成健康 STALE → 事件入队（spec 2026-10-31-integration-health-design.md §2.4）。
   *
   * 为什么在脚本里而不是模块里：装填位在 `platform.integration`，**模块不许读 platform schema**
   * （B1）；`scripts/` 没有这条限制（与 `notify-seed-builtin.mjs` 同款）。
   *
   * 语义 = **至少一次**：入队成功才落 `stale_notified=true`；worker 恰好死在两步之间，
   * 下一轮用同一个 event_id 重入队（`notify.event` 主键去重）⇒ 不双发、不丢。
   */
  const drainStaleAlerts = async () => {
    const { rows } = await pool.query(
      `select id, org, kind, sla_seconds, coalesce(last_error, '') as last_error
         from platform.integration
        where stale_notified = false
        order by id`,
    )
    if (rows.length === 0) return 0
    const { enqueueEvent } = await import('../modules/notify/storage.ts')
    // 装填位是租户无关的（org 常为空串）：本实例的租户从 platform.tenant 取，
    // 事件按租户入队（通知模型是租户级的），单租户实例就是一行。
    // ⚠️ 本文件被 `typecheck:scripts`（checkJs）检查：`pool.query` 返回 `any`，
    //    map 回调参数必须显式标类型（TS7006），否则 gates 的 typecheck 步红。
    /** @type {{ rows: Array<{ casdoor_org: string }> }} */
    const { rows: tenants } = await pool.query('select casdoor_org from platform.tenant order by id')
    const orgs = tenants.map((t) => t.casdoor_org)
    let sent = 0
    for (const r of rows) {
      // 租户维度：集成行带 org 就只发给它；否则发给本实例全部租户
      const targets = r.org ? [r.org] : orgs
      for (const org of targets) {
        await enqueueEvent(pool, {
          org,
          // 确定性 event_id：同一集成同一次「进入 STALE」只入队一次（撞键即去重）
          eventId: `integration-stale:${r.id}:${r.last_error || 'no-error'}`,
          eventKey: 'notify.integration.stale',
          scope: r.id,
          payload: {
            integrationId: r.id,
            integrationKind: r.kind,
            reason: r.last_error || '超过允许静默时长没有活性证据',
            slaSeconds: Number(r.sla_seconds),
          },
          producer: 'integration-probe',
        })
        sent += 1
      }
      // 入队成功才落标志位（尤其一次：worker 死在两步之间，下一轮 event_id 去重兜底）
      await pool.query('update platform.integration set stale_notified = true where id = $1 and org = $2',
        [r.id, r.org])
    }
    return sent
  }

  try {
    do {
      try {
        const s = await runOnceCli(pool, getEventDecl, process.env, resolveScopeHolderNames, deptMembers)
        const staleQueued = await drainStaleAlerts()
        console.log(JSON.stringify({ ts: new Date().toISOString(), ...s, staleQueued }))
      } catch (e) {
        console.error('notify-worker 本轮失败:', e instanceof Error ? e.message : e)
        if (once) process.exitCode = 1
      }
      if (once) break
      await new Promise((r) => setTimeout(r, 2000))
    } while (true)
  } finally {
    healthServer.close()
    await pool.end()
  }
}
