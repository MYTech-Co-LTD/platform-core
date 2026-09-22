// metabase.ts — Metabase 客户端**纯核**（fetch 可注入，不读 env、不碰 DB）。
//
// 为什么平台必须自己实现这一层（spec §4 / §6.4）：官方 MCP 与 Agent API **都没有嵌入工具**
// ⇒「发布（enable_embedding）+ 锁参数（embedding_params）」只能走**未版本化的老 API**；
// 且官方 MCP 的鉴权是「绑定连接者本人的 Metabase 权限」= 要求调用者有 Metabase 账号，
// 与「用户不落 Metabase」冲突 ⇒ 报表制作必须经平台（facade 是唯一的鉴权与定租户点）。
//
// 幂等自实现（spec §6.5 原话）：API **无按名 upsert**，`POST` 恒创建、`PUT /{id}` 按 id 覆盖。
// 做法 = `GET /api/search` → 有则 `PUT`、无则 `POST`。
//
// ⚠️ 对账的**正规可观测面**（spec §6.5 逐字）：`GET /api/dashboard/embeddable` /
//    `GET /api/card/embeddable` / `GET /api/dashboard/{id}` 回读。**不要去看 iframe**——
//    报表被 unpublish/删除后嵌入方显示什么，官方文档没有任何说明，属**不可观测**面。
//
// 失败一律 fail-closed：非 2xx 抛、形状不对抛、网络错上抛。**绝不把「读不到」吞成「空结果」**
// ——对账号称是「无差集」，那是把假绿写进对账机制（M3c 教训：配了但不对，在请求路径上不可观测）。
import { createHmac } from 'node:crypto'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** 调 Metabase 内容 API 所需的最小依赖（服务账号 API key，最小权限 group，spec §6.5）。 */
export interface MetabaseDeps {
  fetcher: FetchLike
  baseUrl: string
  apiKey: string
}

/** 三件套：内容 API 用 url+apiKey；签嵌入 JWT 只用 secretKey。 */
export interface MetabaseConfig {
  baseUrl: string
  apiKey: string
  secretKey: string
}

export interface EmbedParamSpec {
  name: string
  mode: 'locked' | 'enabled' | 'disabled'
}

export interface MbUpsertResult {
  id: number
  created: boolean
}

/**
 * 只有**可安全外泄**的理由：状态码，不带响应体。
 * 供应商侧常把请求原文回显（Metabase 的 401 就把 API key 原文写在 message 里）⇒ 回显即泄凭证。
 */
export class MetabaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'MetabaseError'
  }
}

/** 200 但形状不认识——单列一个码，便于把「Metabase 换了响应形状」与「请求本身失败」分开排障。 */
const SHAPE_ERROR = 'UNEXPECTED_SHAPE'

