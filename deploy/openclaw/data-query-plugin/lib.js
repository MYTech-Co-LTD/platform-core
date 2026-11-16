// lib.js — 问数插件纯逻辑（不 import openclaw SDK；node --test 可直跑）。
// 权限判定零逻辑：词表裁剪/主体钉死/fail-closed 全在平台授权核心（约束 6）。
// 这里做四件事：参数归一（宿主 execute 的 params 形状有历史差异）、平台调用、错误文案映射、
// 新鲜度行的捕获与确定性附加（message_sending 钩子的纯逻辑，2026-10-16）。

export const DEFAULT_API_BASE = "http://server:13000/api/modules/data";
// 未关联指引指向的山海平台入口（只写文案，不含任何凭证）。
export const PLATFORM_ORIGIN = "https://platform.shanhaiyiguo.com";

// 401 文案唯一一份：问数直连（callPlatform）与能力网关（callGateway）共用，避免两处措辞漂移。
export const WECOM_NOT_LINKED_TEXT =
  `你的企微账号还没关联平台账号：用企微扫码登录一次 ${PLATFORM_ORIGIN}（登录即完成关联，无需任何绑定操作），然后回来重新提问。`;
const channelAuthFailedText = (code) =>
  `渠道认证失败（${code || "HTTP 401"}），请联系管理员检查渠道凭证。`;

// 宿主 execute 第二参历史上有三种形态：直传对象 / JSON 字符串 / 单键包裹
// （input|arguments|parameters）。生产先例实测（data-analysis data-query-plugin）：
// 不归一会让参数恒 undefined → 每次必现 missing 参数。
export function normalizeParams(raw) {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  for (const key of ["input", "arguments", "parameters"]) {
    const inner = obj[key];
    if (
      Object.keys(obj).length === 1 &&
      inner && typeof inner === "object" && !Array.isArray(inner)
    ) {
      return inner;
    }
  }
  return obj;
}

// 工具结果契约（api.registerTool 的 execute **必须**返回的形状）：
//   { content: [{ type: "text", text }], details }
// 依据 https://docs.openclaw.ai/plugins/building-plugins 原文示例。返回**纯对象**会因缺 content[]
// 被校验判无效 —— 2026-10-12 真机实测逐字报错：
//   [tools] tool_call failed: path ["details","result","content"] expected "array", received undefined
// 后果是 list_metrics 每轮连败数秒、模型拿不到词表只能硬猜 metricId。**所有工具返回值走这里，勿绕过。**
export function toToolResult(payload) {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
    ],
    details: payload,
  };
}

