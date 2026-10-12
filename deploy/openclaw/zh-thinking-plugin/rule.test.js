// rule.test.js — 锁住「语言要求文本」的关键要素（本插件存在的唯一理由，不许被顺手删掉）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ZH_THINKING_RULE } from "./rule.js";

test("规则明确点名 reasoning/思考 与 中文", () => {
  assert.match(ZH_THINKING_RULE, /reasoning|思考/);
  assert.match(ZH_THINKING_RULE, /中文/);
});

test("规则同时约束「对外回答」，不只是思考", () => {
  assert.match(ZH_THINKING_RULE, /回答/);
});

test("规则显式对冲「语言漂移」（工具返回英文时的场景）", () => {
  assert.match(ZH_THINKING_RULE, /漂移|英文/);
});

test("中英双语都给（模型对英文指令遵从度往往更高）", () => {
  assert.match(ZH_THINKING_RULE, /chain-of-thought/);
  assert.match(ZH_THINKING_RULE, /Simplified Chinese/);
});
