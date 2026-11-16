// platform-tools.test.js — native 元工具 platform_capabilities / platform_call 的回归（#2360）。
// 钉五件事：
//   ① callGateway 的请求形状（URL/头/JSON-RPC body/超时信号）与 fail-closed（缺 key/userid 不发请求）；
//   ② toGatewayToolResult 产出 openclaw 真正读取的 `{content, details}`，且一切错误落
//      `details.status='error'`（顶层 isError 会被 openclaw 忽略）；
//   ③ 网关鉴权/协议错误给可操作文案（WECOM_USER_NOT_LINKED / CHANNEL_KEY_INVALID / USER_DISABLED /
//      CASDOOR_UNAVAILABLE / RPC_-32601 / 超时 / 不可达），不只透传裸码；
//   ④ platform_call **不接受 userId**：身份只来自 ctx + env，args 里的身份键与 notify namespace 被剥掉；
//   ⑤ 能力紧凑索引（默认不带 inputSchema；tool=<name> 才带全量 schema）与 lockedFaces 透传。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_AGENT_API_BASE,
  PLATFORM_ORIGIN,
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

test("请求形状：POST {apiBase}/mcp，带三身份头 + 超时信号，body 是 JSON-RPC", async () => {
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
  assert.ok(init.signal instanceof AbortSignal, "fetch 必须带超时信号，防工具长拖");
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

test("超时：AbortSignal 触发 ⇒ GATEWAY_TIMEOUT（不让工具长拖）", async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
  });
  const r = await callGateway({ ...GW, method: "tools/list", fetchImpl: hang, timeoutMs: 5 });
  assert.equal(r.error, "GATEWAY_TIMEOUT");
});

test("鉴权闸 HTTP 错误（非 JSON-RPC 信封）：归一成 {error, status}", async () => {
  const f = stubFetch({ error: "CHANNEL_KEY_INVALID" }, { status: 401 });
  const r = await callGateway({ ...GW, method: "tools/list", fetchImpl: f });
  assert.deepEqual(r, { error: "CHANNEL_KEY_INVALID", status: 401 });
});

// ── toGatewayToolResult：openclaw `{content, details}` 契约 ──────────────────

test("成功结果：content 原样，details 带业务载荷且 status=ok", () => {
  const content = [{ type: "text", text: JSON.stringify({ status: "ok", count: 2 }) }];
  const r = toGatewayToolResult({ result: { content, isError: false } });
  assert.deepEqual(r.content, content);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.count, 2);
  assert.equal("isError" in r, false, "顶层 isError 不被 openclaw 读取，不应作为契约字段");
});

test("工具级错误：details.status='error' 且保留 reason/scope（missing_scope 不再显示为成功）", () => {
  const r = toGatewayToolResult({
    result: {
      content: [{ type: "text", text: JSON.stringify({ status: "denied", reason: "missing_scope", scope: "data:manage" }) }],
      isError: true,
    },
  });
  assert.equal(r.details.status, "error");
  assert.equal(r.details.reason, "missing_scope");
  assert.equal(r.details.scope, "data:manage");
});

test("工具级错误：isError 但无 reason ⇒ 补 TOOL_ERROR（openclaw 有可判定理由）", () => {
  const r = toGatewayToolResult({ result: { content: [{ type: "text", text: '{"status":"error"}' }], isError: true } });
  assert.equal(r.details.status, "error");
  assert.equal(r.details.reason, "TOOL_ERROR");
});

test("structuredContent 优先作为 details 来源（业务载荷结构化时不再二次解析 text）", () => {
  const r = toGatewayToolResult({
    result: {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { status: "error", reason: "rate_limited" },
      isError: true,
    },
  });
  assert.equal(r.details.status, "error");
  assert.equal(r.details.reason, "rate_limited");
});

test("result 缺 content ⇒ 用 details 自身兜底，不产出空 content", () => {
  const r = toGatewayToolResult({ result: { tools: [] } });
  assert.equal(r.content.length, 1);
  assert.deepEqual(JSON.parse(r.content[0].text), r.details);
  assert.equal(r.details.status, "ok");
});

test("JSON-RPC error ⇒ details.status='error'，-32601 给下一步动作文案", () => {
  const r = toGatewayToolResult({ error: { code: -32601, message: "method not found" } });
  assert.equal(r.details.status, "error");
  assert.equal(r.details.reason, "RPC_-32601");
  assert.deepEqual(r.details.error, { code: -32601, message: "method not found" });
  assert.match(r.content[0].text, /platform_capabilities/);
});

test("JSON-RPC -32602（invalid params）⇒ 参数校正指引，不与「工具不存在」混文案", () => {
  const r = toGatewayToolResult({ error: { code: -32602, message: "invalid params" } });
  assert.equal(r.details.status, "error");
  assert.equal(r.details.reason, "RPC_-32602");
  assert.match(r.content[0].text, /参数不合法/);
  assert.match(r.content[0].text, /inputSchema/);
  assert.ok(!/不存在/.test(r.content[0].text));
});