// 平台调用 + 错误映射。返回值是**业务载荷**（纯对象）；交给模型前必须经 toToolResult 包裹。
// fetchImpl 参数注入便于单测；生产用全局 fetch。
export async function callPlatform(opts) {
  const { fetchImpl = fetch, apiBase = DEFAULT_API_BASE, channelKey, userId, sessionId, path, method = "GET", body } = opts;
  if (!channelKey) {
    return { error: "渠道凭证未配置（openclaw 容器缺 DATA_WECOM_CHANNEL_KEY env），请联系管理员。" };
  }
  if (!userId) {
    return { error: "无法识别请求者身份（requesterSenderId 缺失）。出于权限安全不予查询，请重新发一条消息；仍失败请联系管理员。" };
  }
  let resp;
  try {
    resp = await fetchImpl(apiBase + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-channel-key": channelKey,
        "x-wecom-userid": userId,
        // 会话键：平台据此算「可辩护答案时长」（首问 → 首个成功查询）。没有就不带。
        ...(sessionId ? { "x-session-id": String(sessionId) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { error: "平台问数 API 不可达：" + ((e && e.message) || String(e)) };
  }
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.status === 401 && data.error === "WECOM_USER_NOT_LINKED") {
    return {
      code: "WECOM_USER_NOT_LINKED",
      error: WECOM_NOT_LINKED_TEXT,
    };
  }
  if (resp.status === 401) {
    return { code: data.error || "CHANNEL_KEY_INVALID", error: channelAuthFailedText(data.error) };
  }
  // 403 对「未授权」与「词表外」同文案（平台刻意不区分，避免存在性探针——三通道设计 §5 约束 3）。
  // ⚠️ 但 `bad_param` 是「参数写错了」，不是「没权限」：/query 对一切 denied 都回 403（#30 订正），
  // body 里带 reason/detail。把 bad_param 也照搬权限文案，模型会读成「指标没权限」然后换指标重试，
  // 实际它只差把参数改成合法形状——必须如实回参数错误，并带上服务端的 detail（哪个键、什么毛病）。
  if (resp.status === 403) {
    if (data.reason === "bad_param") {
      return {
        code: "BAD_PARAM",
        error: "参数不合法：" + (data.detail || "服务端未给原因") + "（键与形状以 list_metrics 返回的 params 为准）",
      };
    }
    // `no_detail_binding` 是**能力陈述**不是权限拒绝（下钻 spec §2.6）：该指标没声明明细下钻，
    // 换指标试探 / 重试都没用——照搬 DENIED 文案会诱导模型去试别的指标，必须如实告知能力边界。
    if (data.reason === "no_detail_binding") {
      return {
        code: "NO_DETAIL_BINDING",
        error: "该指标暂不支持明细下钻（能力边界，不是权限问题）——聚合口径可用 query_data 查询。",
      };
    }
    return { code: "DENIED", error: "该查询不在你的可见范围内。可用指标先调 list_metrics 看（词表按人裁剪）。" };
  }
  if (resp.status === 502) {
    return { code: data.error || "WAREHOUSE", error: "数据仓库暂时不可用（" + (data.reason || data.error || "上游错误") + "），请稍后再试。" };
  }
  if (!resp.ok) {
    return { code: data.error, error: "平台返回 HTTP " + resp.status + (data.error ? "：" + data.error : "") };
  }
  return data;
}

// ── 新鲜度行：确定性附加（message_sending 钩子的纯逻辑，2026-10-16）──────────────
// 背景：曾让模型「答案末尾原样附 freshness_line」，flash 级合规不稳（时有时无、混进正文）。
// 改为传输层确定性保证：query_data 成功回包带 freshness_line 时捕获（按会话），外发消息
// 经过 message_sending 钩子时先剥掉模型自己写的 📅 行、再把服务端正典行钉在末尾。
//   · 剥离在先 ⇒ 模型附了也不会出现两行（strip-then-append 天然去重）；
//   · 没有捕获（未查数 / TTL 过期）⇒ 原样放行（钩子契约：返回 undefined = 不改）；
//   · 钩子故障在宿主侧是「记日志并跳过」（fail-open）⇒ 本逻辑**任何分支都不许 throw**。

/** 捕获条目 TTL：10 分钟——比一轮对话长得多，又不至于把隔夜的旧行附到新问题末尾。 */
export const FRESHNESS_TTL_MS = 10 * 60 * 1000;

/** 无会话键时的兜底槽位（工具上下文拿不到 sessionKey 就全局共用一份，取最新）。 */
export const FRESHNESS_GLOBAL_SLOT = "__global__";

/** 服务端 freshness_line 的判别前缀——三个变体都以「📅 数据」开头
 * （query-service.ts freshnessLineOf：已更新至 / 更新停在 / 更新情况未知），勿窄化成单一变体。 */
const FRESHNESS_PREFIX = "📅 数据";

/**
 * 捕获存储：sessionKey → { line, at, sessionKey }，同会话后查覆盖前查（取最新）。
 * TTL 在**读取时**判定（过期即丢弃）；now 可注入便于单测推演时间。
 */
export function createFreshnessStore({ ttlMs = FRESHNESS_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    /** query_data 成功回包带固定行时调用；sessionKey 缺失落全局槽。
     *
     * 两种形态（**整条替换**，不做字段级合并——否则上一次查询的 📐 行会漏到这一次）：
     *   · 字符串     ⇒ 只捕获新鲜度行（📅），scopeLine 置空。旧签名，单测仍用它。
     *   · `{freshness?, scope?}` ⇒ 两条一起捕获（插件生产路径用这个）。
     *
     * line 存原值不做强转（非串在读取侧判掉——强转会把 undefined 变成字符串 "undefined"）。
     * runId 存空串表示「本侧没有」——钩子侧据此决定是否收紧（见 makeFreshnessSendingHook）。 */
    capture(sessionKey, line, runId) {
      const isObj = line !== null && typeof line === "object";
      /** @type {unknown} */
      const freshness = isObj ? line.freshness : line;
      /** @type {unknown} */
      const scope = isObj ? line.scope : undefined;
      /** @type {Record<string, unknown>} */
      const entry = {
        line: freshness,
        runId: runId || "",
        at: now(),
        sessionKey: sessionKey || "",
      };
      // 只在真有值时加键：字符串捕获保持**原条目形状**（既有断言 deepEqual 整条，多一个
      // `scopeLine: undefined` 会被判不等——那是形状噪音，不是行为差异）。
      if (scope !== undefined) entry.scopeLine = scope;
      map.set(sessionKey || FRESHNESS_GLOBAL_SLOT, entry);
    },
    /** 取该会话当前可用的正典行；无 / 过期 ⇒ undefined（过期顺手清槽防积压）。 */
    take(sessionKey) {
      const key = sessionKey || FRESHNESS_GLOBAL_SLOT;
      const entry = map.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return entry;
    },
    /** 入站清账：清该会话（缺键清全局槽）。捕获只服务「本轮答案的外发」，新用户消息一进来即失效。 */
    clear(sessionKey) {
      map.delete(sessionKey || FRESHNESS_GLOBAL_SLOT);
    },
    size: () => map.size,
  };
}

/** 生产单例：工具路径写入、钩子读取共用同一份。 */
export const freshnessStore = createFreshnessStore();

/**
 * 剥掉内容里**所有** 📅 新鲜度行——独立成行的整行删除（容忍行首空白/列表符），
 * 混在句中的（非独立行）按前缀截掉其后到行尾。服务端三变体全覆盖。
 */
export function stripFreshnessLines(content) {
  if (typeof content !== "string") return content;
  const withoutStandalone = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*(?:[-*]\s*)?📅\s*数据/.test(l))
    .join("\n");
  return withoutStandalone.replace(/📅\s*数据[^\n]*/g, "");
}

/** 剥旧 + 钉新：先剥离全部 📅 行、收掉尾部空行，再把正典行作为最后一个独立行附上。 */
export function appendFreshnessLine(content, line) {
  if (typeof content !== "string") return content;
  if (typeof line !== "string" || !line) return content;
  const stripped = stripFreshnessLines(content).replace(/\s+$/, "");
  return stripped ? stripped + "\n\n" + line : line;
}

// ── 口径射程行（📐，消费面 spec 2026-10-17 §12.6）────────────────────────────────
// 与 📅 同一套传输层确定性机制：服务端回包带 scope_line ⇒ 捕获 ⇒ 发送前剥模型自写 ⇒ 钉末尾。
// 为什么不能只靠提示词：只报「5 家」会被读成「全部门店都没问题」，而「对的路必须由平台自动
// 发生」在参数面 spec §8.4 已被实证（SKILL 对 flash 级模型是弱引导）。

/** 服务端 scope_line 的判别前缀（query-service.ts 拼 `📐 口径：…`）。 */
const SCOPE_PREFIX = "📐 口径";

/** 剥掉内容里所有 📐 口径行（规则同 📅：独立成行整行删；混在句中按前缀截到行尾）。 */
export function stripScopeLines(content) {
  if (typeof content !== "string") return content;
  const withoutStandalone = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*(?:[-*]\s*)?📐\s*口径/.test(l))
    .join("\n");
  return withoutStandalone.replace(/📐\s*口径[^\n]*/g, "");
}

