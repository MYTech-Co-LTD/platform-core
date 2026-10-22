// index.js — OpenClaw native plugin 入口。
// 为什么是 native plugin：核心只给 native plugin 注入 toolContext.requesterSenderId（可信企微
// userid），不透传给 mcp.servers（2026-09-21 三通道设计 §4 硬约束，data-analysis 实测）。
// 注册形式：api.registerTool(factory, { name })——name 必须放第二参 metadata；factory 每轮调用，
// 从 ctx.requesterSenderId 取当轮可信 userid，execute 闭包捕获。
// 另注册 message_sending 钩子（api.on）：query_data 成功回包的新鲜度行按会话捕获，外发消息
// 末尾由系统确定性附加（strip-then-append）——模型自附不稳（flash 合同弱），传输层兜底。
// ⚠️ execute 签名 (toolCallId, params, signal, onUpdate)：第一参是 toolCallId 不是模型参数。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  callPlatform,
  normalizeParams,
  toToolResult,
  DEFAULT_API_BASE,
  freshnessStore,
  makeFreshnessSendingHook,
  makeFreshnessInboundHook,
} from "./lib.js";

const CHANNEL_KEY = process.env.DATA_WECOM_CHANNEL_KEY || "";
// 同一轮后续工具调用 ctx.requesterSenderId 偶发为空的兜底（对齐生产先例实测行为）。
let lastUserId = "";

const LIST_DEF = {
  name: "list_metrics",
  description:
    "列出当前用户可见的问数指标（词表按人裁剪）。不确定有哪些指标、指标 id 或参数时先调它；以返回为准，不要凭记忆猜指标。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const QUERY_DEF = {
  name: "query_data",
  description:
    "按指标查数：metricId 来自 list_metrics；args 的**键**只能取该指标 params[].name（乐檬指标就是 `bizday`），**形状**由该 params 的 type 决定：type=date_range ⇒ 值传对象 {\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\"}（闭区间，查单日则 from=to）；type=string/number/date ⇒ 值传单值（日期单值一律 YYYY-MM-DD）。⚠️ **`date_range` 是类型名、不是键名**——传 {\"date_range\":{…}} 会被服务端 400 `unknown_param:date_range`；正确写法是 {\"bizday\":{\"from\":…,\"to\":…}}。求和类（可加）指标的回包自带 total 字段=该过滤范围的合计——直接引用该值，不要自己把明细行加总；没有 total 字段（比率/去重计数类指标）就不要跨行求和（跨行求和是错数）。「只要总数」可传 args.total=true（必须布尔）——服务端求和恒返回单行合计；区间超过 4 天优先拆单日或用 total，不要裸拉明细。参数键与形状以 list_metrics 返回的 params 为准，不要臆造。回包带 subject（本次钉死的数据主体）与 columns/rows；truncated=true 表示截断——只能答「数据不全」，收窄范围或改传 args.total=true 重查，不要把截断结果当全量。新鲜度与口径射程由系统自动附加：消息末尾会固定附上服务端算好的 📅 新鲜度行与 📐 口径行（该指标声明了射程时才有）——不要自己写任何 📅 / 📐 行，也不要复述或拼接 freshness_line / scope_line（自己写了也会被系统剥掉再统一附加）。**当答案涉及门店/对象个数时，口径行里的排除项是结论的一部分**：不要只报「5 家」，要让读者看得到分母与排除了什么。data_as_of（数据截止，已是北京时间 UTC+8，直接引用不要自行换算）可注明「数据截至 X」；没有该字段=新鲜度未知，如实说明，不要编；明细 rows 按 bizday 降序，首行即最新分区；当日数据是部分天，须标注。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id（来自 list_metrics）" },
      args: {
        type: "object",
        description:
          "指标参数键值对；**键** = list_metrics 返回的 params[].name（乐檬指标是 `bizday`），**值形状**由 type 定（type=date_range 传 {from,to} 对象，其余传单值）。⚠️ `date_range` 是类型名不是键名，写成键会 400 unknown_param:date_range；「只要总数」加 total:true（布尔，非真值一律被拒）",
        additionalProperties: true,
      },
    },
    required: ["metricId"],
    additionalProperties: false,
  },
};

