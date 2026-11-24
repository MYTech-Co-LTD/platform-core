// credential-store.ts — 渠道凭据的读写（spec 2026-10-31 §3.2）。
//
// 读取顺序（**单一实现**，worker 与 CLI 共用）：
//   ① DB `notify.channel_credential`（密文，KEK 解密）——自助/多租户路线；
//   ② env `WECOM_DIRECT__<ORG>` = `corpId|agentId|secret` —— 私有化交付路线（凭据不进库）；
//   ③ 都没有 ⇒ `null`（通道未配置直连，调用方落 `credential_missing`，**不静默降级到桥**）。
//
// 为什么 ③ 不回落桥：回落会把"这台机器配错了直连"伪装成"照常工作"，而那正是本设计的反面。
// 要回桥就把通道配置改回 `transport: 'bridge'`——那是**显式**动作，看得见。
import type { Pool } from 'pg'
import { decryptSecret, encryptSecret, kekFromEnv } from './cred-crypto'
import { orgEnvKeyFor } from './org-env'
import type { WechatOaCred } from './im/wechat-oa'
import type { WecomDirectCred } from './im/wecom-direct'

export interface CredentialRow {
  org: string
  provider: string
  appKey: string
  agentId: string | null
}

/** 读 DB 里的密文行（不解密；控制台只需 appKey 尾号）。 */
export async function getCredentialMeta(
  pool: Pool, org: string, provider: string,
): Promise<CredentialRow | null> {
  const r = await pool.query(
    'select org, provider, app_key, agent_id from notify.channel_credential where org = $1 and provider = $2',
    [org, provider],
  )
  if ((r.rowCount ?? 0) === 0) return null
  const row = r.rows[0] as { org: string; provider: string; app_key: string; agent_id: string | null }
  return { org: row.org, provider: row.provider, appKey: row.app_key, agentId: row.agent_id }
}

/**
 * 写/更新凭据（加密后落库）。
 * `actor` 进审计由调用方负责（本层只落表）。KEK 缺失 ⇒ 抛错（**绝不落明文**）。
 */
export async function upsertCredential(
  pool: Pool, org: string, provider: string,
  cred: { appKey: string; agentId?: string | null; secret: string },
  actor: string, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const kek = kekFromEnv(env) // 缺失 ⇒ 抛
  await pool.query(
    `insert into notify.channel_credential(org, provider, app_key, agent_id, secret_enc, key_version, created_by)
     values ($1,$2,$3,$4,$5,1,$6)
     on conflict (org, provider) do update
       set app_key = excluded.app_key,
           agent_id = excluded.agent_id,
           secret_enc = excluded.secret_enc,
           key_version = excluded.key_version,
           rotated_at = now()`,
    [org, provider, cred.appKey, cred.agentId ?? null, encryptSecret(cred.secret, kek), actor],
  )
}

/** 渠道凭据的联合：企微（corpId/agentId/secret）与公众号（appId/appSecret）。
 *  两个解析器各自窄化自己的形状，调用方按 provider 收窄——**不做统一形状**（字段语义不同）。 */
export type ChannelCredential = WecomDirectCred | WechatOaCred

export type CredentialResolution =
  | { ok: true; source: 'db' | 'env'; cred: ChannelCredential }
  | { ok: false; reason: 'missing' | 'kek_missing' | 'env_malformed' | 'decrypt_failed'; detail?: string }

/** 解析企微直连凭据（DB 优先，env 兜底）。**不静默降级**——解析不到就返回原因。 */
/**
 * 公众号模板消息凭据（#2805）：appId + appSecret。
 *
 * 复用同一张 `notify.channel_credential`（provider='wechat_oa'）与同一把 KEK——
 * 凭据**只有一份加密实现**（本文件顶部纪律），不给第二个 provider 造第二套存储。
 * env 兜底形态：`WECHAT_OA_DIRECT__<ORG>` = `appId|appSecret`（与企微同款命名）。
 */
export async function resolveWechatOaCredential(
  pool: Pool, org: string, env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialResolution> {
  const r = await pool.query(
    'select app_key, secret_enc from notify.channel_credential where org = $1 and provider = $2',
    [org, 'wechat_oa'],
  )
  if ((r.rowCount ?? 0) > 0) {
    const row = r.rows[0] as { app_key: string; secret_enc: string }
    try {
      const kek = kekFromEnv(env)
      return { ok: true, source: 'db', cred: { appId: row.app_key, appSecret: decryptSecret(row.secret_enc, kek) } }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg.startsWith('NOTIFY_CRED_KEK') ? 'kek_missing' : 'decrypt_failed', detail: msg }
    }
  }

  const raw = env[orgEnvKeyFor('WECHAT_OA_DIRECT', org)]
  if (raw === undefined || raw === '') return { ok: false, reason: 'missing' }
  const [appId, appSecret] = raw.split('|')
  if (!appId || !appSecret) {
    return { ok: false, reason: 'env_malformed', detail: 'WECHAT_OA_DIRECT__<ORG> 需为 appId|appSecret' }
  }
  return { ok: true, source: 'env', cred: { appId, appSecret } }
}

export async function resolveWecomCredential(
  pool: Pool, org: string, env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialResolution> {
  const r = await pool.query(
    'select app_key, agent_id, secret_enc from notify.channel_credential where org = $1 and provider = $2',
    [org, 'wecom'],
  )
  if ((r.rowCount ?? 0) > 0) {
    const row = r.rows[0] as { app_key: string; agent_id: string | null; secret_enc: string }
    try {
      const kek = kekFromEnv(env)
      return {
        ok: true,
        source: 'db',
        cred: { corpId: row.app_key, agentId: row.agent_id ?? '', secret: decryptSecret(row.secret_enc, kek) },
      }
    } catch (e) {
      // 无法区分「KEK 没配」与「KEK 不对」时，用 message 前缀判断给调用方更准的码
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg.startsWith('NOTIFY_CRED_KEK') ? 'kek_missing' : 'decrypt_failed', detail: msg }
    }
  }

  const raw = env[orgEnvKeyFor('WECOM_DIRECT', org)]
  if (raw === undefined || raw === '') return { ok: false, reason: 'missing' }
  const [corpId, agentId, secret] = raw.split('|')
  if (!corpId || !agentId || !secret) {
    return { ok: false, reason: 'env_malformed', detail: 'WECOM_DIRECT__<ORG> 需为 corpId|agentId|secret' }
  }
  return { ok: true, source: 'env', cred: { corpId, agentId, secret } }
}