/**
 * 剥旧 + 钉新（**多行版**）：先剥离 📅/📐 两族行、收掉尾部空行，再按传入顺序把正典行
 * 各作为独立行附上（顺序 = 新鲜度在前、口径在后）。
 *
 * 两族**总是**一起剥：本次只捕获到其中一行时，模型自写的另一行仍是陈旧/臆造的，留着就是噪音。
 */
export function appendFixedLines(content, lines) {
  if (typeof content !== "string") return content;
  const keep = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === "string" && l);
  if (keep.length === 0) return content;
  const stripped = stripScopeLines(stripFreshnessLines(content)).replace(/\s+$/, "");
  const tail = keep.join("\n");
  return stripped ? stripped + "\n\n" + tail : tail;
}

/**
 * 造 message_sending 钩子处理器（index.js 用生产单例注册；单测用独立 store 注入）。
 *
 * ★ 返回形状是**硬契约**（一手来源：openclaw `src/infra/outbound/deliver-hooks.ts`
 *   `applyMessageSendingHook`——主机读的是 `sendingResult?.content`；`== null` 即判「未改写」
 *   原样投递）：
 *     · 要改写 ⇒ 返回对象 `{ content: <新文本> }`（**不是裸字符串**——裸串会被读成
 *       `undefined.content` ⇒ 主机判未改写 ⇒ 行永不附上，恰是本任务要消灭的缺陷下移一层）；
 *     · 不改写（无捕获 / 过期 / 内容非串 / 出错）⇒ 返回 `undefined`（契约里 = 无决定）。
 *   合并语义（hooks.ts runMessageSending）：`content: lastDefined(acc?.content, next.content)`。
 *
 * ★ runId 收紧：两侧都有 runId 且不一致 ⇒ 判为陈旧（同会话的上一轮），不附加。
 *   ⚠️ 现状：openclaw **不给 message_sending 传 runId**（`hook-message.types.ts` 明写
 *   "not yet plumbed through the outbound delivery path"），工具 ctx 也无 runId
 *   ⇒ 生产上恒走「任一侧缺失 ⇒ sessionKey+TTL」的回退分支；本收紧是**前向兼容**，
 *   待上游接通 runId 后自动生效（残余泄漏见 README 已知边界）。
 *
 * **任何分支不得 throw**——宿主对钩子故障 fail-open（deliver-hooks.ts catch 后原样投递），
 * 外抛只会白搭一次调用。
 */