test("本地 fail-closed 错误码给可操作中文文案（不是裸码）", () => {
  const missing = toGatewayToolResult({ error: "USERID_MISSING" });
  assert.equal(missing.details.status, "error");
  assert.equal(missing.details.reason, "USERID_MISSING");
  assert.match(missing.content[0].text, /身份/);
  const noKey = toGatewayToolResult({ error: "CHANNEL_KEY_MISSING" });
  assert.match(noKey.content[0].text, /渠道凭证/);
});

test("本地参数防御码：TOOL_REQUIRED / TOOL_NOT_CALLABLE 也走 details.status='error' + 指引", () => {
  const required = toGatewayToolResult({ error: "TOOL_REQUIRED" });
  assert.equal(required.details.status, "error");
  assert.equal(required.details.reason, "TOOL_REQUIRED");
  assert.match(required.content[0].text, /缺少 tool 参数/);
  assert.match(required.content[0].text, /platform_capabilities/);
  assert.ok(!required.content[0].text.includes('{"error"'));

  const meta = toGatewayToolResult({ error: "TOOL_NOT_CALLABLE" });
  assert.equal(meta.details.status, "error");
  assert.equal(meta.details.reason, "TOOL_NOT_CALLABLE");
  assert.match(meta.content[0].text, /不通过 platform_call 调用/);
  assert.match(meta.content[0].text, /直接调 platform_capabilities/);
});

test("网关鉴权/身份错误：可操作文案（扫码 / 凭证 / 停用 / 身份服务）", () => {
  const notLinked = toGatewayToolResult({ error: "WECOM_USER_NOT_LINKED", status: 401 });
  assert.equal(notLinked.details.status, "error");
  assert.match(notLinked.content[0].text, /扫码登录/);
  assert.ok(notLinked.content[0].text.includes(PLATFORM_ORIGIN), "复用同一份扫码指引（含平台入口）");

  const badKey = toGatewayToolResult({ error: "CHANNEL_KEY_INVALID", status: 401 });
  assert.match(badKey.content[0].text, /CHANNEL_KEY_INVALID/);
  assert.match(badKey.content[0].text, /渠道认证失败/);

  assert.match(toGatewayToolResult({ error: "USER_DISABLED", status: 401 }).content[0].text, /账号已停用/);
  assert.match(toGatewayToolResult({ error: "CASDOOR_UNAVAILABLE", status: 503 }).content[0].text, /身份服务暂不可用/);
});

test("传输错误文案带排障上下文（不可达带 detail、坏回包带 HTTP status）", () => {
  const down = toGatewayToolResult({ error: "GATEWAY_UNREACHABLE", detail: "ECONNREFUSED" });
  assert.match(down.content[0].text, /ECONNREFUSED/);
  const junk = toGatewayToolResult({ error: "GATEWAY_BAD_RESPONSE", status: 502 });
  assert.match(junk.content[0].text, /HTTP 502/);
  assert.match(toGatewayToolResult({ error: "GATEWAY_TIMEOUT" }).content[0].text, /超时/);
});

test("未知错误码：保留裸码但包成 {status:'error', reason}，不丢信息", () => {
  const r = toGatewayToolResult({ error: "WEIRD_CODE" });
  assert.deepEqual(JSON.parse(r.content[0].text), { status: "error", reason: "WEIRD_CODE" });
  assert.equal(r.details.reason, "WEIRD_CODE");
});

// ── 能力紧凑索引 ──────────────────────────────────────────────────────────────

// 真实形状（网关 apps/server/src/routes/agent-mcp.ts §7.5）：
//   · notify/forms 的 tools/list 条目只有 {name, description, inputSchema, annotations}——
//     **没有**顶层 mutating/requiredScope（那两个在模块 catalog 里）；
//   · 网关发现缺这两个字段时补 `catalogNote`，再补 module/face；
//   · `agent__capabilities` 是内置发现入口，**不在** capabilities 的 tools 数组里。
const CATALOG_NOTE = "mutating/requiredScope 见模块 catalog";
const CAPS_PAYLOAD = {
  faces: [
    { module: "forms", face: "manage", group: "forms", audience: "wecom", scope: "forms:manage", available: true },
    { module: "data", face: "manage", group: "data", audience: "wecom", scope: "data:manage", available: false },
  ],
  tools: [
    {
      name: "forms__list_forms", description: "列出本租户可查看的表单（摘要）。",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true }, module: "forms", face: "manage", catalogNote: CATALOG_NOTE,
    },
    {
      name: "forms__generate_form_draft",
      description: "用自然语言描述业务场景，生成表单契约并落为草稿。\n第二行不该进索引。",
      inputSchema: { type: "object", properties: { description: { type: "string" } } },
      annotations: { readOnlyHint: false }, module: "forms", face: "manage", catalogNote: CATALOG_NOTE,
    },
    {
      name: "notify__send_message", description: "发一条通知。",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false }, module: "notify", face: "manage", catalogNote: CATALOG_NOTE,
    },
  ],
  lockedFaces: [{ module: "data", face: "manage", scope: "data:manage" }],
  notes: ["forms:publish 必须人做"],
};
const CAPS_RPC = {
  result: { content: [{ type: "text", text: JSON.stringify(CAPS_PAYLOAD) }], isError: false },
};

