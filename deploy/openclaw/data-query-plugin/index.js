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
    "按指标查数：metricId 来自 list_metrics；args 按该指标 params 的 type 给值——type=date_range 的参数传对象 {\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\"}（闭区间，查单日则 from=to）；type=string/number/date 的参数传单值（日期单值一律 YYYY-MM-DD）。求和类（可加）指标的回包自带 total 字段=该过滤范围的合计——直接引用该值，不要自己把明细行加总；没有 total 字段（比率/去重计数类指标）就不要跨行求和（跨行求和是错数）。「只要总数」可传 args.total=true（必须布尔）——服务端求和恒返回单行合计；区间超过 4 天优先拆单日或用 total，不要裸拉明细。参数键与形状以 list_metrics 返回的 params 为准，不要臆造。回包带 subject（本次钉死的数据主体）与 columns/rows；truncated=true 表示截断——只能答「数据不全」，收窄范围或改传 args.total=true 重查，不要把截断结果当全量。新鲜度声明由系统自动附加：消息末尾会固定附上服务端算好的 📅 新鲜度行——不要自己写任何 📅 行，也不要复述或拼接 freshness_line（自己写了也会被系统剥掉再统一附加）。data_as_of（数据截止，已是北京时间 UTC+8，直接引用不要自行换算）可注明「数据截至 X」；没有该字段=新鲜度未知，如实说明，不要编；明细 rows 按 bizday 降序，首行即最新分区；当日数据是部分天，须标注。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id（来自 list_metrics）" },
      args: {
        type: "object",
        description:
          "指标参数键值对；键与形状以 list_metrics 返回的 params 为准（type=date_range 传 {from,to} 对象，其余传单值）；「只要总数」加 total:true（布尔，非真值一律被拒）",
        additionalProperties: true,
      },
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
        // 捕获服务端正典新鲜度行（回包没有该字段 = 未接新鲜度链路，不捕获 ⇒ 钩子原样放行）。
        (result, sessionKey, runId) => {
          if (result && typeof result.freshness_line === "string" && result.freshness_line) {
            freshnessStore.capture(sessionKey, result.freshness_line, runId);
          }
        },
      ),
      { name: QUERY_DEF.name },
    );
    // 新鲜度行确定性附加（strip-then-append，天然去重）。钩子注册方法按 zh-thinking 插件
    // 同款口径用 api.on（2026.9.9 实测公开方法）；拿不到就跳过并留诊断日志——工具仍可用，
    // 只退回「模型自附」的旧行为，绝不让插件装载失败。
    if (typeof api.on === "function") {
      api.on("message_sending", makeFreshnessSendingHook(freshnessStore));
      console.log("[data-query] 已注册 message_sending 钩子（新鲜度行 strip+append，TTL 10min）");
    } else {
      console.log(
        "[data-query] api.on 不可用，message_sending 钩子未注册；新鲜度行退回模型自附（不稳定）",
      );
    }
  },
});
