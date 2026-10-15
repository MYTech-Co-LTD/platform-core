// index.js — OpenClaw native plugin 入口。
// 为什么是 native plugin：核心只给 native plugin 注入 toolContext.requesterSenderId（可信企微
// userid），不透传给 mcp.servers（2026-09-21 三通道设计 §4 硬约束，data-analysis 实测）。
// 注册形式：api.registerTool(factory, { name })——name 必须放第二参 metadata；factory 每轮调用，
// 从 ctx.requesterSenderId 取当轮可信 userid，execute 闭包捕获。
// ⚠️ execute 签名 (toolCallId, params, signal, onUpdate)：第一参是 toolCallId 不是模型参数。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callPlatform, normalizeParams, toToolResult, DEFAULT_API_BASE } from "./lib.js";

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
    "按指标查数：metricId 来自 list_metrics；args 按该指标 params 的 type 给值——type=date_range 的参数传对象 {\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\"}（闭区间，查单日则 from=to）；type=string/number/date 的参数传单值（日期单值一律 YYYY-MM-DD）。参数键与形状以 list_metrics 返回的 params 为准，不要臆造。回包带 subject（本次钉死的数据主体）与 columns/rows；truncated=true 表示截断，改用聚合口径。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id（来自 list_metrics）" },
      args: {
        type: "object",
        description:
          "指标参数键值对；键与形状以 list_metrics 返回的 params 为准（type=date_range 传 {from,to} 对象，其余传单值）",
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
    const factory = (def, run) => (ctx) => {
      const userId = (ctx && ctx.requesterSenderId) || lastUserId;
      if (userId) lastUserId = userId;
      return {
        ...def,
        // 必须返回 OpenClaw 工具结果契约形状（含 content[]）——见 lib.js toToolResult。
        execute: async (_toolCallId, params) =>
          toToolResult(await run(normalizeParams(params), userId)),
      };
    };
    api.registerTool(
      factory(LIST_DEF, (_params, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/metrics" }),
      ),
      { name: LIST_DEF.name },
    );
    api.registerTool(
      factory(QUERY_DEF, (params, userId) =>
        callPlatform({
          apiBase,
          channelKey: CHANNEL_KEY,
          userId,
          path: "/query",
          method: "POST",
          body: { metricId: params.metricId, args: params.args ?? {} },
        }),
      ),
      { name: QUERY_DEF.name },
    );
  },
});
