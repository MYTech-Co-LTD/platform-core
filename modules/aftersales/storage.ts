// storage.ts — 天翼 ZOS（S3 兼容）预签名 + **按请求解析配置**（M3c 步 4）。
//
// 为什么预签名是【必选】而不是优化（spec §2.3）：移动端附件是手机拍的图片+视频，而平台全局
// bodyLimit ~1MiB —— 视频过服务器必炸。所以字节全程不过平台：上传/下载都换成短 TTL 的
// 预签名 URL，服务端只记录元数据。
//
// 两个实测坑（WeKnora 两条条目背书），都在下面用代码兜住：
//   ① endpoint 常被写成【不带协议】的域名 ⇒ 由 SDK 的 `normalizeEndpoint` 补 https://
//   ② ZOS 必须【path-style】 ⇒ S3Client 的 forcePathStyle: true
//
// ⚠️ M3c 步 4 起本模块**不再在装载期读 env**：配置按请求从 context 键 `TENANT_STORAGE` 取
// （宿主投影，声明了 manifest `storage` 的模块才有）。本文件因此只剩三类东西：
//   ① `ZosStorage`（保留原样）+ key/TTL 工具；
//   ② **配置 → client** 的解析与缓存（`storageFor` / `storageCandidatesFor` / `storageResolverFor`）；
//   ③ 读侧解析不出来时的**去重告警**（那是该故障在平台侧的唯一信号）。
// 解析/规范化的**实现只有一份**，在 `@platform/sdk`（T1）；本模块只消费，不复制。