export function makeFreshnessSendingHook(store) {
  return async function messageSendingHook(event, ctx) {
    try {
      const content = event && event.content;
      if (typeof content !== "string") return undefined;
      const entry = store.take(ctx && ctx.sessionKey);
      if (!entry) return undefined;
      // 固定行（顺序：📅 新鲜度在前、📐 口径在后）。全都没有 ⇒ 不改写。
      const lines = [entry.line, entry.scopeLine].filter((l) => typeof l === "string" && l);
      if (lines.length === 0) return undefined;
      const entryRunId = entry.runId || "";
      const ctxRunId = (ctx && ctx.runId) || "";
      if (entryRunId && ctxRunId && entryRunId !== ctxRunId) return undefined;
      return { content: appendFixedLines(content, lines) };
    } catch {
      // fail-open：宁缺勿错——新鲜度行缺失可接受，外发通道被搞挂不可接受。
      return undefined;
    }
  };
}

/**
 * 造 message_received（入站观察）钩子处理器：收到新用户消息即清该会话的捕获。
 *
 * 语义：捕获只服务「**本轮**答案的外发」；下一轮用户消息一进来，本轮口径即失效 ⇒
 * 陈旧行不可能跨轮泄漏（否则问完数据后发「你好」「谢谢」也会被附上 📅 时间戳）。
 * 时序（openclaw `emitMessageReceivedHooks` 在 reply dispatch 之前发）保证「清账」先于
 * 同轮工具的「捕获」。TTL（10min）保留为兜底：入站钩子若某通道不触发，行为退化为
 * 无清账的旧状（只是没变好，不会变差）。
 *
 * 契约（一手来源 `src/plugins/hooks.ts` `runVoidHook`）：handler 签名 `(event, ctx)`，
 * **返回 void**（返回值被忽略），异常由宿主 `handleHookError` 吞掉（fail-open）。
 * ctx 带 `sessionKey`（`toPluginMessageContext` 透传 canonical.sessionKey）；缺失时清全局槽。
 * 注册须走 `api.on`（typed hook runner）——`message_received` 不在 conversation / prompt
 * injection 门禁清单内，非内置插件无需额外开闸。
 */
export function makeFreshnessInboundHook(store) {
  return async function messageReceivedHook(_event, ctx) {
    try {
      store.clear(ctx && ctx.sessionKey);
    } catch {
      // fail-open：清账失败只是让陈旧行多活一会儿，绝不能把入站链路搞挂。
    }
  };
}