/** 一次 JSON 调用。`body === undefined` ⇒ 不带 content-type/body（GET 的形态）。 */
async function call(
  deps: MetabaseDeps, method: string, path: string, body?: unknown,
): Promise<unknown> {
  const url = deps.baseUrl.replace(/\/+$/, '') + path
  const res = await deps.fetcher(url, {
    method,
    headers: {
      'x-api-key': deps.apiKey,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new MetabaseError(res.status, `HTTP_${res.status}`)
  try {
    return await res.json()
  } catch {
    // 2xx 却不是 JSON ⇒ 形状不认识（读不出就是读不出，不许回落成 undefined 让上层当「空」）
    throw new MetabaseError(res.status, SHAPE_ERROR)
  }
}

/** 取响应体里的数字 id；不是数字 ⇒ 抛（大 id 不猜、不 Number() 硬转）。 */
function idOf(body: unknown): number {
  const id = (body as { id?: unknown } | null)?.id
  if (typeof id !== 'number') throw new MetabaseError(200, SHAPE_ERROR)
  return id
}

/**
 * 按名找 dashboard：`GET /api/search?q=…&models=dashboard`。
 *
 * ⚠️ **q 是模糊匹配** ⇒ 命中判据必须是 `name` **全等**（外加 `model === 'dashboard'`）。
 *    放宽成 includes/startsWith 会把「销售日报（副本）」当成「销售日报」⇒ 第二次 POST 静默
 *    改掉别人的报表（幂等缺陷，且单测若用宽松桩就结构性看不见）。
 * ⚠️ Metabase 允许重名 ⇒ 真机可能回多条同名；取**最小 id** 让行为确定，不赌 search 的排序。
 *
 * ⚠️ 已知边界：search 分页（未显式带 limit），同名报表极多时理论上可能落在首页之外——
 *    本机无真 Metabase 可验（真机 e2e 归 T10），此处按 spec §6.5 给出的做法最小实现。
 */
async function findDashboardIdByName(deps: MetabaseDeps, name: string): Promise<number | null> {
  const body = await call(deps, 'GET', `/api/search?q=${encodeURIComponent(name)}&models=dashboard`)
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new MetabaseError(200, SHAPE_ERROR)
  const ids = data
    .filter((d): d is { id: number } => {
      const rec = d as { id?: unknown; name?: unknown; model?: unknown } | null
      return typeof rec?.id === 'number' && rec.name === name && rec.model === 'dashboard'
    })
    .map((d) => d.id)
  return ids.length === 0 ? null : Math.min(...ids)
}

/**
 * 幂等建/更 dashboard：命中同名则 `PUT`（改名到同一个 name，幂等），否则 `POST` 创建。
 * 返回 `created` 是**可观测的幂等证据**（第二次 POST /reports 应为 false）。
 */
export async function upsertDashboard(
  deps: MetabaseDeps, name: string, collectionId?: number,
): Promise<MbUpsertResult> {
  const existing = await findDashboardIdByName(deps, name)
  if (existing !== null) {
    await call(deps, 'PUT', `/api/dashboard/${existing}`,
      collectionId === undefined ? { name } : { name, collection_id: collectionId })
    return { id: existing, created: false }
  }
  const created = await call(deps, 'POST', '/api/dashboard',
    collectionId === undefined ? { name } : { name, collection_id: collectionId })
  return { id: idOf(created), created: true }
}

/**
 * 发布嵌入 + 锁参数：`PUT /api/dashboard/{id}`。
 *
 * ⚠️ `embedding_type: 'signed'` 是**有意超出**计划 Task 7 Interfaces 的两字段列举
 *    （计划只写了 `enable_embedding` + `embedding_params`）：本设计签的是 **signed** JWT
 *    （spec §6.3「值由我们签的 JWT 携带」），而 Metabase 的 dashboard 上
 *    `enable_embedding` 与 `embedding_type` 是两个字段，只开前者而类型为空时嵌入**不是**
 *    signed 语义。spec §6.5 明确 `PUT /api/dashboard/{id}` 接受 `embedding_type`。
 *    两者都写 ⇒ 不依赖实例默认值（依赖默认值是**静默**漂移面）。
 *    若真机不认这个字段 ⇒ 此处**响亮**失败（非 2xx 抛），不会被吞成假绿；真机 e2e 归 T10。
 */
export async function setEmbedding(
  deps: MetabaseDeps, dashboardId: number, params: EmbedParamSpec[],
): Promise<void> {
  const embedding_params: Record<string, EmbedParamSpec['mode']> = {}
  for (const p of params) embedding_params[p.name] = p.mode
  await call(deps, 'PUT', `/api/dashboard/${dashboardId}`, {
    enable_embedding: true,
    embedding_type: 'signed',
    embedding_params,
  })
}

/** 归档 dashboard（删除登记行前必须先做，否则它恒留在对账的「未登记」差集里）。 */
export async function archiveDashboard(deps: MetabaseDeps, dashboardId: number): Promise<void> {
  await call(deps, 'PUT', `/api/dashboard/${dashboardId}`, { archived: true })
}

/**
 * 对账的正规可观测面：当前**可嵌入**的 dashboard 全集。
 * 形状不是裸数组 ⇒ 抛。**绝不回落 `[]`**——`[]` 会被对账读成「无差集」，
 * 把「读不到」伪装成「对得上」。
 */
export async function listEmbeddableDashboards(
  deps: MetabaseDeps,
): Promise<{ id: number; name: string }[]> {
  const body = await call(deps, 'GET', '/api/dashboard/embeddable')
  if (!Array.isArray(body)) throw new MetabaseError(200, SHAPE_ERROR)
  return body.map((d) => {
    const rec = d as { id?: unknown; name?: unknown } | null
    if (typeof rec?.id !== 'number' || typeof rec.name !== 'string') {
      throw new MetabaseError(200, SHAPE_ERROR)
    }
    return { id: rec.id, name: rec.name }
  })
}

/**
 * 签嵌入 JWT：HS256，密钥 = `METABASE_SECRET_KEY`（= 数据面实例的
 * `MB_ENCRYPTION_SECRET_KEY`，取值见 .env.example；**真值只落 openship env(isSecret)**）。
 *
 * payload 形状照 Metabase 官方 signed embedding 契约：`{resource:{dashboard:id}, params, exp}`。
 * `locked` 里的值对观看者**不可见、不可改**（spec §6.3）——这是「看哪个租户的数据」的落点：
 * 调用方（路由层）必须把 `tenant` **写死成 identity.orgId**，不允许任何入参覆盖。
 * 默认 ttl 600s（嵌入 URL 是短期凭证，不进书签/日志）。
 */
export function signEmbedToken(
  secret: string,
  resource: { type: 'dashboard'; id: number },
  locked: Record<string, string>,
  ttlSeconds = 600,
): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = enc({ alg: 'HS256', typ: 'JWT' })
  const body = enc({
    resource: { [resource.type]: resource.id },
    params: locked,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  })
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/** 嵌入页的公开地址（signed embedding 的常规路径）。 */
export function embedDashboardUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/public/dashboard/${token}`
}

/**
 * env 三键 → 配置。**三键缺一 ⇒ null**（不是抛）：部署没接 Metabase 是**配置状态**，
 * 路由层应回可解释的 503，不是 500（口径同 `llmFromEnv` / `DATA_WAREHOUSE_UNCONFIGURED`）。
 */
export function metabaseFromEnv(
  env: Record<string, string | undefined> = process.env,
): MetabaseConfig | null {
  const baseUrl = (env.DATA_METABASE_URL ?? '').trim().replace(/\/+$/, '')
  const apiKey = (env.DATA_METABASE_API_KEY ?? '').trim()
  const secretKey = (env.DATA_METABASE_SECRET_KEY ?? '').trim()
  if (!baseUrl || !apiKey || !secretKey) return null
  return { baseUrl, apiKey, secretKey }
}

/** 配置 → 调用依赖（`fetch` 的生产默认值只在这里出现一次；测试传桩）。 */
export function metabaseDeps(cfg: MetabaseConfig, fetcher: FetchLike = fetch): MetabaseDeps {
  return { fetcher, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }
}
