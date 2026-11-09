// contracts.test.js — 网关工具声明契约回归（#989）。
// 工具定义现在由 modules/data/skill/contract.json 构建期渲染到 generated/tools.js；
// 本测试先确保生成物存在，再钉「注册名 ⊆ openclaw.plugin.json contracts.tools」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(new URL(".", import.meta.url));

// 每次都重新生成：本地残留的旧 generated/ 不能让它「假绿」；CI 干净 checkout 也能自举。
execFileSync(process.execPath, [
  fileURLToPath(new URL("../../../scripts/gen-openclaw-skill.mjs", import.meta.url)),
  "--plugin-dir", pluginDir,
], { stdio: "inherit" });

const { TOOL_DEFS } = await import("./generated/tools.js");
const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
const defNames = TOOL_DEFS.map((d) => d.name);

test("生成物非空：七个已知工具名全部在场（防渲染器静默产出空集）", () => {
  const known = ["list_metrics", "query_data", "query_detail", "describe_metric", "sample_dimension_values", "get_freshness", "search_catalog"];
  for (const name of known) assert.ok(defNames.includes(name), `生成物缺少 ${name}`);
});

test("生成物工具名 ⊆ openclaw.plugin.json contracts.tools（#989 防再漏）", () => {
  const declared = manifest.contracts?.tools ?? [];
  for (const name of defNames) {
    assert.ok(declared.includes(name), `工具 ${name} 已生成但未登记 contracts.tools——网关会拒载`);
  }
});

test("contracts.tools 与生成物集合一致（无陈旧残留）", () => {
  const declared = manifest.contracts?.tools ?? [];
  const extra = declared.filter((n) => !defNames.includes(n));
  assert.deepEqual(extra, [], `contracts.tools 里登记了生成物没有的工具：${extra.join(", ")}`);
});

test("生成物恰 7 个工具（不多不少）", () => {
  assert.equal(TOOL_DEFS.length, 7);
});

test("index.js 的 REGISTER_ORDER 集合 = 生成物 id 集合（防新增工具漏注册）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const m = src.match(/const REGISTER_ORDER\s*=\s*(\[[^\]]*\])/);
  assert.ok(m, "index.js 里找不到 REGISTER_ORDER 字面量");
  const order = JSON.parse(m[1]);
  assert.deepEqual([...order].sort(), TOOL_DEFS.map((d) => d.id).sort());
});

test("index.js 不再手写工具 description（防回退到两套事实源）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.ok(!/name:\s*"[a-z_]+",\s*\n\s*description:/.test(src), "index.js 仍有手写 DEF；工具定义应来自 generated/tools.js");
});

test("index.js 语法可解析（node --check）", () => {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL("./index.js", import.meta.url))], { stdio: "pipe" });
});
