import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  callPlatform,
  normalizeParams,
  toToolResult,
  FRESHNESS_TTL_MS,
  FRESHNESS_GLOBAL_SLOT,
  createFreshnessStore,
  freshnessStore,
  stripFreshnessLines,
  appendFreshnessLine,
  makeFreshnessSendingHook,
  makeFreshnessInboundHook,
} from "./lib.js";

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
test("403 no_detail_binding ⇒ 能力陈述文案（不当权限拒绝说）", async () => {
  // 服务端（drill.ts）对未声明下钻的指标回 403 + reason:no_detail_binding——是「能力边界」
  // 不是「没权限」：照搬 DENIED 文案会让模型换指标试探（实际该指标永远下钻不了）。
  const f = stubFetch(403, { status: "denied", metricId: "m1", reason: "no_detail_binding" });
  const r = await callPlatform({ ...BASE, fetchImpl: f, path: "/query/detail", method: "POST", body: { metricId: "m1", args: {} } });
  assert.equal(r.code, "NO_DETAIL_BINDING");
  assert.match(r.error, /不支持.*下钻|能力/);
  assert.doesNotMatch(r.error, /不在你的可见范围/); // 与 DENIED 文案严格分家
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

// 汇报纪律（spec §10.7.4，2026-10-16 改版）：新鲜度行改**系统自动附加**（message_sending 钩子
// strip+append），模型只管不自己写 📅 行；data_as_of/首行最新/当日部分天仍是模型责任。
// 同一性质：文案就是契约，源文本断言。
test("query_data 工具描述改为系统自动附加口径（模型不写 📅 行；data_as_of 句保留）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  // 新契约：系统自动附加，模型无需复述/不需要自己拼新鲜度行
  assert.match(src, /新鲜度与口径射程由系统自动附加/);
  assert.match(src, /不要自己写任何 📅 \/ 📐 行/);
  assert.match(src, /不要复述或拼接 freshness_line \/ scope_line/);
  // 旧「模型自附」契约文案不许残留（两套口径并存会让 flash 级模型无所适从）
  assert.doesNotMatch(src, /答案末尾必须原样单独一行附/);
  // data_as_of 句保留（spec §10.7.4）
  assert.match(src, /data_as_of/);
  assert.match(src, /数据截止/);
  assert.match(src, /新鲜度未知/);
  assert.match(src, /部分天/);
  // data_as_of 已是北京时间（UTC+8，spec §10.6）——模型直接引用，不要再自行换算
  assert.match(src, /北京时间/);
  assert.match(src, /UTC\+8/);
});

// SKILL 正文句级改版（不重写）：方法论 v2 的行数预算/total 规则原样，新鲜度条改为系统附加口径。
test("data-query SKILL.md 新鲜度条改系统附加口径且既有判据句原样（spec §10.7.4）", () => {
  const skill = readFileSync(new URL("./skills/data-query/SKILL.md", import.meta.url), "utf8");
  // 新契约：系统自动附加，模型不写 📅 行、不复述数据更新时间
  assert.match(skill, /新鲜度声明由系统自动附加/);
  assert.match(skill, /不要自己写任何 📅 行/);
  assert.match(skill, /不要复述数据更新时间/);
  assert.doesNotMatch(skill, /原样\*\*附回包的/);
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

// query_detail（明细下钻，2026-10-21 spec §2.6）：第四把工具。同一性质——文案就是契约，
// SDK 装不上 ⇒ 源文本断言锁 flash 口径的行为规则。
test("query_detail 工具注册：path/method、bizday 必传、rowCountTotal 权威、no_detail_binding 不重试、双时钟转述、scope 捕获", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  // 注册形状：path/method 与平台 HTTP 面一致（routes/query-detail.ts POST /query/detail）
  assert.match(src, /name: "query_detail"/);
  assert.match(src, /path: "\/query\/detail"/);
  assert.match(src, /method: "POST"/);
  // flash 口径行为规则（brief 逐条）：bizday 必传（防全史扫湖）；行数以 rowCountTotal 为权威；
  // 能力边界如实告知不重试；两个时钟与口径行原样转述
  assert.match(src, /bizday 必传/);
  assert.match(src, /rowCountTotal/);
  assert.match(src, /不要拿返回行数当全量/);
  assert.match(src, /no_detail_binding/);
  assert.match(src, /不要重试/);
  assert.match(src, /clock_note/);
  assert.match(src, /scope_line/);
  assert.match(src, /原样转述/);
  // 口径行捕获：scope_line 在场才 capture（缺省不捕）——partial 入参 { scope } 合法
  assert.match(src, /capture\(sessionKey, \{ scope \}, runId\)/);
});

// SKILL 明细下钻节（2026-10-21 spec §2.6）：模型侧指引与工具描述同一套口径。
test("data-query SKILL.md 明细下钻节：何时用 / bizday 必传 / rowCountTotal 权威 / 能力话术 / 双时钟", () => {
  const skill = readFileSync(new URL("./skills/data-query/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /query_detail/);
  assert.match(skill, /明细下钻/);
  assert.match(skill, /rowCountTotal/);
  assert.match(skill, /bizday/);
  assert.match(skill, /能力边界/);
  assert.match(skill, /不要重试/);
});

// ── 新鲜度行确定性附加（message_sending 钩子纯逻辑，2026-10-16）──────────────────
// 背景：模型自附 freshness_line 不稳（flash 合同弱：时有时无、混进正文）⇒ 传输层 strip+append。
const LINE_A = "📅 数据已更新至 10月15日（昨日）｜更新于 07:32";
const LINE_B = "📅 数据更新停在 10月13日，比平时慢了，还在处理中";
const LINE_C = "📅 数据更新情况未知";

test("stripFreshnessLines：独立成行的三个服务端变体全剥（更新至/停在/未知）", () => {
  for (const line of [LINE_A, LINE_B, LINE_C]) {
    const out = stripFreshnessLines(`正文第一行\n${line}\n正文第二行`);
    assert.equal(out, "正文第一行\n正文第二行");
  }
});
test("stripFreshnessLines：混进句中的 📅 行也剥掉（按 spec 截到行尾），其余行不动", () => {
  // 剥离模式即任务 spec 的 `📅 …[^\n]*`：句中出现的行截到**行尾**——后面的尾巴一并牺牲
  // （去重优先于保尾；独立成行的正常路径不受影响）。
  const out = stripFreshnessLines(`结论如下（${LINE_A}`);
  assert.equal(out, "结论如下（");
  const out2 = stripFreshnessLines(`第一行\n说明 ${LINE_A}\n第三行`);
  assert.equal(out2, "第一行\n说明 \n第三行");
});
test("stripFreshnessLines：无 📅 行时原样返回（不碰正文）", () => {
  const body = "第一行\n\n第三行带 📊 表格\n";
  assert.equal(stripFreshnessLines(body), body);
});
test("stripFreshnessLines：非字符串原样返回", () => {
  assert.equal(stripFreshnessLines(undefined), undefined);
  assert.equal(stripFreshnessLines(null), null);
  assert.equal(stripFreshnessLines(42), 42);
});

test("appendFreshnessLine：模型把 📅 行混在正文中间 → 剥掉后正典行钉在末尾（恰一行）", () => {
  const body = `销售额如下：\n\n| 日 | 金额 |\n|---|---|\n| 10-15 | 1470 |\n\n${LINE_A}\n以上就是结果`;
  const out = appendFreshnessLine(body, LINE_B);
  assert.equal(out, `销售额如下：\n\n| 日 | 金额 |\n|---|---|\n| 10-15 | 1470 |\n\n以上就是结果\n\n${LINE_B}`);
  assert.equal(out.split("📅").length - 1, 1, "全篇恰一个 📅");
  assert.ok(out.endsWith(LINE_B), "正典行必须是最后一行");
});
test("appendFreshnessLine：模型已把行附在末尾 → 仍是恰一行（strip-then-append 去重）", () => {
  const body = `结论：涨了\n\n${LINE_A}`;
  const out = appendFreshnessLine(body, LINE_A);
  assert.equal(out, `结论：涨了\n\n${LINE_A}`);
  assert.equal(out.split("📅").length - 1, 1);
});
test("appendFreshnessLine：尾部空行先收掉，正典行前恰一个空行分隔", () => {
  const out = appendFreshnessLine("结论：涨了\n\n\n", LINE_A);
  assert.equal(out, "结论：涨了\n\n" + LINE_A);
});
test("appendFreshnessLine：正文剥空 → 只回正典行本身（不带前导空行）", () => {
  const out = appendFreshnessLine(`${LINE_A}\n`, LINE_B);
  assert.equal(out, LINE_B);
});
test("appendFreshnessLine：line 非法（空/非串）→ content 原样返回", () => {
  assert.equal(appendFreshnessLine("正文", ""), "正文");
  assert.equal(appendFreshnessLine("正文", undefined), "正文");
  assert.equal(appendFreshnessLine("正文", 42), "正文");
});
test("appendFreshnessLine：content 非字符串 → 原样返回", () => {
  assert.equal(appendFreshnessLine(undefined, LINE_A), undefined);
  assert.equal(appendFreshnessLine(7, LINE_A), 7);
});

test("FRESHNESS_TTL_MS = 10 分钟", () => {
  assert.equal(FRESHNESS_TTL_MS, 10 * 60 * 1000);
});

function makeStore(nowRef) {
  return createFreshnessStore({ now: () => nowRef.t });
}

test("store：捕获后可取，同会话后查覆盖前查（取最新）", () => {
  const nowRef = { t: 1_000 };
  const store = makeStore(nowRef);
  store.capture("s1", LINE_A);
  nowRef.t = 2_000;
  store.capture("s1", LINE_B);
  assert.deepEqual(store.take("s1"), { line: LINE_B, runId: "", at: 2_000, sessionKey: "s1" });
});
test("store：捕获带 runId（第三参），缺省存空串", () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A, "run-1");
  store.capture("s2", LINE_B);
  assert.equal(store.take("s1").runId, "run-1");
  assert.equal(store.take("s2").runId, "");
});
test("store：TTL 内可取，超时读时丢弃（不再返回）", () => {
  const nowRef = { t: 1_000 };
  const store = makeStore(nowRef);
  store.capture("s1", LINE_A);
  nowRef.t = 1_000 + FRESHNESS_TTL_MS;
  assert.ok(store.take("s1"), "恰好到 TTL 边界仍可用");
  nowRef.t = 1_000 + FRESHNESS_TTL_MS + 1;
  assert.equal(store.take("s1"), undefined, "超时 1ms 即过期");
  assert.equal(store.size(), 0, "过期顺手清槽");
});
test("store：会话隔离——两把 sessionKey 不互通；缺键落全局槽", () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A);
  store.capture("s2", LINE_B);
  assert.equal(store.take("s1").line, LINE_A);
  assert.equal(store.take("s2").line, LINE_B);
  store.capture("", LINE_C);
  assert.equal(store.take(FRESHNESS_GLOBAL_SLOT).line, LINE_C);
  assert.equal(store.take(undefined).line, LINE_C);
  assert.equal(store.take("s3"), undefined, "没捕获过的会话取不到");
});
test("生产单例存在（工具路径与钩子共用同一份）", () => {
  assert.equal(typeof freshnessStore.capture, "function");
  assert.equal(typeof freshnessStore.take, "function");
});

