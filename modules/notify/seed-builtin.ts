// seed-builtin.ts — 内置模板 / 默认通道 / 默认规则的开通 seed（幂等）。
// 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §5.4
// - 模板：按 (key, body_hash) 去重；hash 变了才追加 revision 并移动 published_revision。
// - 通道：do nothing（租户后续可改；seed 不覆盖租户配置）。
// - 规则：derived upsert；NOTIFY_APPROVERS__<ORG> 配了就 upsert manual literal 规则（manual 优先）。
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { orgEnvKeyFor } from './domain/org-env'
import { BUILTIN_TEMPLATES } from './templates/builtin'

export type SeedStats = {
  tenants: number
  templates: number
  channels: number
  rules: number
}

const EVENT = 'aftersales.employee_approval.pending'
const TEMPLATE = 'aftersales_employee_approval_pending'
const CHANNELS = ['wecom_default', 'inapp_default']

export async function seedBuiltin(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  orgs: string[],
): Promise<SeedStats> {
  // B1：模块不读 platform schema；租户清单由 scripts/notify-seed-builtin.mjs 查好注入
  const targets = orgs

  let templates = 0
  let channels = 0
  let rules = 0

  for (const org of targets) {
    for (const tpl of BUILTIN_TEMPLATES) {
      const hash = createHash('sha256')
        .update(JSON.stringify(tpl.contents))
        .digest('hex')
        .slice(0, 16)

      const ins = await pool.query(
        `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
         values ($1,$2,$3,$4,'published','builtin',1,'system')
         on conflict (org,key) do nothing`,
        [org, tpl.key, tpl.name, tpl.eventKey],
      )
      templates += ins.rowCount ?? 0

      const exists = await pool.query(
        'select 1 from notify.template_revision where org=$1 and key=$2 and body_hash=$3',
        [org, tpl.key, hash],
      )
      if (exists.rows.length === 0) {
        const max = await pool.query<{ max: number }>(
          'select coalesce(max(revision),0)::int as max from notify.template_revision where org=$1 and key=$2',
          [org, tpl.key],
        )
        const next = Number(max.rows[0]!.max) + 1
        await pool.query(
          `insert into notify.template_revision
             (org,key,revision,contents,body_hash,review_status,created_by,approved_by,approved_at)
           values ($1,$2,$3,$4::jsonb,$5,'approved','system','system',now())`,
          [org, tpl.key, next, JSON.stringify(tpl.contents), hash],
        )
        await pool.query(
          'update notify.template set published_revision=$3, updated_at=now() where org=$1 and key=$2',
          [org, tpl.key, next],
        )
      }
    }

    const fallback = env[orgEnvKeyFor('WECOM_ADDRESS_FALLBACK', org)] === 'casdoor_name'
      ? 'casdoor_name'
      : 'none'
    const chIns = await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,jsonb_build_object('address_fallback',$3::text),
               jsonb_build_object('bridge_url',$2::text),'system')
       on conflict (org,id) do nothing`,
      [org, orgEnvKeyFor('WECOM_BRIDGE_URL', org), fallback],
    )
    channels += chIns.rowCount ?? 0

    const inapp = await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'inapp_default','in_app',true,'{}'::jsonb,'{}'::jsonb,'system')
       on conflict (org,id) do nothing`,
      [org],
    )
    channels += inapp.rowCount ?? 0

    const derived = await pool.query(
      `insert into notify.rule
         (org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
       values ($1,$2,true,$3,'*','approvers',$4,$5::text[],'derived','system')
       on conflict (org,id) do update set enabled=true, template_key=excluded.template_key,
         channels=excluded.channels`,
      [org, `derived:aftersales:${EVENT}:*`, EVENT, TEMPLATE, CHANNELS],
    )
    rules += derived.rowCount ?? 0

    // 集成健康 STALE 的派生规则（spec 2026-10-31 §2.4）：收件人 = 持 tenant:admin 的人；
    // **只走 in_app**——企微通道本身可能正是坏掉的那一个，用坏通道报坏消息是自欺。
    // 这也是变异验证的观察面：行会落到 notify.inbox / delivery。
    const staleRule = await pool.query(
      `insert into notify.rule
         (org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
       values ($1,$2,true,$3,'*','admins',$4,'{inapp_default}'::text[],'derived','system')
       on conflict (org,id) do update set enabled=true, template_key=excluded.template_key,
         channels=excluded.channels`,
      [org, 'derived:notify:notify.integration.stale:*', 'notify.integration.stale', 'notify_integration_stale'],
    )
    rules += staleRule.rowCount ?? 0

    const names = (env[orgEnvKeyFor('NOTIFY_APPROVERS', org)] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (names.length > 0) {
      const manual = await pool.query(
        `insert into notify.rule
           (org,id,enabled,event_key,scope,recipient_key,recipient_literal,template_key,channels,origin,created_by)
         values ($1,$2,true,$3,'*','approvers_manual',$4::text[],$5,$6::text[],'manual','system')
         on conflict (org,id) do update set recipient_literal=excluded.recipient_literal,
           template_key=excluded.template_key, channels=excluded.channels, enabled=true`,
        [org, `manual:aftersales:${EVENT}:*`, EVENT, names, TEMPLATE, CHANNELS],
      )
      rules += manual.rowCount ?? 0
    }
  }

  return { tenants: targets.length, templates, channels, rules }
}
