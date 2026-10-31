#!/usr/bin/env node
// scripts/notify-import-wecom-cred.mjs — 把 `platform.tenant` 的企微应用凭据**一次性导入**
// `notify.channel_credential`（加密落库），供直连发送使用。
//
// 为什么要有它：operators 不该手抄 secret（抄错 = 静默 40013，且没人愿意在生产里手打密钥）。
// 本脚本让凭据从**已在库里的登录凭据**流向出站表，全程不打印明文。
//
// 用法（生产机容器内 / 本地有 DATABASE_URL 时）：
//   node scripts/notify-import-wecom-cred.mjs                     # 预演：只列 org / corpId / agentId / secret 长度
//   node scripts/notify-import-wecom-cred.mjs --apply             # 真写（需 NOTIFY_CRED_KEK）
//   node scripts/notify-import-wecom-cred.mjs --org shanhaiyiguo-org --apply
//
// 纪律：
//   · **默认预演**，写库必须显式 `--apply`（这是改凭据表的操作，不该一次误敲就落）。
//   · 只导 `wecom_corp_id`/`wecom_agent_id`/`wecom_secret` **三者齐全**的租户；缺的跳过并点名
//     （缺了写进去也发不出消息，反而让"表里有行"看起来像配好了）。
//   · KEK 缺失 ⇒ 直接失败退出（**绝不落明文**，见 modules/notify/domain/cred-crypto.ts）。
//   · 输出只给 secret 的**长度**与前 4 位尾号，不打印明文。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const usage = `notify-import-wecom-cred [--apply] [--org <org>]`

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ apply: boolean, org: string | null }} */
  const out = { apply: false, org: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--org') out.org = argv[++i] ?? null
    else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0) }
    else { console.error(`未知参数: ${a}\n${usage}`); process.exit(2) }
  }
  return out
}

/** 只露出可安全打印的凭据指纹。 */
/** @param {string} s */
function fingerprint(s) {
  return `${s.length} 字符 / 尾号 ${s.slice(-4)}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const { upsertCredential } = await import('../modules/notify/domain/credential-store.ts')
  const { kekFromEnv } = await import('../modules/notify/domain/cred-crypto.ts')

  // 写库前就把 KEK 校验掉：避免"连了半天库、导到最后一个才发现 KEK 没配"
  if (args.apply) {
    try { kekFromEnv(process.env) } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
  }

  const pool = new Pool({ connectionString: url })
  try {
    const { rows } = await pool.query(
      // ⚠️ `platform.tenant` 的租户键叫 `casdoor_org`（不是 `org`；`org` 在 notify 自己的表里）。
      // 2026-10-31 生产实测：写成 `org` ⇒ `column "org" does not exist`（脚本根本跑不起来）。
      `select casdoor_org as org, wecom_corp_id, wecom_agent_id, wecom_secret
         from platform.tenant
        where ($1::text is null or casdoor_org = $1)
        order by casdoor_org`,
      [args.org],
    )
    if (rows.length === 0) {
      console.error(args.org ? `✗ 没有匹配 org='${args.org}' 的租户` : '✗ platform.tenant 为空')
      process.exit(1)
    }

    /** @type {Array<{ org: string, corpId: string, agentId: string, secret: string }>} */
    const ready = []
    /** @type {string[]} */
    const skipped = []
    for (const r of rows) {
      const corpId = r.wecom_corp_id ?? ''
      const agentId = r.wecom_agent_id ?? ''
      const secret = r.wecom_secret ?? ''
      if (!corpId || !agentId || !secret) {
        const miss = [!corpId && 'wecom_corp_id', !agentId && 'wecom_agent_id', !secret && 'wecom_secret']
          .filter(Boolean).join(',')
        skipped.push(`${r.org}（缺 ${miss}）`)
        continue
      }
      ready.push({ org: r.org, corpId, agentId, secret })
      console.log(`· ${r.org}  corpId=${corpId}  agentId=${agentId}  secret=${fingerprint(secret)}`)
    }

    for (const s of skipped) console.log(`- 跳过 ${s}`)
    if (skipped.length > 0) {
      // 跳过是**可见**的失败而不是静默：这些租户直连会 fail-closed（credential_missing）
      console.warn(`⚠ ${skipped.length} 个租户凭据不全，未导入（直连会报 credential_missing）`)
    }

    if (ready.length === 0) {
      console.error('✗ 没有可导入的租户')
      process.exit(1)
    }

    if (!args.apply) {
      console.log(`\n预演：将导入 ${ready.length} 条到 notify.channel_credential。加 --apply 真写。`)
      return
    }

    for (const r of ready) {
      await upsertCredential(
        pool, r.org, 'wecom',
        { appKey: r.corpId, agentId: r.agentId, secret: r.secret },
        'script:notify-import-wecom-cred',
      )
      console.log(`✓ ${r.org} 已写入（密文）`)
    }

    // 回读验**目标状态**：行在、secret 是密文（不是明文、不空）
    const back = await pool.query(
      `select org, app_key, agent_id, secret_enc, length(secret_enc) as enc_len
         from notify.channel_credential where provider = 'wecom' order by org`,
    )
    for (const b of back.rows) {
      const looksEncrypted = b.secret_enc !== b.app_key && b.enc_len > 40
      console.log(`  复查 ${b.org}: app_key=${b.app_key} agent=${b.agent_id} secret_enc=${b.enc_len}B ${looksEncrypted ? '（密文）' : '（⚠ 形状可疑）'}`)
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
