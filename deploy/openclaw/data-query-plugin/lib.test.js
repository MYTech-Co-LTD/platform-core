import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callPlatform, normalizeParams, toToolResult } from "./lib.js";

test("normalizeParams：对象直传", () => {
  assert.deepEqual(normalizeParams({ metricId: "m1" }), { metricId: "m1" });
});
test("normalizeParams：JSON 字符串", () => {
  assert.deepEqual(normalizeParams('{"metricId":"m1"}'), { metricId: "m1" });
});
test("normalizeParams：单键包裹层剥开", () => {
  assert.deepEqual(normalizeParams({ input: { metricId: "m1" } }), { metricId: "m1" });
  assert.deepEqual(normalizeParams({ arguments: { metricId: "m1" } }), { metricId: "m1" });
});
test("normalizeParams：垃圾输入回空对象", () => {
  assert.deepEqual(normalizeParams("not json"), {});
  assert.deepEqual(normalizeParams(null), {});
  assert.deepEqual(normalizeParams([1, 2]), {});
});

function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status < 400, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const BASE = { apiBase: "http://x/api", channelKey: "k", userId: "u1", path: "/query" };

test("缺渠道凭证：不发请求直接报错", async () => {
  const f = stubFetch(200, {});
  const r = await callPlatform({ ...BASE, fetchImpl: f, channelKey: "" });
  assert.match(r.error, /渠道凭证/);
  assert.equal(f.calls.length, 0);
});
test("缺 userid：fail-closed 不发请求", async () => {
  const f = stubFetch(200, {});
  const r = await callPlatform({ ...BASE, fetchImpl: f, userId: "" });
  assert.match(r.error, /身份/);
  assert.equal(f.calls.length, 0);
});
test("请求头带 x-channel-key 与 x-wecom-userid", async () => {
  const f = stubFetch(200, { metrics: [] });
  await callPlatform({ ...BASE, fetchImpl: f, path: "/metrics" });
  assert.equal(f.calls[0].init.headers["x-channel-key"], "k");
  assert.equal(f.calls[0].init.headers["x-wecom-userid"], "u1");
  assert.equal(f.calls[0].init.method, "GET");
});
test("401 WECOM_USER_NOT_LINKED → 扫码指引", async () => {
  const f = stubFetch(401, { error: "WECOM_USER_NOT_LINKED" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.code, "WECOM_USER_NOT_LINKED");
  assert.match(r.error, /扫码登录/);
});
test("403 → 文案指回 list_metrics", async () => {
  const f = stubFetch(403, { status: "denied" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.match(r.error, /list_metrics/);
});
test("403 bad_param → 参数文案原样带 detail，不是权限文案（形状错不该被读成没权限）", async () => {
  // /query 对一切 denied 回 403（#30 订正），body 带 reason/detail——bad_param 必须如实回参数错。
  const f = stubFetch(403, { status: "denied", metricId: "m1", reason: "bad_param", detail: "invalid_value:bizday" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.code, "BAD_PARAM");
  assert.match(r.error, /参数不合法/);
  assert.match(r.error, /invalid_value:bizday/);
  assert.match(r.error, /params 为准/);
  assert.doesNotMatch(r.error, /可见范围/);
});
test("403 bad_param 缺 detail → 仍回参数文案（带兜底说明，不吞成权限错）", async () => {
  const f = stubFetch(403, { status: "denied", reason: "bad_param" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.code, "BAD_PARAM");
  assert.match(r.error, /参数不合法/);
  assert.match(r.error, /params 为准/);
});
test("502 → 仓库侧文案", async () => {
  const f = stubFetch(502, { error: "warehouse_transient" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.match(r.error, /仓库/);
});
test("200 → ok 回包原样透传（含 subject）", async () => {
  const f = stubFetch(200, { status: "ok", subject: "shanhaiyiguo-org", columns: ["d"], rows: [[1]] });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.status, "ok");
  assert.equal(r.subject, "shanhaiyiguo-org");
});
test("200 total 合计回包原样透传（total 字段=合计值，spec §8.4）", async () => {
  // lib.js 对 2xx 不做形状改写 ⇒ 服务端的 total 值字段自然带出——这里锁住该事实。
  // total 已不是 #699 的布尔标记（同日契约变更）：值与 rows 同源（numeric 经 node-pg 常为字符串）。
  const f = stubFetch(200, { status: "ok", subject: "o", columns: ["total"], rows: [[1470.5]], truncated: false, total: "1470.5" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.total, "1470.5");
  assert.deepEqual(r.rows, [[1470.5]]);
  assert.equal(r.truncated, false);
});

// OpenClaw 工具结果契约（api.registerTool）：execute 必须返回 { content:[{type:"text",text}], details }。
// 2026-10-12 真机事故：返回纯对象被判 invalid（path ["details","result","content"] expected "array"），
// list_metrics 每轮连败、模型拿不到词表。这几条锁住该形状 —— 形状就是判据。
test("toToolResult：对象 → content[]（type=text, text=JSON）+ details 保留原载荷", () => {
  const r = toToolResult({ status: "ok", subject: "org1" });
  assert.deepEqual(r.content, [{ type: "text", text: '{"status":"ok","subject":"org1"}' }]);
  assert.deepEqual(r.details, { status: "ok", subject: "org1" });
});
test("toToolResult：字符串直接作为 text", () => {
  const r = toToolResult("hi");
  assert.deepEqual(r.content, [{ type: "text", text: "hi" }]);
  assert.equal(r.details, "hi");
});
test("toToolResult：content 恒为数组（回归锁，防再退回纯对象）", () => {
  for (const p of [{ a: 1 }, { code: "DENIED", error: "x" }, null, "s"]) {
    const r = toToolResult(p);
    assert.ok(Array.isArray(r.content), "content 必须是数组");
    assert.equal(r.content[0].type, "text");
    assert.equal(typeof r.content[0].text, "string");
  }
});

// query_data 工具描述 = 模型可见的调用契约（与 agent-loop T1 同一性质：文案就是契约）。
// index.js import openclaw SDK（peer dep，本机未装）⇒ 只能以源文本断言锁文案。
test("query_data 工具描述含 total 自动合计规则（spec §8.4：直接引用 total，勿自己加总）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  // 关键规则下沉（spec §8.4：SKILL 正文对 flash 级模型是弱引导，规则必须在工具描述里）
  assert.match(src, /total 字段/);
  assert.match(src, /不要自己把明细行加总/);
  assert.match(src, /不要跨行求和/);
  // 显式「只要总数」形态保留
  assert.match(src, /args\.total=true/);
  // 旧布尔标记契约文案不再出现（total 字段语义已改为值）
  assert.doesNotMatch(src, /明细与合计互斥/);
});

// 汇报纪律（spec §10.4）：data_as_of 必带 / 缺席=未知如实说 / 首行即最新 / 当日部分天。
// 同一性质：文案就是契约，源文本断言。
test("query_data 工具描述含新鲜度汇报纪律（spec §10.4）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /data_as_of/);
  assert.match(src, /数据截止/);
  assert.match(src, /新鲜度未知/);
  assert.match(src, /部分天/);
  // data_as_of 已是北京时间（UTC+8，spec §10.6）——模型直接引用，不要再自行换算
  assert.match(src, /北京时间/);
  assert.match(src, /UTC\+8/);
});

// SKILL 正文句级微调（不重写）：方法论 v2 的行数预算/total 规则原样，仅补新鲜度汇报纪律一条。
test("data-query SKILL.md 含新鲜度汇报纪律且既有判据句原样（spec §10.4）", () => {
  const skill = readFileSync(new URL("./skills/data-query/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /data_as_of/);
  assert.match(skill, /新鲜度未知/);
  assert.match(skill, /部分天/);
  // data_as_of 已是北京时间（UTC+8，spec §10.6）
  assert.match(skill, /北京时间/);
  assert.match(skill, /UTC\+8/);
  // 既有判据句不许丢（句级微调，不是重写）
  assert.match(skill, /truncated:true/);
  assert.match(skill, /BAD_PARAM/);
  assert.match(skill, /区间超过 4 天必用/);
});