// ★ 返回形状硬契约（一手来源 deliver-hooks.ts applyMessageSendingHook 读 `sendingResult.content`）：
//   改写 ⇒ 对象 `{ content }`；不改写 ⇒ undefined。裸字符串会被读成「未改写」⇒ 行永不附上。
test("钩子：有捕获 → 返回对象 { content }（剥旧钉新、恰一行、在末尾、等于正典行）", async () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_B);
  const hook = makeFreshnessSendingHook(store);
  const out = await hook(
    { content: `结论如下\n\n${LINE_A}（模型自附）` },
    { sessionKey: "s1" },
  );
  assert.equal(typeof out, "object");
  assert.ok(out !== null && !Array.isArray(out), "必须是对象，不是字符串/数组");
  assert.equal(typeof out.content, "string");
  assert.equal(out.content, `结论如下\n\n${LINE_B}`);
  assert.equal(out.content.split("📅").length - 1, 1);
  // 不是裸字符串（回归锁：裸串会被主机读成 undefined.content ⇒ 判未改写）
  assert.notEqual(typeof out, "string");
});
test("钩子：无捕获 → 返回 undefined（= 不改，外发原文放行；不是对象也不是字符串）", async () => {
  const hook = makeFreshnessSendingHook(makeStore({ t: 0 }));
  const out = await hook({ content: "普通回复" }, { sessionKey: "s9" });
  assert.equal(out, undefined);
  assert.notEqual(typeof out, "object");
  assert.notEqual(typeof out, "string");
});
test("钩子：捕获已过 TTL → undefined（不附旧行）", async () => {
  const nowRef = { t: 0 };
  const store = makeStore(nowRef);
  store.capture("s1", LINE_A);
  nowRef.t = FRESHNESS_TTL_MS + 1;
  const hook = makeFreshnessSendingHook(store);
  assert.equal(await hook({ content: "结论" }, { sessionKey: "s1" }), undefined);
});
test("钩子：会话隔离——s1 的捕获不污染 s2 的外发", async () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A);
  const hook = makeFreshnessSendingHook(store);
  assert.equal(await hook({ content: "s2 的回复" }, { sessionKey: "s2" }), undefined);
  assert.deepEqual(await hook({ content: "s1 的回复" }, { sessionKey: "s1" }), {
    content: "s1 的回复\n\n" + LINE_A,
  });
});

