// cred-crypto.ts — 渠道凭据的对称加密（spec 2026-10-31 §3.2）。
//
// 选型：AES-256-GCM（带完整性校验）+ KEK 来自 env。不引 KMS：私有化现场没有云 KMS，
// 引了反而多一个必须部署的东西。代价写在 spec §7：**KEK 丢失 = 所有凭据需重录**，
// 所以它进交付 runbook 的备份清单。
//
// 格式：`base64( iv(12) || ciphertext || tag(16) )`——单列存得下，也不需要额外的列。
//
// 纪律（fail-closed）：KEK 缺失或格式不对 ⇒ **抛错**，绝不降级成明文存储，
// 也绝不"跳过加密"——那会让"加密"这件事在某些部署里静默失效。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

/** 从 env 读 KEK：64 个 hex 字符（32 字节）。缺失/格式不对 ⇒ 抛错（fail-closed）。 */
export function kekFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.NOTIFY_CRED_KEK ?? ''
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('NOTIFY_CRED_KEK 未配置或格式不对（需 64 个 hex 字符 = 32 字节）')
  }
  return Buffer.from(raw, 'hex')
}

export function encryptSecret(plain: string, kek: Buffer): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, kek, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64')
}

/**
 * 解密。**任何失败都抛错**（KEK 不对 / 密文被改 / 格式不对）——静默返回空串会让
 * 「凭据坏了」伪装成「凭据是空的」，前者要修密钥，后者要重录，处置完全不同。
 */
export function decryptSecret(enc: string, kek: Buffer): string {
  const buf = Buffer.from(enc, 'base64')
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('凭据密文长度异常（可能被截断）')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const body = buf.subarray(IV_LEN, buf.length - TAG_LEN)
  const d = createDecipheriv(ALGO, kek, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()]).toString('utf8')
}
