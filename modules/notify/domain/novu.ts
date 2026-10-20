// novu.ts — Novu trigger 客户端（本模块**唯一**外部 HTTP 落点；照 modules/forms/domain/llm.ts 范式）。
//
// 职责边界（§2.6）：本层只做「调用方给事件/收件人/payload → 投递」——**不管路由**（那是绑定层的事）。
// Novu 生产环境建 workflow 一律 401 ⇒ 模板只能 Dev 建再 sync（架构强制的人审门禁，见 §2.6 门禁分层）。
// fail-open：任何失败返回 {ok:false}，**不抛**——投递失败不阻塞业务（§2.6 取舍④）。

export type NovuConfig = { baseUrl: string; apiKey: string }

/** 按 org 解析客户端（§2.6 方案 A）：解析失败返回 null，由管道记 failed（不抛）。 */
export type NovuResolver = (org: string) => NovuConfig | null

/**
 * org → per-org key 的 env 变量名（§2.6「org 名大写下划线化」的唯一实现，纯函数）。
 *
 * 规则：把每个非 `[A-Za-z0-9]` 字符替换成 `_`，再整体大写；**不折叠**连续下划线
 * （`a--b` ≠ `a-b`，避免两个不同 org 撞同一个键）。非 ASCII 同样逐字符变成 `_`——
 * 正典标注该场景「待实测，不得据以声称可用」，这里只保证行为确定。
 */
export function novuEnvKeyForOrg(org: string): string {
  return `NOVU_API_KEY__${org.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/**
 * env 解析。§2.6 优先级：`NOVU_API_KEY__<ORG>` → 回落 `NOVU_API_KEY` → 都无 ⇒ null
 * （调用方记 `failed` / `novu not configured`，**不抛**，与 fail-open 一致）。
 *
 * `org` 省略 / 空白 ⇒ 跳过 per-org 查找，直接走全局键（EmitInput.org 类型上必填，
 * 这里是防线：拿不到 org 时不能去查 `NOVU_API_KEY__` 这种无意义键名）。
 * `NOVU_BASE_URL` 全局唯一（同一 Novu 实例），per-org 只换 apiKey。
 */
export function novuFromEnv(env: NodeJS.ProcessEnv = process.env, org?: string): NovuConfig | null {
  const baseUrl = env.NOVU_BASE_URL
  if (!baseUrl) return null
  const perOrgKey = org && org.trim() !== '' ? env[novuEnvKeyForOrg(org.trim())] : undefined
  const apiKey = perOrgKey || env.NOVU_API_KEY
  if (!apiKey) return null
  return { baseUrl, apiKey }
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
