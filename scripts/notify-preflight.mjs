#!/usr/bin/env node
// scripts/notify-preflight.mjs — 全量规则可送达性体检（**只读**）。
//
// 正典：docs/superpowers/specs/2026-10-28-notify-deliverability-design.md §5.4
// 退出码：0 全部可送达；1 存在阻塞规则；2 查不成账（缺 env / 查询失败）。
//
// ⚠️ 只纳入「不依赖真实 payload」的规则（recipientKind ∈ scope_holders / literal）。
//    field 类必须真实 payload，sample 无意义 ⇒ **跳过并单独计数**（不是「通过」）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { listRules } from '../modules/notify/storage.ts'
import { resolveDeliverability } from '../modules/notify/domain/deliverability.ts'
import { samplePayload } from '../modules/notify/domain/template.ts'

/**
 * 挑出可体检的规则：只取收件人种类为 scope_holders 的（literal 已在规则行里，无需解析，
 * 但也可体检「模板/通道」是否就绪）。field 类跳过。
 *
 * @param {ReadonlyArray<{ id: string, eventKey: string, recipientKey: string }>} rules
 * @param {(eventKey: string) => ({ recipients?: Record<string, { kind?: string }> } | null)} declOf
 * @returns {{ checkable: Array<{ rule: any, decl: any }>, skipped: string[] }}
 */
export function pickCheckable(rules, declOf) {
  const checkable = []
  const skipped = []
  for (const rule of rules) {
    const decl = declOf(rule.eventKey)
    const kind = decl?.recipients?.[rule.recipientKey]?.kind
    if (kind === 'field') {
      skipped.push(rule.id)
      continue
    }
    checkable.push({ rule, decl })
  }
  return { checkable, skipped }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-preflight: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const require_ = createRequire(import.meta.url)
  const { Pool } = require_('pg')
  const pool = new Pool({ connectionString: url })

  try {
    /** @type {Map<string, any>} */
    const declCache = new Map()
    /** @param {string} key */
    const getEventDecl = async (key) => {
      if (declCache.has(key)) return declCache.get(key)
      const { rows } = await pool.query(
        'select payload_schema, recipients, scope_key from platform.event_catalog where key=$1 and active',
        [key],
      )
      const r = rows[0]
      const d = r
        ? {
            key, title: '',
            payload: r.payload_schema,
            recipients: r.recipients,
            scope: r.scope_key ? { key: r.scope_key } : undefined,
          }
        : null
      declCache.set(key, d)
      return d
    }

    // 权限码持有者：与 worker 同一实现（宿主侧）
    let resolveScopeHolderNames = null
    if (process.env.CASDOOR_URL && process.env.CASDOOR_ADMIN_USER && process.env.CASDOOR_ADMIN_PWD) {
      const { createScopeHolderResolver } = await import('../apps/server/src/scope-holders.ts')
      const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
      resolveScopeHolderNames = createScopeHolderResolver((org) => new CasdoorClient({
        origin: String(process.env.CASDOOR_URL),
        clientId: process.env.CASDOOR_CLIENT_ID ?? '',
        clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
        org,
        adminUser: String(process.env.CASDOOR_ADMIN_USER),
        adminPwd: String(process.env.CASDOOR_ADMIN_PWD),
      }))
    }

    const { rows: tenants } = await pool.query(
      'select casdoor_org from platform.tenant order by casdoor_org')

    const blocked = []
    let checked = 0
    let skippedCount = 0

    for (const { casdoor_org: org } of tenants) {
      const rules = (await listRules(pool, org)).filter((r) => r.enabled)
      // 先预热 decl 缓存：pickCheckable 用的是**同步**读（纯函数，便于单测）
      for (const r of rules) await getEventDecl(r.eventKey)

      const { checkable: ready, skipped } = pickCheckable(
        rules, (k) => declCache.get(k) ?? null)
      skippedCount += skipped.length

      for (const { rule } of ready) {
        const decl = declCache.get(rule.eventKey)
        if (!decl) {
          blocked.push({ org, ruleId: rule.id, eventKey: rule.eventKey, blocked: 'event_missing' })
          continue
        }
        const r = await resolveDeliverability(
          { org, rule, payload: samplePayload(decl) },
          {
            getEventDecl: async (k) => declCache.get(k) ?? null,
            getPublishedTemplate: async (o, k) => {
              const { rows } = await pool.query(
                `select rv.revision, rv.contents from notify.template t
                   join notify.template_revision rv
                     on rv.org=t.org and rv.key=t.key and rv.revision=t.published_revision
                  where t.org=$1 and t.key=$2 and t.status='published'`, [o, k])
              return rows[0] ? { revision: rows[0].revision, contents: rows[0].contents } : null
            },
            getChannel: async (o, id) => {
              const { rows } = await pool.query(
                'select id,provider,enabled,config from notify.channel where org=$1 and id=$2', [o, id])
              const ch = rows[0]
              return ch ? { id: ch.id, provider: ch.provider, enabled: ch.enabled, config: ch.config } : null
            },
            // createScopeHolderResolver 的签名是 (org, permissionCode)（decl 不参与）
            resolveScopeHolders: async (o, key) =>
              resolveScopeHolderNames ? resolveScopeHolderNames(o, key) : [],
          },
        )
        checked++
        if (r.blocked !== null) {
          blocked.push({ org, ruleId: rule.id, eventKey: rule.eventKey, blocked: r.blocked })
        }
      }
    }

    console.log(JSON.stringify({
      tenants: tenants.length, checked, skippedFieldRules: skippedCount,
      blockedCount: blocked.length,
      scopeHoldersUnavailable: resolveScopeHolderNames === null,
      blocked,
    }))
    process.exit(blocked.length > 0 ? 1 : 0)
  } catch (e) {
    console.error('notify-preflight 查不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
