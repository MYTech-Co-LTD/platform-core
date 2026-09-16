// storage.ts — 天翼 ZOS（S3 兼容）预签名。
//
// 为什么预签名是【必选】而不是优化（spec §2.3）：移动端附件是手机拍的图片+视频，而平台全局
// bodyLimit ~1MiB —— 视频过服务器必炸。所以字节全程不过平台：上传/下载都换成短 TTL 的
// 预签名 URL，服务端只记录元数据。
//
// 两个实测坑（WeKnora 两条条目背书），都在下面用代码兜住：
//   ① endpoint 常被写成【不带协议】的域名 ⇒ normalizeEndpoint 补 https://
//   ② ZOS 必须【path-style】 ⇒ S3Client 的 forcePathStyle: true

import { randomUUID } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/** 五个键的【名字】就是契约（B9 门禁要求它们出现在根 .env.example）。值只落 openship env(isSecret)。 */
const ENV_KEYS = [
  'AFTERSALES_ZOS_ENDPOINT',
  'AFTERSALES_ZOS_REGION',
  'AFTERSALES_ZOS_BUCKET',
  'AFTERSALES_ZOS_ACCESS_KEY',
  'AFTERSALES_ZOS_SECRET',
] as const

export const UPLOAD_URL_TTL_SECONDS = 600
export const DOWNLOAD_URL_TTL_SECONDS = 600

export interface ZosConfig {
  /** 已规范化（含协议、无尾斜杠） */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/** endpoint 可能没写协议 ⇒ 补 https://；顺带吃掉空白与尾斜杠。见文件头 ①。 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** org 段净化：spec §2.3 要求 key 里不出现裸 `=` 等需编码字符。 */
export function sanitizeOrgSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * 对象 key：`aftersales/{org}/{ticket_ref}/{uuid}`。
 * `ticket_ref` 是【客户端幂等键】而不是库内主键——移动端先传图后提交，预签名时工单还没落库
 * （spec §2.3，2026-09-15 定）。
 */
export function objectKeyFor(org: string, clientRequestId: string, uuid = randomUUID()): string {
  return `aftersales/${sanitizeOrgSegment(org)}/${sanitizeOrgSegment(clientRequestId)}/${uuid}`
}

/**
 * 从 env 读配置。**五个键缺任何一个就返回 null** —— 这是刻意的：
 * CI 与本地开发没有 ZOS 凭证，若这里抛错，模块装载就会失败（而装载失败是【进程起不来】）。
 * 代价由附件端点承担：storage 为 null 时它们回 503 ZOS_NOT_CONFIGURED，其余域照常工作。
 */
export function zosConfigFromEnv(env: NodeJS.ProcessEnv): ZosConfig | null {
  const values = ENV_KEYS.map((k) => env[k])
  if (values.some((v) => !v)) return null
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values as [
    string, string, string, string, string,
  ]
  return { endpoint: normalizeEndpoint(endpoint), region, bucket, accessKeyId, secretAccessKey }
}

export class ZosStorage {
  private readonly client: S3Client

  constructor(private readonly config: ZosConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // 见文件头 ②：ZOS 实测必须 path-style，否则 bucket 会被当成 DNS 子域拼进 host。
      forcePathStyle: true,
    })
  }

  presignPut(
    key: string,
    contentType: string,
    expiresIn: number = UPLOAD_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: contentType }),
      { expiresIn },
    )
  }

  presignGet(key: string, expiresIn: number = DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    )
  }
}
