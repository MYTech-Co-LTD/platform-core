// scope.test.js — 口径射程行（📐）的捕获与确定性附加（消费面 spec 2026-10-17 §12.6）
//
// 与 📅 新鲜度行**共用**同一套机制（捕获 → 发送前剥模型自写 → 钉末尾），所以这里只钉
// 口径特有的四条：顺序、单独在场、去重、**不跨查询泄漏**（整条替换而非字段合并）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFreshnessStore, makeFreshnessSendingHook, stripScopeLines } from "./lib.js";

test("scope_line：与 📅 同一套机制，顺序为新鲜度在前、口径在后", async () => {
  const store = createFreshnessStore({ now: () => 1000 });
  store.capture(
    "s1",
    { freshness: "📅 数据已更新至 10月16日（该日数据完整）", scope: "📐 口径：仅零售门店口径" },
    "",
  );
  const hook = makeFreshnessSendingHook(store);
  const out = await hook({ content: "5 家门店连续无业绩" }, { sessionKey: "s1" });
  assert.equal(
    out.content,
    "5 家门店连续无业绩\n\n📅 数据已更新至 10月16日（该日数据完整）\n📐 口径：仅零售门店口径",
  );
});

test("scope_line 单独在场：只附 📐（该指标未接新鲜度链路时）", async () => {
  const store = createFreshnessStore({ now: () => 1000 });
  store.capture("s1", { scope: "📐 口径：仅可比门店口径" }, "");
  const hook = makeFreshnessSendingHook(store);
  const out = await hook({ content: "周环比 -14.99%" }, { sessionKey: "s1" });
  assert.equal(out.content, "周环比 -14.99%\n\n📐 口径：仅可比门店口径");
});

test("模型自写的 📐 行被剥掉再附正典行（不会出现两行）", async () => {
  const store = createFreshnessStore({ now: () => 1000 });
  store.capture("s1", { scope: "📐 口径：正典" }, "");
  const hook = makeFreshnessSendingHook(store);
  const out = await hook(
    { content: "结论\n\n📐 口径：模型自己编的\n- 📐 口径：列表里的也剥" },
    { sessionKey: "s1" },
  );
  assert.equal(out.content, "结论\n\n📐 口径：正典");
});

test("下一次查询没有射程 ⇒ 上一次的 📐 行不泄漏（整条替换，不是字段合并）", async () => {
  const store = createFreshnessStore({ now: () => 1001 });
  store.capture("s1", { freshness: "📅 数据已更新至 10月16日", scope: "📐 口径：上一问的射程" }, "");
  // 第二次查询：该指标未声明 scope_note ⇒ 只捕获新鲜度
  store.capture("s1", { freshness: "📅 数据已更新至 10月16日" }, "");
  const hook = makeFreshnessSendingHook(store);
  const out = await hook({ content: "答案" }, { sessionKey: "s1" });
  assert.equal(out.content, "答案\n\n📅 数据已更新至 10月16日");
});

test("scope 与 freshness 都缺席 ⇒ 不改写（返回 undefined）", async () => {
  const store = createFreshnessStore({ now: () => 1000 });
  const hook = makeFreshnessSendingHook(store);
  assert.equal(await hook({ content: "答案" }, { sessionKey: "s1" }), undefined);
});

test("stripScopeLines：独立行整行删、行内按前缀截到行尾、不动 📅 行", () => {
  assert.equal(stripScopeLines("a\n📐 口径：x\nb"), "a\nb");
  assert.equal(stripScopeLines("a 前面 📐 口径：x 后面"), "a 前面 ");
  assert.equal(stripScopeLines("📅 数据已更新至 x"), "📅 数据已更新至 x");
});