// runId 收紧（前向兼容）：两侧都有且不一致 ⇒ 判陈旧、不附加；任一侧缺失 ⇒ 回退 sessionKey+TTL。
test("钩子：两侧 runId 一致 → 附加", async () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A, "run-1");
  const hook = makeFreshnessSendingHook(store);
  assert.deepEqual(await hook({ content: "正文" }, { sessionKey: "s1", runId: "run-1" }), {
    content: "正文\n\n" + LINE_A,
  });
});
test("钩子：两侧 runId 不一致 → undefined（同会话的陈旧行不附加）", async () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A, "run-1");
  const hook = makeFreshnessSendingHook(store);
  assert.equal(await hook({ content: "正文" }, { sessionKey: "s1", runId: "run-2" }), undefined);
});
test("钩子：任一侧缺 runId → 回退 sessionKey+TTL（现状：宿主恒不给 runId）", async () => {
  // 捕获侧缺
  const storeA = makeStore({ t: 0 });
  storeA.capture("s1", LINE_A);
  assert.deepEqual(
    await makeFreshnessSendingHook(storeA)({ content: "正文" }, { sessionKey: "s1", runId: "run-9" }),
    { content: "正文\n\n" + LINE_A },
  );
  // 钩子 ctx 侧缺（当前 openclaw 的实际情形）
  const storeB = makeStore({ t: 0 });
  storeB.capture("s1", LINE_A, "run-1");
  assert.deepEqual(
    await makeFreshnessSendingHook(storeB)({ content: "正文" }, { sessionKey: "s1" }),
    { content: "正文\n\n" + LINE_A },
  );
});
test("钩子：content 非字符串（number/object/缺）→ undefined，不 throw", async () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A);
  const hook = makeFreshnessSendingHook(store);
  assert.equal(await hook({ content: 42 }, { sessionKey: "s1" }), undefined);
  assert.equal(await hook({ content: { text: "x" } }, { sessionKey: "s1" }), undefined);
  assert.equal(await hook({}, { sessionKey: "s1" }), undefined);
});
test("钩子：event/ctx 为 null → undefined，不 throw", async () => {
  const hook = makeFreshnessSendingHook(makeStore({ t: 0 }));
  assert.equal(await hook(null, null), undefined);
});
test("钩子：捕获行非法（非串）→ 不附加、原样放行", async () => {
  const nowRef = { t: 0 };
  const store = makeStore(nowRef);
  store.capture("s1", undefined);
  const hook = makeFreshnessSendingHook(store);
  assert.equal(await hook({ content: "正文" }, { sessionKey: "s1" }), undefined);
});
test("钩子：store 本身坏掉（take 抛异常）→ undefined，绝不外抛（宿主 fail-open）", async () => {
  const badStore = { take: () => { throw new Error("corrupted"); } };
  const hook = makeFreshnessSendingHook(badStore);
  assert.equal(await hook({ content: "正文" }, { sessionKey: "s1" }), undefined);
});

