// lib.js — 问数插件纯逻辑（不 import openclaw SDK；node --test 可直跑）。
// 权限判定零逻辑：词表裁剪/主体钉死/fail-closed 全在平台授权核心（约束 6）。
// 这里做四件事：参数归一（宿主 execute 的 params 形状有历史差异）、平台调用、错误文案映射、
// 新鲜度行的捕获与确定性附加（message_sending 钩子的纯逻辑，2026-10-16）。

export const DEFAULT_API_BASE = "http://server:13000/api/modules/data";
// 未关联指引指向的山海平台入口（只写文案，不含任何凭证）。
export const PLATFORM_ORIGIN = "https://platform.shanhaiyiguo.com";

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
  const { fetchImpl = fetch, apiBase = DEFAULT_API_BASE, channelKey, userId, path, method = "GET", body } = opts;
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
      error: `你的企微账号还没关联平台账号：用企微扫码登录一次 ${PLATFORM_ORIGIN}（登录即完成关联，无需任何绑定操作），然后回来重新提问。`,
    };
  }
  if (resp.status === 401) {
    return { code: data.error || "CHANNEL_KEY_INVALID", error: "渠道认证失败（" + (data.error || "HTTP 401") + "），请联系管理员检查渠道凭证。" };
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
