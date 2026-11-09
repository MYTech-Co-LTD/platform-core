// index.js — OpenClaw native plugin 入口。
// 为什么是 native plugin：核心只给 native plugin 注入 toolContext.requesterSenderId（可信企微
// userid），不透传给 mcp.servers（2026-09-21 三通道设计 §4 硬约束，data-analysis 实测）。
// 注册形式：api.registerTool(factory, { name })——name 必须放第二参 metadata；factory 每轮调用，
// 从 ctx.requesterSenderId 取当轮可信 userid，execute 闭包捕获。
// 另注册 message_sending 钩子（api.on）：query_data 成功回包的新鲜度行按会话捕获，外发消息
// 末尾由系统确定性附加（strip-then-append）——模型自附不稳（flash 合同弱），传输层兜底。
// ⚠️ execute 签名 (toolCallId, params, signal, onUpdate)：第一参是 toolCallId 不是模型参数。
//
// 工具定义（name/description/parameters）不再手写：构建期由 modules/data/skill/contract.json
// 渲染到 ./generated/tools.js（scripts/gen-openclaw-skill.mjs）。本文件只留传输层映射。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { TOOL_DEFS } from "./generated/tools.js";
import {
  callPlatform,
  normalizeParams,
  toToolResult,
  DEFAULT_API_BASE,
  freshnessStore,
  resolveToolUserId,
  makeFreshnessSendingHook,
  makeFreshnessInboundHook,
} from "./lib.js";

const CHANNEL_KEY = process.env.DATA_WECOM_CHANNEL_KEY || "";
// 同一会话后续工具调用 ctx.requesterSenderId 偶发为空的兜底（#964：**按会话键隔离**）。
// 旧实现是模块级全局（跨会话共用）⇒ 新会话 ctx 为空时会用上一会话的 userid 取数 =
// 拿越权面换少一次报错；现在跨会话绝不继承，无会话记录则如实返回身份错误。
const lastUserIdBySession = new Map();

export default definePluginEntry({
  id: "data-query",
  name: "Data Query",
  description: "问数通道 C：可信企微 userid + 渠道凭证 → 平台问数 API；权限由平台授权核心按人裁决。",
  register(api) {
    const apiBase = process.env.DATA_API_BASE || DEFAULT_API_BASE;
    // onResult：工具回包的旁路观察（捕获新鲜度行）。**绝不许 throw**——它在 execute 主路径上，
    // 抛了会把正常查数搞挂；这里吞异常即可（新鲜度行缺失可接受，查数失败不可接受）。
    const factory = (def, run, onResult) => (ctx) => {
      const { userId, sessionKey } = resolveToolUserId(ctx, lastUserIdBySession);
      // runId：本轮 turn 的关联键（前向兼容——当前宿主工具 ctx 无 runId，恒空串）。
      const runId = (ctx && ctx.runId) || "";
      return {
        ...def,
        // 必须返回 OpenClaw 工具结果契约形状（含 content[]）——见 lib.js toToolResult。
        execute: async (_toolCallId, params) => {
          const result = await run(normalizeParams(params), userId, sessionKey);
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

    // 传输层映射：契约只描述「是什么」，HTTP 路径/回包观察是通道 C 的本地实现。
    // 签名与 factory 的 run 一致：(params, userId, sessionKey)；apiBase/CHANNEL_KEY 闭包捕获。
    const ENDPOINTS = new Map([
      ["list_metrics", (_p, userId, sessionKey) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, sessionId: sessionKey, path: "/metrics" })],
      ["query", (p, userId, sessionKey) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, sessionId: sessionKey, path: "/query", method: "POST", body: {
          metricId: p.metricId, args: p.args ?? {},
          ...(Array.isArray(p.dimensions) ? { dimensions: p.dimensions } : {}),
          ...(Array.isArray(p.orderBy) ? { orderBy: p.orderBy } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        } })],
      ["query_detail", (p, userId, sessionKey) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, sessionId: sessionKey, path: "/query/detail", method: "POST", body: {
          metricId: p.metricId, args: p.args ?? {},
          ...(Array.isArray(p.dimensions) ? { dimensions: p.dimensions } : {}),
          ...(typeof p.orderBy === "string" ? { orderBy: p.orderBy } : {}),
          ...(typeof p.desc === "boolean" ? { desc: p.desc } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
          ...(typeof p.offset === "number" ? { offset: p.offset } : {}),
        } })],
      ["search", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "search_catalog", args: {
            q: p.q,
            ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
            ...(typeof p.tier === "string" ? { tier: p.tier } : {}),
          },
        } })],
      ["describe_metric", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "describe_metric", args: { id: p.id, ...(p.coverage === true ? { coverage: true } : {}) },
        } })],
      ["sample_dimension_values", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "sample_dimension_values", args: {
            metricId: p.metricId, dimension: p.dimension,
            ...(typeof p.q === "string" && p.q ? { q: p.q } : {}),
            ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
          },
        } })],
      ["freshness", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "get_freshness", args: { ...(typeof p.scope === "string" && p.scope ? { scope: p.scope } : {}) },
        } })],
    ]);

    const OBSERVERS = new Map([
      ["query", (result, sessionKey, runId) => {
        if (!result) return;
        const freshness = typeof result.freshness_line === "string" && result.freshness_line ? result.freshness_line : undefined;
        const scope = typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
        if (freshness || scope) freshnessStore.capture(sessionKey, { freshness, scope }, runId);
      }],
      ["query_detail", (result, sessionKey, runId) => {
        if (!result) return;
        const scope = typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
        if (scope) freshnessStore.capture(sessionKey, { scope }, runId);
      }],
      ["freshness", (result, sessionKey, runId) => {
        if (!result) return;
        const line = typeof result.line === "string" && result.line ? result.line : undefined;
        if (line) freshnessStore.capture(sessionKey, { freshness: line }, runId);
      }],
    ]);

    for (const raw of TOOL_DEFS) {
      const { id, ...def } = raw; // id 只用于查传输/观察器，不交给 openclaw（防网关拒绝未知字段）
      const run = ENDPOINTS.get(id);
      if (run === undefined) throw new Error(`data-query: 工具 ${id} 没有传输实现`);
      api.registerTool(factory(def, run, OBSERVERS.get(id)), { name: def.name });
    }

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
