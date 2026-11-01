// lib.test.js — 纯逻辑单测。lib.js 不 import SDK，node --test 直跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DENIED_MESSAGE, NO_IDENTITY_MESSAGE,
  parseAllowedUsers, isAllowed, resolveSecret, credentialsReady, mapError,
  createTokenManager, callWecom, normalizeParams, toToolResult,
} from "./lib.js";

test("parseAllowedUsers：逗号分隔、去空白、去重、过滤空串", () => {
  assert.deepEqual(parseAllowedUsers("ZhangDuo, yangwei,,ZhangDuo"), ["ZhangDuo", "yangwei"]);
  assert.deepEqual(parseAllowedUsers(undefined), []);
  assert.deepEqual(parseAllowedUsers(""), []);
});

test("isAllowed：fail-closed——空 sender、空名单、未命中都拒", () => {
  const users = ["ZhangDuo", "yangwei"];
  assert.equal(isAllowed(users, "ZhangDuo"), true);
  assert.equal(isAllowed(users, "yangwei"), true);
  assert.equal(isAllowed(users, "DongJiJuan"), false);
  assert.equal(isAllowed(users, ""), false);
  assert.equal(isAllowed(users, undefined), false);
  assert.equal(isAllowed([], "ZhangDuo"), false);
});

test("resolveSecret：直给优先，其次 SECRET_FROM 指名，再无则空", () => {
  assert.deepEqual(resolveSecret({ WECOM_APP_SECRET: "s1" }), { secret: "s1", source: "WECOM_APP_SECRET" });
  assert.deepEqual(
    resolveSecret({ WECOM_APP_SECRET_FROM: "X", X: "s2" }),
    { secret: "s2", source: "X" },
  );
  assert.deepEqual(resolveSecret({ WECOM_APP_SECRET_FROM: "X" }), { secret: "", source: "" });
});

test("credentialsReady：corpId + secret 缺一即 false", () => {
  assert.equal(credentialsReady({ WECOM_APP_CORP_ID: "ww", WECOM_APP_SECRET: "s" }), true);
  assert.equal(credentialsReady({ WECOM_APP_CORP_ID: "ww", WECOM_APP_SECRET_FROM: "X", X: "s" }), true);
  assert.equal(credentialsReady({ WECOM_APP_CORP_ID: "ww" }), false);
});

test("mapError：固定文案表 + 参数类错误带 detail", () => {
  assert.match(mapError(48002, "api forbidden"), /未对企业应用开放/);
  assert.match(mapError(60020, "not allow to access from your ip"), /可信 ?IP/);
  assert.match(mapError(301002, "not allow operate another agent"), /凭据与应用不匹配/);
  assert.match(mapError(301085, "invalid docid"), /未对应用可见/);
  assert.match(mapError(2022004, "field not exists, hint: [x]"), /字段标题不存在/);
  assert.match(mapError(90457, "invalid calendar id, hint: [x]"), /应用自建日历/);
  assert.match(mapError(40058, "invalid Request Parameter, hint: [x]"), /参数形状不合法.*自纠一次/);
  assert.match(mapError(93017, "wrong json format"), /参数形状不合法/);
  assert.match(mapError(99999, "whatever, hint: [x]"), /99999/);
});

test("tokenManager：缓存复用（未到期不二次 gettoken）", async () => {
  let n = 0;
  const fakeFetch = async () => { n++; return { status: 200, json: async () => ({ errcode: 0, access_token: "T" + n, expires_in: 7200 }) }; };
  let t = 0;
  const tm = createTokenManager({ corpId: "ww", secret: "s", fetchImpl: fakeFetch, now: () => t });
  assert.equal(await tm.get(), "T1");
  assert.equal(await tm.get(), "T1"); // 命中缓存
  assert.equal(n, 1);
  t = (7200 - 300) * 1000 + 1; // 越过提前刷新线
  assert.equal(await tm.get(), "T2");
  assert.equal(n, 2);
});

test("tokenManager：并发单飞（同时 get 只发一次 gettoken）", async () => {
  let n = 0; let release;
  const gate = new Promise((r) => (release = r));
  const fakeFetch = async () => { n++; await gate; return { status: 200, json: async () => ({ errcode: 0, access_token: "T", expires_in: 7200 }) }; };
  const tm = createTokenManager({ corpId: "ww", secret: "s", fetchImpl: fakeFetch, now: () => 0 });
  const p1 = tm.get();
  const p2 = tm.get(); // 并发第二次：必须复用同一 inflight
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, "T"); assert.equal(b, "T"); assert.equal(n, 1);
});