// ── 入站清账（message_received 钩子，2026-10-16 fix round 2）─────────────────────
// 捕获只服务「本轮答案的外发」；新用户消息一进来即清 ⇒ 陈旧行不跨轮泄漏
// （否则问完数据后发「你好」「谢谢」也会看到 📅 时间戳——比「有时没有」更糟）。
test("store.clear：清指定会话；缺键清全局槽；未捕获的会话无副作用", () => {
  const store = makeStore({ t: 0 });
  store.capture("s1", LINE_A);
  store.capture("s2", LINE_B);
  store.capture("", LINE_C);
  store.clear("s1");
  assert.equal(store.take("s1"), undefined, "s1 已清");
  assert.equal(store.take("s2").line, LINE_B, "s2 不受影响");
  store.clear(undefined);
  assert.equal(store.take(FRESHNESS_GLOBAL_SLOT), undefined, "缺键清全局槽");
  store.clear("never-captured"); // 无副作用、不抛
  assert.equal(store.take("s2").line, LINE_B);
});

test("入站清账：捕获 → 入站消息 → 随后外发 ⇒ 不附行（核心新用例）", async () => {
  const store = makeStore({ t: 0 });
  const inbound = makeFreshnessInboundHook(store);
  const sending = makeFreshnessSendingHook(store);
  store.capture("s1", LINE_A);
  // 入站前：外发会附行
  assert.deepEqual(await sending({ content: "本轮答案" }, { sessionKey: "s1" }), {
    content: "本轮答案\n\n" + LINE_A,
  });
  await inbound({ content: "你好" }, { sessionKey: "s1" });
  // 入站后：同样的外发不再附行
  assert.equal(await sending({ content: "你好呀" }, { sessionKey: "s1" }), undefined);
});