import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { platformStorageFromEnv, storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'

export const UPLOAD_URL_TTL_SECONDS = 600
export const DOWNLOAD_URL_TTL_SECONDS = 600

// ── 配置 → client（按**配置指纹**缓存） ──

/** client 池：**按配置指纹缓存**，绝不每请求 new（每次 new = 重新解析凭据 + 新建连接池 +
 *  keep-alive 全失效，而单模块的请求量级下这是纯亏）。
 *  指纹**不含 SK 明文**（拿明文做键等于把密钥摊在内存里做索引）；SK 轮换必然伴随 AK 或桶变更，
 *  故 `ref|AK` 足以区分。
 *  容量按**租户数量级**设上界（不是请求量级）——单进程同时活跃的配置数 = 活跃租户数。
 *  ⚠️ 缓存键是**配置值**，不是 org：模块**没有任何途径**指定/感知 org 作为配置来源
 *  （正典「安全性质」第 1 条明确排除「按 org 的解析器」）。 */
const CLIENT_CACHE_MAX = 64
const clientCache = new Map<string, ZosStorage>()

export function storageFor(cfg: TenantStorageConfig): ZosStorage {
  const key = `${storageRefOf(cfg)}|${cfg.accessKeyId}`
  let s = clientCache.get(key)
  if (!s) {
    // 满了就淘汰最早插入的那个（Map 保持插入序 ⇒ 这是 FIFO，不是 LRU；对配置池够用且无状态）
    if (clientCache.size >= CLIENT_CACHE_MAX) clientCache.delete(clientCache.keys().next().value as string)
    s = new ZosStorage(cfg)
    clientCache.set(key, s)
  }
  return s
}

/**
 * 本请求的候选集合。**必须含平台默认**：早期行（`storage_ref = ''`）与「租户未配时上传的行」
 * 写的都是平台桶；只认注入值会让「租户从未配 → 配了自己的桶」这个**最常见的**切换把老附件全读丢
 * —— 而这条路径正是裁定 ② 要修的东西。
 *
 * 为什么整包导出而不是塞进 resolver 内部：调用方要靠 `all.length` 把两种失败分开
 * （「本租户压根没配」与「配置换过、旧桶读不了」对运维是两条完全不同的处置）。
 */
export interface StorageCandidates {
  /** 本次请求注入的配置（租户配置，或未配时的平台默认）；undefined = 本请求没有任何可用配置 */
  injected: TenantStorageConfig | undefined
  /** 平台默认（早期行的归属）；null = env 不全 ⇒ 没有平台默认 */
  platformDefault: TenantStorageConfig | null
  /** 有序候选（`injected` 在前、同 ref 去重） */
  all: TenantStorageConfig[]
}

export function storageCandidatesFor(injected: TenantStorageConfig | undefined): StorageCandidates {
  const platformDefault = platformStorageFromEnv(process.env)
  const all: TenantStorageConfig[] = []
  for (const c of [injected, platformDefault]) {
    if (c && !all.some((x) => storageRefOf(x) === storageRefOf(c))) all.push(c)
  }
  return { injected, platformDefault, all }
}

/** 读侧解析器：给定行上的 `storage_ref`，回可用的存储客户端（null = 这个对象读不出来）。 */
export function storageResolverFor(cands: StorageCandidates) {
  return (ref: string): ZosStorage | null => {
    // 空 ref = 本列引入前写入的行 ⇒ 平台默认（引入前唯一存在的配置就是平台 env 五键）
    if (ref === '') return cands.platformDefault ? storageFor(cands.platformDefault) : null
    const hit = cands.all.find((c) => storageRefOf(c) === ref)
    return hit ? storageFor(hit) : null
  }
}

/**
 * ref 解析不出来 = **平台侧唯一的信号**（客户端只会看到「附件打不开」，预签名是本地计算、
 * 平台发不出这个错）。但不能每请求刷一行 —— 按 `org + ref` 去重 60s（照 session-middleware
 * 的 warnDegrade 手法）。日志含 org 与 ref，**不含任何凭据**。
 *
 * ⚠️ 去重意味着**同一个 (org, ref) 60s 内只有第一条可见**；测试要断言它就得避开这个键
 * （见 routes/ticket.test.ts 里两条用例各用一个 ghost ref 的原因）。
 */
const REF_WARN_INTERVAL_MS = 60_000
const lastRefWarnAt = new Map<string, number>()
export function warnUnresolvedRef(org: string, ref: string): void {
  const key = `${org}|${ref}`
  const now = Date.now()
  if (now - (lastRefWarnAt.get(key) ?? 0) < REF_WARN_INTERVAL_MS) return
  lastRefWarnAt.set(key, now)
  console.warn(
    `[aftersales] 附件读不出来：org=${org} 的行记录了 ref=${ref}，但当前既不是本租户配置也不是平台默认`
      + '（配置换过 / 凭据失效 ⇒ 平台侧无法为它签名）。这条 warn 是该故障在本仓的唯一信号。',
  )
}

/** org 段净化：spec §2.3 要求 key 里不出现裸 `=` 等需编码字符。 */
export function sanitizeOrgSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * 对象 key：`aftersales/{org}/{ticket_ref}/{uuid}`。
 * `ticket_ref` 是【客户端幂等键】而不是库内主键——移动端先传图后提交，预签名时工单还没落库
 * （spec §2.3，2026-09-15 定）。
 *
 * `uuid` 显式注 `string`（第三参只做字符串拼接，不参与任何校验）：不注的话 TS 取**默认值的
 * 推导类型** `randomUUID()` 的 `` `${string}-${string}-…` `` 模板字面量型，把「只给测试用的
 * 定值注入点」意外锁成 UUID 形状铁律——storage.test.ts 传 `'u'` 就撞 TS2345（issue #68
 * Step 3）。**注 `string` 不是放松**：函数本来就只把它插进模板串，形状从来不是它的事；
 * 真机路径全部走缺省值 `randomUUID()`，不受影响。
 */
export function objectKeyFor(org: string, clientRequestId: string, uuid: string = randomUUID()): string {
  return `aftersales/${sanitizeOrgSegment(org)}/${sanitizeOrgSegment(clientRequestId)}/${uuid}`
}

/**
 * ZOS 预签名客户端。**只被 `storageFor` 构造**（按配置指纹缓存），调用方拿到的永远是池里那一个。
 */
export class ZosStorage {
  private readonly client: S3Client

  /** client 可注入【仅供测试】（storage.test.ts 断言 DeleteObjectCommand 的形状，不发网络）；
   *  生产路径恒走缺省值——storageFor 构造的池化实例从不传第二参。 */
  constructor(private readonly config: TenantStorageConfig, client?: S3Client) {
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // 见文件头 ②：ZOS 实测必须 path-style，否则 bucket 会被当成 DNS 子域拼进 host。
      forcePathStyle: true,
    })
  }

  /** GC（spec §5 #12）删对象。S3 语义：key 不存在也成功（204）⇒ GC 崩溃后重跑天然幂等。 */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
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
