// novu.ts — Novu trigger 客户端（本模块**唯一**外部 HTTP 落点；照 modules/forms/domain/llm.ts 范式）。
//
// 职责边界（§2.6）：本层只做「调用方给事件/收件人/payload → 投递」——**不管路由**（那是绑定层的事）。
// Novu 生产环境建 workflow 一律 401 ⇒ 模板只能 Dev 建再 sync（架构强制的人审门禁，见 §2.6 门禁分层）。
// fail-open：任何失败返回 {ok:false}，**不抛**——投递失败不阻塞业务（§2.6 取舍④）。

export type NovuConfig = { baseUrl: string; apiKey: string }

/** env 解析一次。缺任一键 ⇒ null（⇒ /emit 回可解释 503，不是启动失败）。 */
export function novuFromEnv(env: NodeJS.ProcessEnv = process.env): NovuConfig | null {
  const baseUrl = env.NOVU_BASE_URL
  const apiKey = env.NOVU_API_KEY
  if (!baseUrl || !apiKey) return null
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