test("同轮多次外发：捕获 → 外发A(附) → 外发B(仍附) → 入站 → 外发C(无)", async () => {
  const store = makeStore({ t: 0 });
  const inbound = makeFreshnessInboundHook(store);
  const sending = makeFreshnessSendingHook(store);
  store.capture("s1", LINE_A);
  const a = await sending({ content: "进度：我查一下" }, { sessionKey: "s1" });
  const b = await sending({ content: "答案：1470" }, { sessionKey: "s1" });
  assert.deepEqual(a, { content: "进度：我查一下\n\n" + LINE_A }, "同轮首次外发附行");
  assert.deepEqual(b, { content: "答案：1470\n\n" + LINE_A }, "同轮再次外发仍附（同轮应有）");
  await inbound({ content: "谢谢" }, { sessionKey: "s1" });
  assert.equal(await sending({ content: "不客气" }, { sessionKey: "s1" }), undefined, "入站后无行");
});

test("入站清账：仅清本会话，不误伤他会话", async () => {
  const store = makeStore({ t: 0 });
  const inbound = makeFreshnessInboundHook(store);
  const sending = makeFreshnessSendingHook(store);
  store.capture("s1", LINE_A);
  store.capture("s2", LINE_B);
  await inbound({ content: "新问题" }, { sessionKey: "s1" });
  assert.equal(await sending({ content: "s1 答" }, { sessionKey: "s1" }), undefined);
  assert.deepEqual(await sending({ content: "s2 答" }, { sessionKey: "s2" }), {
    content: "s2 答\n\n" + LINE_B,
  });
});

test("入站清账：无捕获时无副作用、不抛（ctx 缺 sessionKey 走全局槽）", async () => {
  const store = makeStore({ t: 0 });
  const inbound = makeFreshnessInboundHook(store);
  store.capture("s2", LINE_B);
  await inbound({ content: "首条消息" }, { sessionKey: "s1" }); // s1 无捕获
  await inbound({ content: "无会话键" }, {});                    // 缺 sessionKey
  assert.equal(store.take("s2").line, LINE_B, "他会话不受影响");
});
test("入站清账：store 坏掉 / ctx 为 null → 不抛（宿主 fail-open）", async () => {
  const badStore = { clear: () => { throw new Error("corrupted"); } };
  assert.equal(await makeFreshnessInboundHook(badStore)({ content: "x" }, { sessionKey: "s1" }), undefined);
  assert.equal(await makeFreshnessInboundHook(makeStore({ t: 0 }))(null, null), undefined);
});