test("parseCapabilities：从 content[0].text 解出目录；垃圾回包返回 null", () => {
  const payload = parseCapabilities(CAPS_RPC);
  assert.equal(payload.tools.length, 3);
  // fixture 与真实网关负载一致：没有顶层 mutating/requiredScope，只有 annotations + catalogNote。
  for (const t of payload.tools) {
    assert.equal("mutating" in t, false, `${t.name} 不应带顶层 mutating（真实 tools/list 没有）`);
    assert.equal("requiredScope" in t, false, `${t.name} 不应带顶层 requiredScope`);
    assert.equal(t.catalogNote, CATALOG_NOTE);
  }
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
  assert.equal(out.tools.find((t) => t.name === "notify__send_message").mutating, true);
  assert.deepEqual(out.lockedFaces, [{ module: "data", face: "manage", scope: "data:manage" }]);
  assert.deepEqual(out.notes, ["forms:publish 必须人做"]);
  assert.deepEqual(out.faces, [
    { module: "forms", face: "manage", scope: "forms:manage", available: true },
    { module: "data", face: "manage", scope: "data:manage", available: false },
  ]);
});

test("compactCapabilities：元工具 agent__capabilities 即使混进 tools 也不进索引", () => {
  const out = compactCapabilities({
    tools: [
      { name: "agent__capabilities", description: "元工具" },
      { name: "forms__list_forms", description: "列表单" },
    ],
  });
  assert.deepEqual(out.tools.map((t) => t.name), ["forms__list_forms"]);
});

test("compactCapabilities：工具缺 mutating 时仍从 annotations.readOnlyHint 推导（前向兼容）", () => {
  const out = compactCapabilities({
    tools: [
      { name: "x__read", description: "", annotations: { readOnlyHint: true } },
      { name: "x__write", description: "", annotations: { readOnlyHint: false } },
      { name: "x__unknown", description: "" },
    ],
  });
  assert.equal(out.tools.find((t) => t.name === "x__read").mutating, false);
  assert.equal(out.tools.find((t) => t.name === "x__write").mutating, true);
  assert.equal("mutating" in out.tools.find((t) => t.name === "x__unknown"), false);
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

test("buildPlatformCall：notify 的 namespace 被剥掉（C 档服务端钉死），非 notify 的同名参数不动", () => {
  const notify = buildPlatformCall({ tool: "notify__create_agent_rule", args: { namespace: "evil_ns", eventKey: "e" } });
  assert.equal(notify.args.namespace, undefined);
  assert.equal(notify.args.eventKey, "e");
  const other = buildPlatformCall({ tool: "data__create_metric", args: { namespace: "kept" } });
  assert.equal(other.args.namespace, "kept");
});

test("buildPlatformCall：元工具 agent__capabilities 不经 platform_call 调", () => {
  assert.deepEqual(buildPlatformCall({ tool: "agent__capabilities" }), { error: "TOOL_NOT_CALLABLE" });
});

// ── index.js 静态契约（无法 import：依赖 openclaw SDK）────────────────────────

const indexSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");

/** 按花括号深度截出一个顶层 DEF 字面量（`[\s\S]*?\n}` 遇到嵌套对象会提前截断）。 */
function defBlock(name) {
  const marker = `const ${name} = `;
  const start = indexSrc.indexOf(marker);
  assert.notEqual(start, -1, `index.js 里找不到 ${name}`);
  let depth = 0;
  for (let i = start + marker.length; i < indexSrc.length; i += 1) {
    if (indexSrc[i] === "{") depth += 1;
    else if (indexSrc[i] === "}" && --depth === 0) return indexSrc.slice(start, i + 1);
  }
  assert.fail(`${name} 字面量未闭合`);
}

test("index.js：CALL_DEF 参数只有 tool/args，没有 userId", () => {
  const def = defBlock("CALL_DEF");
  assert.match(def, /name: "platform_call"/);
  assert.match(def, /required: \["tool"\]/);
  assert.ok(!/userId/.test(def), "platform_call 的参数里不许出现 userId");
});

test("index.js：CAPS_DEF 参数只有 q/tool", () => {
  const def = defBlock("CAPS_DEF");
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
  // 工具 ctx 的取消信号应透传给网关请求（否则断开后网关调用继续跑）。
  assert.equal((indexSrc.match(/signal,\n/g) ?? []).length >= 2, true, "两个 native 工具都应透传 signal");
});
