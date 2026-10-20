// novu.ts — Novu trigger 客户端（本模块**唯一**外部 HTTP 落点；照 modules/forms/domain/llm.ts 范式）。
//
// 职责边界（§2.6）：本层只做「调用方给事件/收件人/payload → 投递」——**不管路由**（那是绑定层的事）。
// Novu 生产环境建 workflow 一律 401 ⇒ 模板只能 Dev 建再 sync（架构强制的人审门禁，见 §2.6 门禁分层）。
// fail-open：任何失败返回 {ok:false}，**不抛**——投递失败不阻塞业务（§2.6 取舍④）。

export type NovuConfig = {
  baseUrl: string
  apiKey: string
  /**
   * 本 org 的企微 bridge 端点（ADR 0008 ②）。null = 本 org 未配 ⇒ **不挂渠道**（照常 trigger）。
   * 值形如 `https://push.hookflow.cn/wecom/<租户>?t=<token>`，`ensureChannel` 会再拼 `&to=<订阅者>`。
   */
  chatWebhookUrl: string | null
}

/** 按 org 解析客户端（§2.6 方案 A）：解析失败返回 null，由管道记 failed（不抛）。 */
export type NovuResolver = (org: string) => NovuConfig | null

/**
 * org → per-org env 变量名（§2.6「org 名大写下划线化」的唯一实现，纯函数）。
 *
 * 规则：把每个非 `[A-Za-z0-9]` 字符替换成 `_`，再整体大写；**不折叠**连续下划线
 * （`a--b` ≠ `a-b`，避免两个不同 org 撞同一个键）。非 ASCII 同样逐字符变成 `_`——
 * 正典标注该场景「待实测，不得据以声称可用」，这里只保证行为确定。
 *
 * `prefix` 是形参（不是写死 `NOVU_API_KEY`）：本模块有两个 per-org 键
 * （`NOVU_API_KEY` / `NOVU_CHAT_WEBHOOK_URL`），规范化规则**必须只有一处实现**。
 */