test("tokenManager：gettoken 失败抛错带 errcode", async () => {
  const fakeFetch = async () => ({ status: 200, json: async () => ({ errcode: 40001, errmsg: "invalid credential" }) });
  const tm = createTokenManager({ corpId: "ww", secret: "bad", fetchImpl: fakeFetch, now: () => 0 });
  await assert.rejects(() => tm.get(), (e) => e.errcode === 40001 && /invalid credential/.test(e.message));
});

function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status, ok: status < 400, json: async () => body }; };
  fn.calls = calls;
  return fn;
}

test("callWecom：errcode 0 原样回业务载荷（含顶层 sheet_list）", async () => {
  const f = stubFetch(200, { errcode: 0, errmsg: "ok", sheet_list: [{ sheet_id: "q979lj" }] });
  const out = await callWecom({ token: "T", path: "wedoc/smartsheet/get_sheet", body: { docid: "d" }, fetchImpl: f });
  assert.deepEqual(out.sheet_list, [{ sheet_id: "q979lj" }]);
  assert.ok(f.calls[0].url.includes("access_token=T"));
});

test("callWecom：非零 errcode → {errcode, error:mapError}", async () => {
  const f = stubFetch(200, { errcode: 2022004, errmsg: "field not exists, hint: [x]" });
  const out = await callWecom({ token: "T", path: "wedoc/smartsheet/add_records", body: {}, fetchImpl: f });
  assert.equal(out.errcode, 2022004);
  assert.match(out.error, /字段标题不存在/);
});

test("callWecom：404 端点漂移与网络错误都有文案", async () => {
  const f404 = async () => ({ status: 404, json: async () => ({}) });
  assert.match((await callWecom({ token: "T", path: "oa/calendar/list", fetchImpl: f404 })).error, /端点不存在/);
  const fNet = async () => { throw new Error("boom"); };
  assert.match((await callWecom({ token: "T", path: "x", fetchImpl: fNet })).error, /不可达/);
});

test("normalizeParams / toToolResult：形状与 data-query 同律", () => {
  assert.deepEqual(normalizeParams('{"a":1}'), { a: 1 });
  assert.deepEqual(normalizeParams({ input: { a: 1 } }), { a: 1 });
  assert.deepEqual(normalizeParams("junk"), {});
  const r = toToolResult({ x: 1 });
  assert.equal(r.content[0].type, "text");
  assert.equal(JSON.parse(r.content[0].text).x, 1);
  assert.deepEqual(r.details, { x: 1 });
});

test("拒绝文案常量在（index.js 引用，防改名漂移）", () => {
  assert.match(DENIED_MESSAGE, /使用权限/);
  assert.match(NO_IDENTITY_MESSAGE, /requesterSenderId/);
});

test("callWecom：非 2xx/非 JSON 显式报错——502 与 200 非 JSON 都不再静默成功", async () => {
  const f502 = async () => ({ status: 502, ok: false, json: async () => { throw new Error("x"); } });
  const out502 = await callWecom({ token: "T", path: "wedoc/smartsheet/get_sheet", fetchImpl: f502 });
  assert.match(out502.error, /无法解析/);
  assert.match(out502.error, /502/);
  const f200bad = async () => ({ status: 200, ok: true, json: async () => { throw new Error("x"); } });
  assert.match((await callWecom({ token: "T", path: "x", fetchImpl: f200bad })).error, /无法解析/);
});

test("callWecom：非 2xx 解析成功但无 errcode → 异常响应文案（HTTP 状态不被吞）", async () => {
  const f503 = async () => ({ status: 503, ok: false, json: async () => ({}) });
  const out = await callWecom({ token: "T", path: "x", fetchImpl: f503 });
  assert.match(out.error, /异常响应/);
  assert.match(out.error, /503/);
});

test("callWecom：HTTP 400 带 errcode 仍走 mapError（status 不遮蔽 errcode 语义）", async () => {
  const f400 = async () => ({ status: 400, ok: false, json: async () => ({ errcode: 40058, errmsg: "invalid Request Parameter, hint: [x]" }) });
  const out = await callWecom({ token: "T", path: "x", fetchImpl: f400 });
  assert.equal(out.errcode, 40058);
  assert.match(out.error, /参数形状不合法/);
});
