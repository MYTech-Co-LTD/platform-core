// index.js — OpenClaw native plugin 入口。
// 为什么是 native plugin：核心只给 native plugin 注入 toolContext.requesterSenderId（可信企微
// userid），不透传给 mcp.servers（2026-09-21 三通道设计 §4 硬约束，data-analysis 实测）。
// 注册形式：api.registerTool(factory, { name })——name 必须放第二参 metadata；factory 每轮调用，
// 从 ctx.requesterSenderId 取当轮可信 userid，execute 闭包捕获。
// 另注册 message_sending 钩子（api.on）：query_data 成功回包的新鲜度行按会话捕获，外发消息
// 末尾由系统确定性附加（strip-then-append）——模型自附不稳（flash 合同弱），传输层兜底。
// ⚠️ execute 签名 (toolCallId, params, signal, onUpdate)：第一参是 toolCallId 不是模型参数。
//
// DATA 工具定义（name/description/parameters）不手写：构建期由 modules/data/skill/contract.json
// 渲染到 ./generated/tools.js（scripts/gen-openclaw-skill.mjs）。本文件只留传输层映射。
// 例外：两个 native 平台能力元工具（platform_capabilities / platform_call，走 /api/agent/mcp）
// 不是 skill contract 工具，DEF 在本文件手写（contracts.test.js 只放行这两个名字）。
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
  // 平台能力网关（native 元工具，2026-11-16 能力网关 spec §8；#2360）
  DEFAULT_AGENT_API_BASE,
  callGateway,
  toGatewayToolResult,
  parseCapabilities,
  compactCapabilities,
  buildPlatformCall,
} from "./lib.js";

const CHANNEL_KEY = process.env.DATA_WECOM_CHANNEL_KEY || "";
// 能力网关基址：openclaw 服务 env（独立容器，不在根 .env.example）；缺省指平台 server。
const AGENT_API_BASE = process.env.AGENT_API_BASE || DEFAULT_AGENT_API_BASE;
// native 元工具定义：**不**进 generated/tools.js——它们不是 modules/data skill contract 的工具，
// 而是走平台能力网关的 openclaw 侧元工具（契约见 openclaw.plugin.json contracts.tools）。
// platform_call 参数里没有 userId：身份只来自 ctx.requesterSenderId + 容器渠道凭证。
const CAPS_DEF = {
  name: "platform_capabilities",
  description: "列出当前企微用户可用的平台管理工具（指标/报表/通知/表单草稿）与缺失的 scope；先调它。",
  parameters: {
    type: "object",
    properties: { q: { type: "string" }, tool: { type: "string" } },
    additionalProperties: false,
  },
};
const CALL_DEF = {
  name: "platform_call",
  description: "调用 platform_capabilities 返回的工具；tool 名必须来自列表；写操作只产草稿，发布/启用必须人做。",
  parameters: {
    type: "object",
    properties: { tool: { type: "string" }, args: { type: "object", additionalProperties: true } },
    required: ["tool"],
    additionalProperties: false,
  },
};
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

    // /toolbox 是 registry 的 HTTP 薄封装：四个工具共用同一请求形状。
    const toolbox = (tool, args, userId) =>
      callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: { tool, args } });

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
        toolbox("search_catalog", {
          q: p.q,
          ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
          ...(typeof p.tier === "string" ? { tier: p.tier } : {}),
        }, userId)],
      ["describe_metric", (p, userId) =>
        toolbox("describe_metric", { id: p.id, ...(p.coverage === true ? { coverage: true } : {}) }, userId)],
      ["sample_dimension_values", (p, userId) =>
        toolbox("sample_dimension_values", {
          metricId: p.metricId, dimension: p.dimension,
          ...(typeof p.q === "string" && p.q ? { q: p.q } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        }, userId)],
      ["freshness", (p, userId) =>
        toolbox("get_freshness", {
          ...(typeof p.scope === "string" && p.scope ? { scope: p.scope } : {}),
        }, userId)],
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

    // openclaw 按注册顺序把工具放进模型上下文；保持迁移前顺序（list, query, query_detail, search, describe, sample, freshness）。
    const REGISTER_ORDER = ["list_metrics", "query", "query_detail", "search", "describe_metric", "sample_dimension_values", "freshness"];
    // 契约 id 集合必须与注册顺序完全一致：缺任一 id（漏注册）或有多余 id（新增工具未接线）都装载失败。
    const unregistered = new Set(TOOL_DEFS.map((d) => d.id));
    for (const id of REGISTER_ORDER) {
      if (!unregistered.delete(id)) throw new Error(`data-query: 注册顺序里的工具 ${id} 在契约中不存在或重复`);
    }
    if (unregistered.size > 0) {
      throw new Error(`data-query: 契约工具 ${[...unregistered].join(", ")} 未列入 REGISTER_ORDER`);
    }
    for (const id of REGISTER_ORDER) {
      const raw = TOOL_DEFS.find((d) => d.id === id);
      const { id: _id, ...def } = raw; // id 只用于查传输/观察器，不交给 openclaw（防网关拒绝未知字段）
      const run = ENDPOINTS.get(id);
      if (run === undefined) throw new Error(`data-query: 工具 ${id} 没有传输实现`);
      api.registerTool(factory(def, run, OBSERVERS.get(id)), { name: def.name });
    }

    // ── native 平台能力元工具（#2360）─────────────────────────────────────────
    // 与上面同一 factory 形态：ctx 每轮注入，execute 闭包捕获当轮可信 userid。
    // 结果映射走 toGatewayToolResult（MCP content/isError/structuredContent），
    // **不是** toToolResult（那期待平台 HTTP JSON 业务载荷）。
    api.registerTool((ctx) => {
      const { userId, sessionKey } = resolveToolUserId(ctx, lastUserIdBySession);
      return {
        ...CAPS_DEF,
        execute: async (_toolCallId, params, signal) => {
          const p = normalizeParams(params);
          const rpc = await callGateway({
            apiBase: AGENT_API_BASE,
            channelKey: CHANNEL_KEY,
            userId,
            sessionId: sessionKey,
            method: "tools/call",
            params: { name: "agent__capabilities", arguments: {} },
            signal,
          });
          if (!rpc || rpc.result === undefined) return toGatewayToolResult(rpc);
          const payload = parseCapabilities(rpc);
          // 解不出目录时**原样透传**网关回包（可能是 rate_limited 等工具级错误），
          // 不伪装成空目录、也不吞掉服务端原因。
          if (!payload) return toGatewayToolResult(rpc);
          // 默认紧凑索引（不塞全部 schema）；q 过滤；tool=<name> 取完整 entry。
          return toToolResult(compactCapabilities(payload, {
            q: typeof p.q === "string" ? p.q : undefined,
            tool: typeof p.tool === "string" ? p.tool : undefined,
          }));
        },
      };
    }, { name: CAPS_DEF.name });

    api.registerTool((ctx) => {
      const { userId, sessionKey } = resolveToolUserId(ctx, lastUserIdBySession);
      return {
        ...CALL_DEF,
        execute: async (_toolCallId, params, signal) => {
          // buildPlatformCall 会剥掉 args 里的身份键——模型无法通过参数指定「以谁的身份调」。
          const built = buildPlatformCall(params);
          if (built.error) return toToolResult(built);
          const rpc = await callGateway({
            apiBase: AGENT_API_BASE,
            channelKey: CHANNEL_KEY,
            userId,
            sessionId: sessionKey,
            method: "tools/call",
            params: { name: built.tool, arguments: built.args },
            signal,
          });
          return toGatewayToolResult(rpc);
        },
      };
    }, { name: CALL_DEF.name });

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
