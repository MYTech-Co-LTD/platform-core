// contracts.test.js — 网关工具声明契约回归（#989）。
// openclaw 网关按 openclaw.plugin.json 的 contracts.tools 决定放行哪些工具：插件注册了
// contracts.tools 没登的名字 ⇒ 拒载（真机日志原文「plugin must declare contracts.tools for: …」，
// 2026-10-22 shanhai 部署后实锤——Wave 2 三新工具因此全部不可用，企微冒烟全走旧路径）。
// 本测试钉死：index.js 里每一个工具 DEF 的名字都必须已在 contracts.tools 登记——**防再漏**。
// ⚠️ index.js import openclaw SDK，node --test 无法加载它 ⇒ 这里按源码文本提取 DEF 名
// （DEF 形状固定：`name: "<snake_case>",` 下一行紧跟 `description:`——插件入口 definePluginEntry
// 的 name 是 "Data Query"，大写带空格，不会误中）。为防正则静默匹配零条（测试假绿），
// 先断言提取结果包含全部六个已知工具名，再做 ⊆ 断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));

/** index.js 里全部工具 DEF 的名字（DEF 常量定义处，非 registerTool 第二参的引用）。 */
const defNames = [...indexSrc.matchAll(/name:\s*"([a-z_]+)",\s*\n\s*description:/g)].map((m) => m[1]);

/** 已知工具全集（六把：Wave 1 三把 + Wave 2 三把）。新加工具时这里与 plugin.json 一起动。 */
const KNOWN_TOOLS = ["list_metrics", "query_data", "query_detail", "describe_metric", "sample_dimension_values", "get_freshness"];

test("源码提取非空：六个已知工具名全部被正则捕获（防正则失配导致测试假绿）", () => {
  for (const name of KNOWN_TOOLS) {
    assert.ok(defNames.includes(name), `正则没从 index.js 提取到 ${name}——DEF 形状变了，先修提取再谈契约`);
  }
});

test("index.js 全部工具 DEF 名 ⊆ openclaw.plugin.json contracts.tools（#989 防再漏）", () => {
  const declared = manifest.contracts?.tools ?? [];
  for (const name of defNames) {
    assert.ok(
      declared.includes(name),
      `工具 ${name} 已在 index.js 注册但未登记 openclaw.plugin.json contracts.tools——网关会拒载（#989）`,
    );
  }
});

test("contracts.tools 与 DEF 名集合一致（无陈旧残留；改名/下线工具时两侧一起动）", () => {
  const declared = manifest.contracts?.tools ?? [];
  const extra = declared.filter((n) => !defNames.includes(n));
  assert.deepEqual(extra, [], `contracts.tools 里登记了 index.js 未注册的工具：${extra.join(", ")}`);
});
