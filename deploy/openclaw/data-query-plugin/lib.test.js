import { test } from "node:test";
import assert from "node:assert/strict";
import { callPlatform, normalizeParams } from "./lib.js";

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