export function orgEnvKeyFor(prefix: string, org: string): string {
  return `${prefix}__${org.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/** `NOVU_API_KEY__<ORG>`（§2.6 方案 A）。 */
export function novuEnvKeyForOrg(org: string): string {
  return orgEnvKeyFor('NOVU_API_KEY', org)
}

/** `NOVU_CHAT_WEBHOOK_URL__<ORG>`（ADR 0008 ②③）。 */
export function novuChatWebhookEnvKeyForOrg(org: string): string {
  return orgEnvKeyFor('NOVU_CHAT_WEBHOOK_URL', org)
}

/**
 * 本 org 的 chat bridge URL（纯函数）。**只认本 org 的键**：`NOVU_CHAT_WEBHOOK_URL__<ORG>`；
 * 没有 ⇒ `null` = 未配置。
 *
 * ⚠️ **刻意**不同于 `NOVU_API_KEY__<ORG>` 的「per-org → 回落全局」范式（2026-10-20 人裁决）：
 * 本键不是普通配置，它是一条**带租户 token 的投递端点** —— bridge 按 URL 里的 tenant + token
 * 决定「用哪个企微 corp 发、发到哪个群」。一旦跨 org 回落，A 租户的通知会带着 A 的标题/链接
 * 投进 B 租户的企微群 = **跨租户数据泄露**，不是投递失败。故本键 fail-closed：只认本 org，
 * 缺则视为未配置。**本轮也不引入全局 `NOVU_CHAT_WEBHOOK_URL`** —— 多租户世界里它没有正当语义，
 * 定义它只会招来误用。
 *
 * `org` 缺失 / 空白同样返回 null：拿不到 org 就选不出 per-org 键，**不能退化成全局**。
 * （`NOVU_API_KEY` 的全局回落存在同类隐患，属既有设计、另案评估，本 PR 不动它。）
 */
export function novuChatWebhookUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  org?: string,
): string | null {
  if (!org || org.trim() === '') return null
  return env[novuChatWebhookEnvKeyForOrg(org.trim())] || null
}

/**
 * env 解析。§2.6 优先级：`NOVU_API_KEY__<ORG>` → 回落 `NOVU_API_KEY` → 都无 ⇒ null
 * （调用方记 `failed` / `novu not configured`，**不抛**，与 fail-open 一致）。
 *
 * `org` 省略 / 空白 ⇒ 跳过 per-org 查找，直接走全局键（EmitInput.org 类型上必填，
 * 这里是防线：拿不到 org 时不能去查 `NOVU_API_KEY__` 这种无意义键名）。
 * `NOVU_BASE_URL` 全局唯一（同一 Novu 实例），per-org 只换 apiKey。
 *
 * `chatWebhookUrl` 与 apiKey 同源解析（同一 org 维度），但**不回落**——见该函数注释。
 */
export function novuFromEnv(env: NodeJS.ProcessEnv = process.env, org?: string): NovuConfig | null {
  const baseUrl = env.NOVU_BASE_URL
  if (!baseUrl) return null
  const perOrgKey = org && org.trim() !== '' ? env[novuEnvKeyForOrg(org.trim())] : undefined
  const apiKey = perOrgKey || env.NOVU_API_KEY
  if (!apiKey) return null
  return { baseUrl, apiKey, chatWebhookUrl: novuChatWebhookUrlFromEnv(env, org) }
}

export type TriggerArgs = {
  templateId: string // Novu workflow identifier
  subscriberId: string // Casdoor 用户 id（确定性映射，首次 trigger 自动建订阅者）
  payload: Record<string, unknown>
}

export async function trigger(
  cfg: NovuConfig,
  args: TriggerArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/events/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${cfg.apiKey}`,
      },
      body: JSON.stringify({ name: args.templateId, to: args.subscriberId, payload: args.payload }),
    })
    if (!res.ok) {
      return { ok: false, error: `novu trigger HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * bridge 端点 + `to=<订阅者>` 的拼接（纯函数，ADR 0008 ②）。
 *
 * ⚠️ bridge URL **本身已带 `?t=<token>`** ⇒ 追加必须用 `&`；用 `?` 会拼出两个 `?`，
 * 让 token 变成 `to` 的一部分 ⇒ 认证失败且**看着像投递故障**。不带查询串时才用 `?`
 * （与参考实现 `data-platform-scaffold/modules/ticket-dispatch/.../push.mjs` 同形）。
 */
export function chatWebhookUrlFor(webhookUrl: string, subscriberId: string): string {
  const sep = webhookUrl.includes('?') ? '&' : '?'
  return `${webhookUrl}${sep}to=${encodeURIComponent(subscriberId)}`
}

/**
 * 进程内缓存：已成功挂过渠道的键。**键 = (bridge URL, subscriberId)**，不是裸 subscriberId。
 *
 * 为什么键里要带 URL：subscriberId 是 Casdoor 用户名，**不同 org 可以同名**（`admin` / `张三`）。
 * 只按 subscriberId 缓存 ⇒ 第二个 org 的同名用户命中缓存被跳过 ⇒ 他永远挂着**第一个 org 的**
 * bridge URL（含那家的 token）⇒ 正是本轮裁决要避免的**跨租户串号**。带 URL 还顺带处理了
 * token 轮换：URL 变了就重挂。
 *
 * 生命周期 = 进程（重启即失效，多副本各存各的）。凭据相同再 PUT 是 no-op，故多打一次无害。
 */
const ensuredChannels = new Set<string>()

export type EnsureChannelResult = { ok: true } | { ok: false; error: string }

/**
 * 给订阅者挂 chat 渠道（ADR 0008 ②；实测闸门 = `subscriber.channels[]`，集成级 webhookUrl 不参与）。
 *
 * 两步（**先建后挂最稳**：`PUT credentials` 要求订阅者已存在）：
 *   ① `POST /v1/subscribers`（upsert）
 *   ② `PUT /v1/subscribers/:id/credentials` body `{providerId:'chat-webhook', credentials:{webhookUrl}}`
 *
 * fail-open（与 `trigger` 同口径）：任何失败返回 `{ok:false}`，**不抛**——挂渠道失败不阻断投递，
 * 后果由 Novu 的 chat job 状态体现（`canceled` / `failed`）。失败**不入缓存** ⇒ 下次 emit 重试。
 */
export async function ensureChannel(
  cfg: NovuConfig,
  args: { subscriberId: string; webhookUrl: string },
): Promise<EnsureChannelResult> {
  const cacheKey = `${args.webhookUrl}\u0000${args.subscriberId}`
  if (ensuredChannels.has(cacheKey)) return { ok: true }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `ApiKey ${cfg.apiKey}`,
  }
  try {
    const upsert = await fetch(`${cfg.baseUrl}/v1/subscribers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ subscriberId: args.subscriberId }),
    })
    if (!upsert.ok) {
      return { ok: false, error: `novu subscribers HTTP ${upsert.status}` }
    }

    const put = await fetch(
      `${cfg.baseUrl}/v1/subscribers/${encodeURIComponent(args.subscriberId)}/credentials`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          providerId: 'chat-webhook',
          credentials: { webhookUrl: chatWebhookUrlFor(args.webhookUrl, args.subscriberId) },
        }),
      },
    )
    if (!put.ok) {
      return { ok: false, error: `novu credentials HTTP ${put.status}` }
    }

    ensuredChannels.add(cacheKey)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