/**
 * 工具调用身份解析（#964）：`ctx.requesterSenderId` 偶发为空时的兜底，**按会话键隔离**。
 *
 * 为什么不能沿用旧实现（模块级全局 lastUserId）：那是**进程内所有会话共用**的——
 * 任一新会话首个调用的 ctx 为空，就会拿**上一个会话的** userid 去查平台问数 API，
 * 而权限由平台按人裁决 ⇒ 取到的是**那个人的**数据。跨会话兜底 = 越权面。
 *
 * 语义：
 *   · ctx 带 userid ⇒ 用直给值，并把 (sessionKey → userid) 记进表（同一会话后续可用）；
 *   · ctx 不带 userid 但同会话有记录 ⇒ 兜底（这就是旧实现想保住的「同一轮偶发为空」自愈）；
 *   · ctx 不带 userid 且无会话键/无记录 ⇒ **返回空串**（调用链会以「无法识别身份」硬失败，
 *     如实报错远好于取错人的数据）。
 * 表容量有上限（防止长驻进程无限增长）；超限按插入序淘汰最老一条。
 *
 * @param {{requesterSenderId?: string, sessionKey?: string} | null | undefined} ctx
 * @param {Map<string, string>} lastBySession 调用方持有的会话→userid 表（就地更新）
 * @param {number} [cap]
 * @returns {{ userId: string, sessionKey: string }}
 */
export function resolveToolUserId(ctx, lastBySession, cap = 500) {
  const sessionKey = (ctx && ctx.sessionKey) || "";
  const direct = (ctx && ctx.requesterSenderId) || "";
  const userId = direct || (sessionKey ? lastBySession.get(sessionKey) || "" : "");
  if (direct && sessionKey) {
    if (!lastBySession.has(sessionKey) && lastBySession.size >= cap) {
      const oldest = lastBySession.keys().next().value;
      if (oldest !== undefined) lastBySession.delete(oldest);
    }
    lastBySession.set(sessionKey, direct);
  }
  return { userId, sessionKey };
}

// ── 平台能力网关（agent MCP，2026-11-16 能力网关 spec §8；#2360）────────────────
// native 元工具 platform_capabilities / platform_call 的纯逻辑：JSON-RPC 传输、
// MCP 结果 → openclaw 工具结果映射、能力目录紧凑化。身份**只**由 ctx（requesterSenderId）
// + 容器 env（DATA_WECOM_CHANNEL_KEY）决定——模型参数里没有也不接受 userId。

/** 平台能力网关基址：openclaw 服务 env `AGENT_API_BASE`（独立容器，不在根 .env.example）。 */
export const DEFAULT_AGENT_API_BASE = "http://server:13000/api/agent";

/** 本地 fail-closed 错误码 / 网关鉴权码 → 可操作中文文案（裸码模型读不懂，也不知道下一步做什么）。 */
const GATEWAY_ERROR_TEXT = {
  CHANNEL_KEY_MISSING: "渠道凭证未配置（openclaw 容器缺 DATA_WECOM_CHANNEL_KEY env），请联系管理员。",
  USERID_MISSING: "无法识别请求者身份（requesterSenderId 缺失）。出于权限安全不予调用，请重新发一条消息；仍失败请联系管理员。",
  WECOM_USERID_REQUIRED: "无法识别请求者身份（x-wecom-userid 缺失）。请重新发一条消息；仍失败请联系管理员。",
  GATEWAY_TIMEOUT: "平台能力网关响应超时，请稍后再试；持续失败请联系管理员。",
  GATEWAY_CANCELLED: "调用已取消。",
  WECOM_USER_NOT_LINKED: WECOM_NOT_LINKED_TEXT,
  CHANNEL_KEY_INVALID: channelAuthFailedText("CHANNEL_KEY_INVALID"),
  USER_DISABLED: "平台账号已停用，请联系管理员。",
  CASDOOR_UNAVAILABLE: "平台身份服务暂不可用，请稍后再试。",
  // JSON-RPC 协议错误：工具名拼错 / 参数形状错，分两种给下一步动作，别让模型原样重试。
  "RPC_-32601": "工具或方法不存在：先调 platform_capabilities 查看可用工具与参数，再用 platform_call 调用。",
  "RPC_-32602": "参数不合法（-32602）：按 platform_capabilities({ tool }) 返回的 inputSchema 校正后重试。",
  // 本地参数防御码（还没发请求）：给下一步动作，而不是裸 JSON。
  TOOL_REQUIRED: "缺少 tool 参数：先用 platform_capabilities 查看可用工具，再传 tool=<name>。",
  TOOL_NOT_CALLABLE: "agent__capabilities 是发现入口，不通过 platform_call 调用；直接调 platform_capabilities。",
};

