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
  } else {
    console.warn('notify-worker: 缺 CASDOOR_* 凭据 ⇒ scope_holders 不解析（仅 manual literal 规则可用）')
  }

  const once = process.argv.includes('--once')

  try {
    do {
      try {
        const s = await runOnceCli(pool, getEventDecl, process.env, resolveScopeHolderNames)
        console.log(JSON.stringify({ ts: new Date().toISOString(), ...s }))
      } catch (e) {
        console.error('notify-worker 本轮失败:', e instanceof Error ? e.message : e)
        if (once) process.exitCode = 1
      }
      if (once) break
      await new Promise((r) => setTimeout(r, 2000))
    } while (true)
  } finally {
    await pool.end()
  }
}
