// channel-config.ts — 「这条通道在这个实例上配好了吗」（唯一实现）。
//
// 为什么不是 storage.channelConfigured：那个只看 `secret_refs` 指向的 env 是否齐全，
// 那是**桥**的判据。直连通道根本不消费 secret_refs（它要的是 channel_credential / WECOM_DIRECT__），
// 沿用旧判据会把「直连已配好」误报成 `unconfigured` —— 交付性预检据此会把规则判成不可送达。
//
// 语义：**transport 决定"配好"的含义**
//   · `direct` ⇒ 凭据能解析出来（DB 密文可解 / env 齐备）；
//   · 其余     ⇒ secret_refs 的 env 键齐全（与改造前逐字一致）。
import type { Pool } from 'pg'
import { resolveWecomCredential } from './credential-store'
import { channelConfigured } from '../storage'

export interface ChannelLike {
  provider: string
  config: Record<string, unknown>
  secret_refs?: Record<string, string>
  secretRefs?: Record<string, string>
}

export async function channelIsConfigured(
  pool: Pool,
  org: string,
  ch: ChannelLike,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (ch.provider === 'wecom_chat' && ch.config.transport === 'direct') {
    return (await resolveWecomCredential(pool, org, env)).ok
  }
  return channelConfigured(ch.secret_refs ?? ch.secretRefs ?? {}, env)
}