/** 网关错误码归一：本地字符串码 / 网关 HTTP body `{error}` / JSON-RPC `{code,message}`。 */
function gatewayErrorCode(e) {
  if (typeof e === "string") return e;
  if (e && typeof e.code === "number") return `RPC_${e.code}`;
  return "GATEWAY_ERROR";
}

/** 取消判定：调用方 signal 已中止 ⇒ GATEWAY_CANCELLED（优先于超时/网络错误/坏回包——用户不等了，不是故障）。 */
function cancellationIfAborted(signal) {
  return signal?.aborted ? { error: "GATEWAY_CANCELLED", detail: "调用已取消" } : undefined;
}

/** 错误码 → 文案；带上下文的传输类错误把 detail/status 拼进文案（排障要看的就这两样）。 */
function gatewayErrorText(e, detail, status) {
  const code = gatewayErrorCode(e);
  if (code === "GATEWAY_UNREACHABLE") {
    return `平台能力网关不可达（${detail || "网络错误"}），请稍后再试；持续失败请联系管理员。`;
  }
  if (code === "GATEWAY_BAD_RESPONSE") {
    return `平台能力网关回包无法解析${status ? `（HTTP ${status}）` : ""}，请联系管理员。`;
  }
  const known = GATEWAY_ERROR_TEXT[code];
  if (known) return known;
  // 未知 JSON-RPC error：原样给 code/message（比裸码可读，也不丢服务端原因）。
  if (e && typeof e === "object") return JSON.stringify(e);
  return JSON.stringify({ status: "error", reason: code });
}

/** 网关请求超时上限：普通工具 60s（与网关侧 `tools/call` 默认一致）；forms 生成草稿要调 LLM，
 * 网关侧放行 120s（spec §7.4）——插件侧若仍卡 20s 会在 LLM 出结果前截断，必须按工具选。 */
export const GATEWAY_TIMEOUT_MS = 60_000;
export const FORMS_DRAFT_TIMEOUT_MS = 120_000;

/** forms 的 LLM 起草工具：唯一走 120s 长超时的工具。 */
const FORMS_DRAFT_TOOL = "forms__generate_form_draft";

/** 按工具选超时：forms 起草 120s，其余 60s。 */
export function timeoutForTool(tool) {
  return tool === FORMS_DRAFT_TOOL ? FORMS_DRAFT_TIMEOUT_MS : GATEWAY_TIMEOUT_MS;
}

/**
 * 向网关发一条 JSON-RPC（POST {apiBase}/mcp）。
 * 返回**解析后的 JSON-RPC 回包**（`{result}` 或 `{error}`），交给 toGatewayToolResult 映射；
 * 本地前置失败返回 `{error: "<CODE>"}`（字符串码），网络/超时/解析失败也不抛（工具主路径不许炸）。
 * 缺 key/userid 时**不发请求**（fail-closed，与此前 callPlatform 同口径）。
 * 网关鉴权失败是**非 JSON-RPC 信封**（401/503 直接 `{error:'CHANNEL_KEY_INVALID'}`），
 * 这里归一成 `{error: <code>, status}`，文案由 gatewayErrorText 负责。
 */
