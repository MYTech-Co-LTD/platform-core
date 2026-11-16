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

// native 元工具（#2360）：走平台能力网关，不属于 modules/data 的 skill contract，
// 因此**不在** generated/tools.js 里；但网关按 contracts.tools 装载，必须同样登记。
const NATIVE_TOOLS = ["platform_capabilities", "platform_call"];

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

test("contracts.tools = 生成物 ∪ 两个 native 工具（无陈旧残留）", () => {
  const declared = manifest.contracts?.tools ?? [];
  assert.deepEqual(
    [...declared].sort(),
    [...defNames, ...NATIVE_TOOLS].sort(),
    `contracts.tools 与「生成物 + native」集合不一致：${declared.join(", ")}`,
  );
});

test("native 元工具：已登记 contracts.tools，且不混进 data skill contract 生成物", () => {
  const declared = manifest.contracts?.tools ?? [];
  for (const name of NATIVE_TOOLS) {
    assert.ok(declared.includes(name), `native 工具 ${name} 未登记 contracts.tools——网关会拒载`);
    assert.ok(!defNames.includes(name), `${name} 是 native 元工具，不应出现在 generated/tools.js`);
  }
});

test("native 元工具：index.js 各自注册（契约登记 ≠ 已接线）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  for (const name of NATIVE_TOOLS) {
    assert.ok(src.includes(`name: "${name}"`), `index.js 里找不到 ${name} 的 DEF`);
    assert.ok(
      src.includes(`{ name: ${name === "platform_capabilities" ? "CAPS_DEF" : "CALL_DEF"}.name }`),
      `index.js 里找不到 ${name} 的 registerTool`,
    );
  }
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

test("index.js 不再手写 DATA 工具 description（native 元工具除外）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  // 只允许两个 native 元工具手写 DEF；任何 data 工具若漏回手写会在这里被点名。
  const handwritten = [...src.matchAll(/name:\s*["']([a-z_]+)["'],\s*description:/g)].map((m) => m[1]);
  assert.deepEqual(handwritten.sort(), [...NATIVE_TOOLS].sort(), "index.js 出现了 generate 之外的手写 DATA 工具 DEF");
});

test("index.js 语法可解析（node --check）", () => {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL("./index.js", import.meta.url))], { stdio: "pipe" });
});