const DETAIL_DEF = {
  name: "query_detail",
  description:
    "按指标下钻到明细构成（订单级）。args.bizday 必传（{\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\"}，查单日 from=to）。回包 rowCountTotal = 该范围**全量原始行数**——回答「多少行」用它，不要拿返回行数当全量。dimensions 缺省=最细（订单级）；orderBy 缺省按 value 降序（「哪几单贡献最大」直接问）。仅对声明了下钻的指标可用；回 no_detail_binding 时如实告知该指标不支持下钻、可改用 query_data，不要重试。回包带 drill_as_of/data_as_of/clock_note（两个时钟）与 scope_line——clock_note 与 scope_line 原样转述/钉在答案末尾。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id（来自 list_metrics）" },
      args: { type: "object", description: "参数；bizday 必传", additionalProperties: true },
      dimensions: { type: "array", items: { type: "string" } },
      orderBy: { type: "string" }, desc: { type: "boolean" },
      limit: { type: "number" }, offset: { type: "number" },
    },
    required: ["metricId"],
    additionalProperties: false,
  },
};

export default definePluginEntry({
  id: "data-query",
  name: "Data Query",
  description: "问数通道 C：可信企微 userid + 渠道凭证 → 平台问数 API；权限由平台授权核心按人裁决。",
  register(api) {
    const apiBase = process.env.DATA_API_BASE || DEFAULT_API_BASE;
    // onResult：工具回包的旁路观察（捕获新鲜度行）。**绝不许 throw**——它在 execute 主路径上，
    // 抛了会把正常查数搞挂；这里吞异常即可（新鲜度行缺失可接受，查数失败不可接受）。
    const factory = (def, run, onResult) => (ctx) => {
      const userId = (ctx && ctx.requesterSenderId) || lastUserId;
      if (userId) lastUserId = userId;
      // 会话键：钩子按同一把键取捕获（拿不到 ⇒ 全局槽，见 lib.js FRESHNESS_GLOBAL_SLOT）。
      const sessionKey = (ctx && ctx.sessionKey) || "";
      // runId：本轮 turn 的关联键（前向兼容——当前宿主工具 ctx 无 runId，恒空串）。
      const runId = (ctx && ctx.runId) || "";
      return {
        ...def,
        // 必须返回 OpenClaw 工具结果契约形状（含 content[]）——见 lib.js toToolResult。
        execute: async (_toolCallId, params) => {
          const result = await run(normalizeParams(params), userId);
          if (onResult) {
            try {
              onResult(result, sessionKey, runId);
            } catch {
              // 旁路观察失败不影响工具返回。
            }
          }
          return toToolResult(result);
        },
      };
    };
    api.registerTool(
      factory(LIST_DEF, (_params, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/metrics" }),
      ),
      { name: LIST_DEF.name },
    );
    api.registerTool(
      factory(
        QUERY_DEF,
        (params, userId) =>
          callPlatform({
            apiBase,
            channelKey: CHANNEL_KEY,
            userId,
            path: "/query",
            method: "POST",
            body: { metricId: params.metricId, args: params.args ?? {} },
          }),
        // 捕获服务端正典固定行（📅 新鲜度 + 📐 口径射程）。两个字段都可能缺席：
        // 没有 freshness_line = 未接新鲜度链路；没有 scope_line = 该指标未声明射程。
        // 整条替换（不是字段合并）⇒ 上一次查询的 📐 行不会漏到这一次。
        (result, sessionKey, runId) => {
          if (!result) return;
          const freshness =
            typeof result.freshness_line === "string" && result.freshness_line ? result.freshness_line : undefined;
          const scope =
            typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
          if (freshness || scope) freshnessStore.capture(sessionKey, { freshness, scope }, runId);
        },
      ),
      { name: QUERY_DEF.name },
    );
    // query_detail（明细下钻，2026-10-21 spec §2.6）：POST /query/detail。回包没有 freshness_line
    // （明细面只有 data_as_of/clock_note 两个时钟），只有 scope_line 可能需要捕获——
    // freshnessStore.capture 的对象形态按字段解构，缺 freshness 合法（entry.line=undefined，
    // 钩子侧按非串过滤，scope 单独在场即只附 📐；scope.test.js「单独在场」已锁该形状）。
    api.registerTool(
      factory(
        DETAIL_DEF,
        (params, userId) =>
          callPlatform({
            apiBase,
            channelKey: CHANNEL_KEY,
            userId,
            path: "/query/detail",
            method: "POST",
            body: {
              metricId: params.metricId,
              args: params.args ?? {},
              ...(Array.isArray(params.dimensions) ? { dimensions: params.dimensions } : {}),
              ...(typeof params.orderBy === "string" ? { orderBy: params.orderBy } : {}),
              ...(typeof params.desc === "boolean" ? { desc: params.desc } : {}),
              ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
              ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            },
          }),
        (result, sessionKey, runId) => {
          if (!result) return;
          const scope = typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
          if (scope) freshnessStore.capture(sessionKey, { scope }, runId);
        },
      ),
      { name: DETAIL_DEF.name },
    );
    // ── Wave 2（ref #985）：registry 子集三工具，经 POST /toolbox（registry 的 HTTP 薄封装）调用。
    // 与既有工具同一 callPlatform/同一错误文案映射/同一捕获机制——插件仍零权限逻辑。
    const DESCRIBE_DEF = {
      name: "describe_metric",
      description:
        "按 id 取指标详情：口径定义/粒度维度/参数/归属/档位/版本/新鲜度。args 键或维度名拿不准时先调它（id 取自 list_metrics）；sample_dimension_values 的 dimension 必须是这里 grain 里的一员。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "指标 id（来自 list_metrics）" } },
        required: ["id"],
        additionalProperties: false,
      },
    };
    const SAMPLE_DEF = {
      name: "sample_dimension_values",
      description:
        "取某指标某维度的取值与频次（≤50 行），用于确认过滤值/分组维度的确切写法（如门店名）。dimension 必须是该指标粒度维度之一（describe_metric 返回的 grain）；回包 truncated=true 时只说明「值太多被截断」，不是数据错误。",
      parameters: {
        type: "object",
        properties: {
          metricId: { type: "string", description: "指标 id" },
          dimension: { type: "string", description: "维度名（grain 之一）" },
          q: { type: "string", description: "子串过滤（可选）" },
          limit: { type: "number", description: "1–50，缺省 50" },
        },
        required: ["metricId", "dimension"],
        additionalProperties: false,
      },
    };
    const FRESHNESS_DEF = {
      name: "get_freshness",
      description:
        "数据截止日/物化时刻/滞后秒。scope=指标 id 查该指标链路水位；缺省查全局水位。用户问「数据到几号/新不新」用它，不要靠猜。回 status=unknown 如实说「新鲜度未知」，不要编。",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", description: "指标 id（缺省 = 全局）" } },
        required: [],
        additionalProperties: false,
      },
    };
    api.registerTool(
      factory(DESCRIBE_DEF, (params, userId) =>
        callPlatform({
          apiBase, channelKey: CHANNEL_KEY, userId,
          path: "/toolbox", method: "POST",
          body: { tool: "describe_metric", args: { id: params.id } },
        }),
      ),
      { name: DESCRIBE_DEF.name },
    );
    api.registerTool(
      factory(SAMPLE_DEF, (params, userId) =>
        callPlatform({
          apiBase, channelKey: CHANNEL_KEY, userId,
          path: "/toolbox", method: "POST",
          body: {
            tool: "sample_dimension_values",
            args: {
              metricId: params.metricId,
              dimension: params.dimension,
              ...(typeof params.q === "string" && params.q ? { q: params.q } : {}),
              ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            },
          },
        }),
      ),
      { name: SAMPLE_DEF.name },
    );
    api.registerTool(
      factory(
        FRESHNESS_DEF,
        (params, userId) =>
          callPlatform({
            apiBase, channelKey: CHANNEL_KEY, userId,
            path: "/toolbox", method: "POST",
            body: { tool: "get_freshness", args: { ...(typeof params.scope === "string" && params.scope ? { scope: params.scope } : {}) } },
          }),
        // 捕获 get_freshness 回包的正典 📅 行（metric 支才有 line 字段）。不捕获的话：模型转述
        // 该行会被 message_sending 钩子剥掉、又没有捕获可重附 ⇒ 新鲜度行静默丢失（决策 D-F1）。
        (result, sessionKey, runId) => {
          if (!result) return;
          const line = typeof result.line === "string" && result.line ? result.line : undefined;
          if (line) freshnessStore.capture(sessionKey, { freshness: line }, runId);
        },
      ),
      { name: FRESHNESS_DEF.name },
    );
    // 新鲜度行确定性附加（strip-then-append，天然去重）。钩子注册方法按 zh-thinking 插件
    // 同款口径用 api.on（2026.9.9 实测公开方法）；拿不到就跳过并留诊断日志——工具仍可用，
    // 只退回「模型自附」的旧行为，绝不让插件装载失败。
    if (typeof api.on === "function") {
      api.on("message_sending", makeFreshnessSendingHook(freshnessStore));
      // 入站清账：新用户消息一进来即清本会话捕获 ⇒ 陈旧行不跨轮泄漏（TTL 保留作兜底）。
      api.on("message_received", makeFreshnessInboundHook(freshnessStore));
      console.log(
        "[data-query] 已注册 message_sending（新鲜度行 strip+append）+ message_received（入站清账）钩子",
      );
    } else {
      console.log(
        "[data-query] api.on 不可用，钩子未注册；新鲜度行退回模型自附（不稳定）",
      );
    }
  },
});
