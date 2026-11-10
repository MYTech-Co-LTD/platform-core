#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：pg 与仓内 TS 源均经动态 import（同 audit-permission-holders.mjs 的
// createRequire 范式）；纯函数 pickTenants 仍有单测，主流程靠 `pnpm test` / 真机 dry-run 验。
//
// org-sync-all.mjs — 组织同步的定时/批量入口（issue #1819）。
//
// 为什么是仓内脚本而不是 server 内的定时器：仓规「应用进程不跑定时副作用」
// （deploy/notify-jobs.md 首段）；定时由 openship job 调本脚本，失败可见、可重跑、可审计。
//
// 语义：
//   · 默认 dry-run（零写入）；`--apply` 才写 org_node / org_membership；
//   · 逐租户执行，**单租户失败不影响其他租户**，但整体 exit 1（job 通知据此判红）；
//   · 每个租户都落 `platform.audit(action='admin.org-sync')`：
//       成功 = { source:'wecom', dryRun, ...plan }；失败 = { source:'wecom', dryRun, failed:code }
//     `org-sync-freshness` 探针只认 dryRun=false 且无 failed 的行；
//   · 无企微配置的租户：跳过并打印（不猜测、不失败）。
//
// 用法：
//   pnpm exec tsx scripts/org-sync-all.mjs                 # 全租户 dry-run
//   pnpm exec tsx scripts/org-sync-all.mjs --apply         # 全租户写入（job 用这个）
//   pnpm exec tsx scripts/org-sync-all.mjs --org <org>     # 只跑一个租户（排障用）
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * 只保留可识别的租户行；`--org` 时精确匹配。
 * 不在这里过滤「无企微配置」——那要打印 skipped 让运营看见，而不是静默消失。
 *
 * @param {Array<{ id: number, casdoor_org: string, wecom_corp_id: string | null, wecom_secret: string | null }>} rows
 * @param {string | undefined} org
 */
export function pickTenants(rows, org) {
  return rows.filter(
    (t) => typeof t?.casdoor_org === 'string' && (org === undefined || t.casdoor_org === org),
  )
}

/** 一行结果（不打印任何 secret；usersNotInCasdoor 只给数量，清单在 audit 里）。 */
export function formatResult(org, result) {
  return `org-sync: org=${org} dryRun=${result.dryRun} depts=${result.deptCount} users=${result.userCount} `
    + `created=${result.nodesCreated} renamed=${result.nodesRenamed} reparented=${result.nodesReparented} `
    + `disabled=${result.nodesDisabled} reactivated=${result.nodesReactivated} `
    + `members+${result.membersAdded} members-${result.membersRemoved} `
    + `notInCasdoor=${result.usersNotInCasdoor.length}`
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean', default: false },
      org: { type: 'string' },
    },
    allowPositionals: false,
  })
  const apply = values.apply === true
  const orgFilter = typeof values.org === 'string' ? values.org : undefined

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('org-sync-all: 缺 DATABASE_URL')
    return 2
  }
  const missing = ['CASDOOR_URL', 'CASDOOR_ADMIN_USER', 'CASDOOR_ADMIN_PWD']
    .filter((k) => !process.env[k])
  if (missing.length > 0) {
    // Casdoor 只用于 usersNotInCasdoor 清单；缺凭据时**不猜**（否则每个租户都会把全员列为待建）。
    console.error(`org-sync-all: 缺 ${missing.join(' / ')}`)
    return 2
  }

  const { createRequire } = await import('node:module')
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const { fetchWecomSnapshot, runOrgSync, OrgSyncError } = await import('../apps/server/src/org-sync.ts')
  const { syncCredential } = await import('../apps/server/src/org-sync-credential.ts')
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')

  const pool = new Pool({ connectionString: databaseUrl })
  let failed = 0
  try {
    const { rows } = await pool.query(
      'select id, casdoor_org, wecom_corp_id, wecom_secret from platform.tenant order by id',
    )
    const tenants = pickTenants(rows, orgFilter)
    if (tenants.length === 0) {
      if (orgFilter) {
        console.error(`org-sync-all: --org ${orgFilter} 未命中任何租户`)
        return 2
      }
      console.log('org-sync-all: platform.tenant 无租户')
      return 0
    }

    for (const t of tenants) {
      const org = t.casdoor_org
      const cred = syncCredential(t, process.env)
      if (!cred.corpId || !cred.secret) {
        console.log(`org-sync: org=${org} skipped（无企微 corp/secret 配置）`)
        continue
      }

      const writeAudit = async (detail) => {
        await pool.query(
          'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)',
          [t.id, 'system:org-sync', 'admin.org-sync', JSON.stringify(detail)],
        )
      }

      try {
        const cas = new CasdoorClient({
          origin: process.env.CASDOOR_URL,
          clientId: process.env.CASDOOR_CLIENT_ID ?? '',
          clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
          org,
          adminUser: process.env.CASDOOR_ADMIN_USER,
          adminPwd: process.env.CASDOOR_ADMIN_PWD,
        })
        const casdoorNames = new Set((await cas.listUsers()).map((u) => u.name))
        const snapshot = await fetchWecomSnapshot(cred)
        const result = await runOrgSync(pool, t.id, snapshot, {
          dryRun: !apply,
          casdoorNames,
          source: 'wecom',
        })
        await writeAudit({ source: 'wecom', dryRun: !apply, ...result })
        console.log(formatResult(org, result))
      } catch (e) {
        const code = e instanceof OrgSyncError ? e.code : 'SYNC_FAILED'
        failed += 1
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`org-sync: org=${org} FAILED ${code}${code === 'SYNC_FAILED' ? `: ${msg}` : ''}`)
        // 失败也留审计（探针据此保持 STALE）；审计自身失败只记日志，不掩盖原错误。
        try {
          await writeAudit({ source: 'wecom', dryRun: !apply, failed: code })
        } catch (auditErr) {
          console.error(
            `org-sync: org=${org} 失败审计写入失败: ${auditErr instanceof Error ? auditErr.message : auditErr}`,
          )
        }
      }
    }
  } finally {
    await pool.end()
  }
  return failed > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error('org-sync-all 不可执行:', e instanceof Error ? e.message : e)
      process.exitCode = 2
    })
}