export async function callGateway(opts) {
  const {
    apiBase = DEFAULT_AGENT_API_BASE, channelKey, userId, sessionId,
    method, params, fetchImpl = fetch, timeoutMs = GATEWAY_TIMEOUT_MS, signal,
  } = opts;
  if (!channelKey) return { error: "CHANNEL_KEY_MISSING" };
  if (!userId) return { error: "USERID_MISSING" };
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout])
    : timeout;
  let res;
  try {
    res = await fetchImpl(`${apiBase}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-key": channelKey,
        "x-wecom-userid": userId,
        ...(sessionId ? { "x-session-id": String(sessionId) } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: `oc-${Date.now()}`, method, params }),
      signal: combined,
    });
  } catch (e) {
    // 调用方主动取消（openclaw 工具 ctx 的 signal）优先于超时判断——别把「用户不等了」
    // 报成网络不可达；文案「调用已取消」让模型不再重试。
    const cancelled = cancellationIfAborted(signal);
    if (cancelled) return cancelled;
    if (timeout.aborted) return { error: "GATEWAY_TIMEOUT", detail: `超过 ${timeoutMs}ms` };
    return { error: "GATEWAY_UNREACHABLE", detail: (e && e.message) || String(e) };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    // 响应体读取阶段被取消同样归为取消（拿到头之后断开 ≠ 网关回了坏包）。
    const cancelled = cancellationIfAborted(signal);
    if (cancelled) return cancelled;
    return { error: "GATEWAY_BAD_RESPONSE", status: res.status };
  }
  if (!res.ok) {
    // 鉴权闸回的是 HTTP 错误 + `{error}`（不是 JSON-RPC 信封）：归一成同一种错误形状。
    const code = body && typeof body.error === "string" ? body.error : `HTTP_${res.status}`;
    return {
      error: code,
      status: res.status,
      ...(body && typeof body.detail === "string" ? { detail: body.detail } : {}),
    };
  }
  return body;
}

/** 取 MCP content 里第一个文本项并试解 JSON；解不出就把原文包成 `{text}`（details 仍可读）。 */
function parseTextPayload(r) {
  const content = Array.isArray(r?.content) ? r.content : [];
  const item = content.find((c) => c && c.type === "text" && typeof c.text === "string");
  if (!item) return null;
  try {
    const v = JSON.parse(item.text);
    return v && typeof v === "object" ? v : { text: item.text };
  } catch {
    return { text: item.text };
  }
}

/**
 * MCP 工具结果 → openclaw 工具结果契约。
 *
 * ★ openclaw 的 `AgentToolResult` 只认 `{content, details}`；错误判定读 `details.status|ok|
 *   success|error|timedOut|exitCode`（顶层 `isError` 被忽略）。所以工具级错误
 *   （`missing_scope` / `rate_limited` / `module_unavailable`）、JSON-RPC 错误、传输错误
 *   **都必须落到 `details.status='error'`**，否则真机上全部显示为“成功”。
 * `content` 保持 MCP 原文（人/模型可读）；`details` 附业务载荷并补 status/reason。
 */
export function toGatewayToolResult(rpc) {
  const r = rpc?.result;
  if (!r) {
    const e = rpc?.error;
    const code = gatewayErrorCode(e);
    return {
      content: [{ type: "text", text: gatewayErrorText(e, rpc?.detail, rpc?.status) }],
      details: { status: "error", reason: code, error: e ?? null },
    };
  }
  const source = r.structuredContent && typeof r.structuredContent === "object"
    ? r.structuredContent
    : parseTextPayload(r);
  const isErr = r.isError === true;
  const details = {
    ...(source && typeof source === "object" ? source : {}),
    status: isErr ? "error" : (source && typeof source.status === "string" ? source.status : "ok"),
  };
  if (isErr && details.reason === undefined) details.reason = "TOOL_ERROR";
  const content = Array.isArray(r.content) && r.content.length > 0
    ? r.content
    : [{ type: "text", text: JSON.stringify(details) }];
  return { content, details };
}

/**
 * 解出 `agent__capabilities` 的业务载荷（网关把目录 JSON 放在 content[0].text 里）。
 * 形状不合法（非 JSON / 无 tools 数组）⇒ null——调用方如实报「回包无法解析」，不猜。
 */
export function parseCapabilities(rpc) {
  const content = rpc?.result?.content;
  if (!Array.isArray(content)) return null;
  const item = content.find((c) => c && c.type === "text" && typeof c.text === "string");
  if (!item) return null;
  let v;
  try {
    v = JSON.parse(item.text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !Array.isArray(v.tools)) return null;
  return v;
}

/** 一句话描述：取首行、压掉首尾空白；过长截断（索引是给模型看的，不是文档）。 */
const INDEX_DESC_MAX = 160;
function oneLineDescription(desc) {
  const s = typeof desc === "string" ? desc.split("\n")[0].trim() : "";
  return s.length > INDEX_DESC_MAX ? s.slice(0, INDEX_DESC_MAX - 1) + "…" : s;
}

/** mutating：优先工具自报字段；模块 tools/list 未暴露时由 annotations.readOnlyHint 反推；都没有则省略。 */
function mutatingOf(t) {
  if (typeof t.mutating === "boolean") return t.mutating;
  const readOnly = t.annotations && t.annotations.readOnlyHint;
  return typeof readOnly === "boolean" ? !readOnly : undefined;
}

const META_TOOL = "agent__capabilities";

/**
 * 能力目录 → 紧凑索引（spec §8）：
 *   · 默认：tools[{name, description, mutating?}] + faces（module/face/scope/available）+
 *     lockedFaces + notes（人 gate 清单）——**不带** inputSchema，避免一轮塞进全部参数面；
 *   · `q`：按名/描述关键词过滤（大小写不敏感）；
 *   · `tool`：返回该工具完整 entry（含 inputSchema），供 platform_call 组装参数。
 * 元工具自身（agent__capabilities）不进列表——它不是 platform_call 的业务对象。
 * `gate` 语义由网关 notes 承载（人 gate 清单），插件不另造第二事实源。
 */
export function compactCapabilities(payload, { q, tool } = {}) {
  if (!payload || !Array.isArray(payload.tools)) return { error: "CAPABILITIES_UNAVAILABLE" };
  const tools = payload.tools.filter((t) => t && typeof t.name === "string" && t.name !== META_TOOL);
  const lockedFaces = Array.isArray(payload.lockedFaces) ? payload.lockedFaces : [];
  const notes = Array.isArray(payload.notes) ? payload.notes : [];

  if (typeof tool === "string" && tool.trim()) {
    const want = tool.trim();
    const hit = tools.find((t) => t.name === want);
    if (!hit) {
      return { error: "TOOL_NOT_FOUND", tool: want, available: tools.map((t) => t.name) };
    }
    return { tool: hit, lockedFaces, notes };
  }

  const keyword = typeof q === "string" ? q.trim().toLowerCase() : "";
  const visible = keyword
    ? tools.filter((t) => {
      const name = t.name.toLowerCase();
      const desc = typeof t.description === "string" ? t.description.toLowerCase() : "";
      return name.includes(keyword) || desc.includes(keyword);
    })
    : tools;

  const index = visible.map((t) => {
    const entry = { name: t.name, description: oneLineDescription(t.description) };
    const mutating = mutatingOf(t);
    if (mutating !== undefined) entry.mutating = mutating;
    return entry;
  });
  const faces = (Array.isArray(payload.faces) ? payload.faces : [])
    .filter((f) => f && typeof f.module === "string" && typeof f.face === "string")
    .map((f) => ({
      module: f.module, face: f.face, scope: f.scope, available: f.available === true,
    }));

  return {
    tools: index,
    faces,
    lockedFaces,
    notes,
    hint: "tool=<name> 可查看该工具的完整参数 schema；写操作只产草稿，发布/启用必须人做。",
  };
}

/** 身份键：模型参数里一律剥掉（身份只来自 ctx + env，防止伪造/误传）。 */
const IDENTITY_ARGS = new Set(["userId", "requesterSenderId"]);

/**
 * `platform_call` 参数归一：`{tool, args}`。
 * **不接受 userId**（spec §8）：args 里出现的身份键直接剥掉——工具若真需要「目标用户」，
 * 应显式命名为业务参数（如 recipient），而不是复用身份键。
 * notify 的 namespace 由 C 档服务端钉死（spec §6.4）：模型传了只会造成「它生效了」的误解，剥掉。
 * 元工具 `agent__capabilities` 不经 platform_call 调（platform_capabilities 才是入口）。
 */
export function buildPlatformCall(raw) {
  const p = normalizeParams(raw);
  const tool = typeof p.tool === "string" ? p.tool.trim() : "";
  if (!tool) return { error: "TOOL_REQUIRED" };
  if (tool === META_TOOL) return { error: "TOOL_NOT_CALLABLE" };
  const source = p.args && typeof p.args === "object" && !Array.isArray(p.args) ? p.args : {};
  const args = {};
  for (const [k, v] of Object.entries(source)) {
    if (IDENTITY_ARGS.has(k)) continue;
    if (k === "namespace" && tool.startsWith("notify__")) continue;
    args[k] = v;
  }
  return { tool, args };
}
