// platform-tools.test.js — native 元工具 platform_capabilities / platform_call 的回归（#2360）。
// 钉四件事：
//   ① callGateway 的请求形状（URL/头/JSON-RPC body）与 fail-closed（缺 key/userid 不发请求）；
//   ② toGatewayToolResult 把 MCP result 映射成 openclaw 工具结果契约（content/isError/structuredContent）；
//   ③ platform_call **不接受 userId**：身份只来自 ctx + env，模型给的 args.userId 必须被剥掉；
//   ④ 能力紧凑索引（默认不带 inputSchema；tool=<name> 才带全量 schema）与 lockedFaces 透传。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_AGENT_API_BASE,
  callGateway,
  toGatewayToolResult,
  parseCapabilities,
  compactCapabilities,
  buildPlatformCall,
} from "./lib.js";

function stubFetch(body, { status = 200, jsonThrows = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status < 400,
      json: async () => {
        if (jsonThrows) throw new Error("not json");
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const GW = { apiBase: "http://x/api/agent", channelKey: "k", userId: "u1" };

// ── callGateway：请求形状与 fail-closed ────────────────────────────────────────

test("AGENT_API_BASE 默认指向平台网关（独立容器 env，不在根 .env.example）", () => {
  assert.equal(DEFAULT_AGENT_API_BASE, "http://server:13000/api/agent");
});

test("缺渠道凭证：不发请求，返回 CHANNEL_KEY_MISSING", async () => {
  const f = stubFetch({});
  const r = await callGateway({ ...GW, channelKey: "", method: "tools/list", fetchImpl: f });
  assert.deepEqual(r, { error: "CHANNEL_KEY_MISSING" });
  assert.equal(f.calls.length, 0);
});

test("缺 userid：fail-closed 不发请求，返回 USERID_MISSING", async () => {
  const f = stubFetch({});
  const r = await callGateway({ ...GW, userId: "", method: "tools/list", fetchImpl: f });
  assert.deepEqual(r, { error: "USERID_MISSING" });
  assert.equal(f.calls.length, 0);
});

test("请求形状：POST {apiBase}/mcp，带三身份头，body 是 JSON-RPC", async () => {
  const f = stubFetch({ jsonrpc: "2.0", id: "x", result: { tools: [] } });
  const params = { name: "forms__list_forms", arguments: {} };
  const r = await callGateway({
    ...GW, sessionId: 12345, method: "tools/call", params, fetchImpl: f,
  });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "http://x/api/agent/mcp");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-channel-key"], "k");
  assert.equal(init.headers["x-wecom-userid"], "u1");
  assert.equal(init.headers["x-session-id"], "12345");
  const body = JSON.parse(init.body);
  assert.equal(body.jsonrpc, "2.0");
  assert.match(body.id, /^oc-\d+$/);
  assert.equal(body.method, "tools/call");
  assert.deepEqual(body.params, params);
  assert.ok(r.result);
});

test("无会话键：不带 x-session-id（不写空串）", async () => {
  const f = stubFetch({ jsonrpc: "2.0", id: "x", result: {} });
  await callGateway({ ...GW, method: "tools/list", fetchImpl: f });
  assert.equal("x-session-id" in f.calls[0].init.headers, false);
});

test("未给 apiBase：落到 DEFAULT_AGENT_API_BASE", async () => {
  const f = stubFetch({ jsonrpc: "2.0", id: "x", result: {} });
  await callGateway({ channelKey: "k", userId: "u1", method: "tools/list", fetchImpl: f });
  assert.equal(f.calls[0].url, DEFAULT_AGENT_API_BASE + "/mcp");
});

test("网络不可达 / 非 JSON 回包：不抛，返回可映射的错误码", async () => {
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal((await callGateway({ ...GW, method: "tools/list", fetchImpl: down })).error, "GATEWAY_UNREACHABLE");
  const junk = await callGateway({ ...GW, method: "tools/list", fetchImpl: stubFetch(null, { jsonThrows: true }) });
  assert.equal(junk.error, "GATEWAY_BAD_RESPONSE");
});

// ── toGatewayToolResult：MCP → openclaw 契约 ─────────────────────────────────

test("结果映射：content 原样、isError 透传、structuredContent 透传", () => {
  const content = [{ type: "text", text: "ok" }];
  const r = toGatewayToolResult({ result: { content, isError: false, structuredContent: { a: 1 } } });
  assert.deepEqual(r.content, content);
  assert.equal(r.isError, false);
  assert.deepEqual(r.structuredContent, { a: 1 });
});

test("结果映射：isError=true 原样透传（业务拒绝不是传输异常）", () => {
  const r = toGatewayToolResult({ result: { content: [{ type: "text", text: "denied" }], isError: true } });
  assert.equal(r.isError, true);
});

test("结果映射：result 缺 content ⇒ 用 result 自身兜底，不产出空 content", () => {
  const r = toGatewayToolResult({ result: { tools: [] } });
  assert.equal(r.content.length, 1);
  assert.deepEqual(JSON.parse(r.content[0].text), { tools: [] });
  assert.equal(r.isError, false);
});

test("结果映射：JSON-RPC error ⇒ isError，文本是错误体", () => {
  const r = toGatewayToolResult({ error: { code: -32601, message: "method not found" } });
  assert.equal(r.isError, true);
  assert.deepEqual(JSON.parse(r.content[0].text), { code: -32601, message: "method not found" });
});

test("结果映射：本地 fail-closed 错误码给可操作中文文案（不是裸码）", () => {
  const missing = toGatewayToolResult({ error: "USERID_MISSING" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /身份/);
  const noKey = toGatewayToolResult({ error: "CHANNEL_KEY_MISSING" });
  assert.match(noKey.content[0].text, /渠道凭证/);
});

// ── 能力紧凑索引 ──────────────────────────────────────────────────────────────

const CAPS_RPC = {
  result: {
    content: [{
      type: "text",
      text: JSON.stringify({
        faces: [
          { module: "forms", face: "manage", group: "forms", audience: "wecom", scope: "forms:manage", available: true },
          { module: "data", face: "manage", group: "data", audience: "wecom", scope: "data:manage", available: false },
        ],
        tools: [
          {
            name: "agent__capabilities", description: "元工具", inputSchema: { type: "object" },
            module: "agent", face: "capabilities",
          },
          {
            name: "forms__list_forms", description: "列出本租户可查看的表单（摘要）。",
            inputSchema: { type: "object", properties: {} }, mutating: false,
            annotations: { readOnlyHint: true }, requiredScope: null, module: "forms", face: "manage",
          },
          {
            name: "forms__generate_form_draft",
            description: "用自然语言描述业务场景，生成表单契约并落为草稿。\n第二行不该进索引。",
            inputSchema: { type: "object", properties: { description: { type: "string" } } },
            mutating: true, annotations: { readOnlyHint: false }, requiredScope: "forms:manage",
            module: "forms", face: "manage",
          },
          {
            // notify 的 tools/list 不暴露 mutating（网关只加 catalogNote）：从 annotations 推。
            name: "notify__send_message", description: "发一条通知。",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false }, catalogNote: "mutating/requiredScope 见模块 catalog",
            module: "notify", face: "manage",
          },
        ],
        lockedFaces: [{ module: "data", face: "manage", scope: "data:manage" }],
        notes: ["forms:publish 必须人做"],
      }),
    }],
    isError: false,
  },
};

test("parseCapabilities：从 content[0].text 解出目录；垃圾回包返回 null", () => {
  const payload = parseCapabilities(CAPS_RPC);
  assert.equal(payload.tools.length, 4);
  assert.deepEqual(payload.lockedFaces, [{ module: "data", face: "manage", scope: "data:manage" }]);
  assert.equal(parseCapabilities({ result: { content: [{ type: "text", text: "not json" }] } }), null);
  assert.equal(parseCapabilities({ error: { code: -32603, message: "x" } }), null);
  assert.equal(parseCapabilities(null), null);
});

test("compactCapabilities：默认紧凑索引（name+一句话+mutating），不带 inputSchema/元工具", () => {
  const out = compactCapabilities(parseCapabilities(CAPS_RPC));
  const names = out.tools.map((t) => t.name);
  assert.deepEqual(names, ["forms__list_forms", "forms__generate_form_draft", "notify__send_message"]);
  const draft = out.tools.find((t) => t.name === "forms__generate_form_draft");
  assert.equal(draft.description, "用自然语言描述业务场景，生成表单契约并落为草稿。");
  assert.equal(draft.mutating, true);
  assert.equal("inputSchema" in draft, false);
  assert.equal(out.tools.find((t) => t.name === "forms__list_forms").mutating, false);
  // notify 未暴露 mutating 字段 ⇒ 由 annotations.readOnlyHint 推导。
  assert.equal(out.tools.find((t) => t.name === "notify__send_message").mutating, true);
  assert.deepEqual(out.lockedFaces, [{ module: "data", face: "manage", scope: "data:manage" }]);
  assert.deepEqual(out.notes, ["forms:publish 必须人做"]);
  assert.deepEqual(out.faces, [
    { module: "forms", face: "manage", scope: "forms:manage", available: true },
    { module: "data", face: "manage", scope: "data:manage", available: false },
  ]);
});

test("compactCapabilities：q 按名/描述过滤（大小写不敏感）", () => {
  const out = compactCapabilities(parseCapabilities(CAPS_RPC), { q: "FORM_DRAFT" });
  assert.deepEqual(out.tools.map((t) => t.name), ["forms__generate_form_draft"]);
  const byDesc = compactCapabilities(parseCapabilities(CAPS_RPC), { q: "通知" });
  assert.deepEqual(byDesc.tools.map((t) => t.name), ["notify__send_message"]);
});

test("compactCapabilities：tool=<name> 返回完整 entry（含 inputSchema）", () => {
  const out = compactCapabilities(parseCapabilities(CAPS_RPC), { tool: "forms__generate_form_draft" });
  assert.equal(out.tool.name, "forms__generate_form_draft");
  assert.deepEqual(out.tool.inputSchema.properties, { description: { type: "string" } });
  assert.deepEqual(out.lockedFaces.length, 1);
});

test("compactCapabilities：未知 tool 如实报错并给出可用名，不静默返回空", () => {
  const out = compactCapabilities(parseCapabilities(CAPS_RPC), { tool: "forms__nope" });
  assert.equal(out.error, "TOOL_NOT_FOUND");
  assert.deepEqual(out.available, ["forms__list_forms", "forms__generate_form_draft", "notify__send_message"]);
});

// ── platform_call：身份不接受模型参数 ─────────────────────────────────────────

test("buildPlatformCall：tool 必填；args 缺省为空对象", () => {
  assert.deepEqual(buildPlatformCall("not json"), { error: "TOOL_REQUIRED" });
  assert.deepEqual(buildPlatformCall({ tool: "  " }), { error: "TOOL_REQUIRED" });
  assert.deepEqual(buildPlatformCall({ tool: "forms__list_forms" }), { tool: "forms__list_forms", args: {} });
});

test("★ platform_call 不接受 userId：args 里的 userId 被剥掉（身份只来自 ctx + env）", () => {
  const out = buildPlatformCall({
    tool: "forms__generate_form_draft",
    args: { userId: "someone-else", requesterSenderId: "x", description: "d" },
  });
  assert.equal(out.args.userId, undefined);
  assert.equal(out.args.requesterSenderId, undefined);
  assert.equal(out.args.description, "d");
});

// ── index.js 静态契约（无法 import：依赖 openclaw SDK）────────────────────────

const indexSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");

test("index.js：CALL_DEF 参数只有 tool/args，没有 userId", () => {
  const m = indexSrc.match(/const CALL_DEF = \{[\s\S]*?\n\}/);
  assert.ok(m, "index.js 里找不到 CALL_DEF");
  const def = m[0];
  assert.match(def, /name: "platform_call"/);
  assert.match(def, /required: \["tool"\]/);
  assert.ok(!/userId/.test(def), "platform_call 的参数里不许出现 userId");
});

test("index.js：CAPS_DEF 参数只有 q/tool", () => {
  const m = indexSrc.match(/const CAPS_DEF = \{[\s\S]*?\n\}/);
  assert.ok(m, "index.js 里找不到 CAPS_DEF");
  const def = m[0];
  assert.match(def, /name: "platform_capabilities"/);
  assert.match(def, /q: \{ type: "string" \}/);
  assert.match(def, /tool: \{ type: "string" \}/);
  assert.ok(!/userId/.test(def));
});

test("index.js：两个 native 工具各自 registerTool，并复用 AGENT_API_BASE / DATA_WECOM_CHANNEL_KEY", () => {
  assert.ok(indexSrc.includes("api.registerTool("), "native 工具必须走 api.registerTool");
  assert.ok(indexSrc.includes("{ name: CAPS_DEF.name }"), "platform_capabilities 未注册");
  assert.ok(indexSrc.includes("{ name: CALL_DEF.name }"), "platform_call 未注册");
  assert.match(indexSrc, /AGENT_API_BASE/);
  assert.match(indexSrc, /agent__capabilities/);
  assert.match(indexSrc, /DATA_WECOM_CHANNEL_KEY/);
});
