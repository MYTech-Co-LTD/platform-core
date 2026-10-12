// rule.test.js — 锁住「格式契约文本」的关键要素（本插件存在的唯一理由，不许被顺手删掉）。
// 2026-10-12（issue #601）措辞从「语言要求」改为「格式契约」，锁定要素随之换血：
// 旧的「中英双语都给」条目随英文行一起删除——胜利文本即实验验证文本，不加未验证的英文行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ZH_THINKING_RULE } from "./rule.js";

test("规则明确点名 思考 与 中文", () => {
  assert.match(ZH_THINKING_RULE, /思考/);
  assert.match(ZH_THINKING_RULE, /中文/);
});

test("格式契约锚点：思考第一行必须中文复述输入（从第 0 个思考 token 起锁中文）", () => {
  assert.match(ZH_THINKING_RULE, /第一行必须用中文复述/);
  assert.match(ZH_THINKING_RULE, /问题：/);
});

test("重写对冲：发现英文思考必须停下重写", () => {
  assert.match(ZH_THINKING_RULE, /发现自己在写英文思考/);
  assert.match(ZH_THINKING_RULE, /重写/);
});

test("优先级声明：显式压过会话历史先例（长会话动量是主要漂移源）", () => {
  assert.match(ZH_THINKING_RULE, /优先于会话历史/);
});

test("工具轮漂移对冲：英文工具输出先译再引用", () => {
  assert.match(ZH_THINKING_RULE, /工具输出为英文/);
});

test("实验标记条已剥（诊断用〔A2〕不进生产文本）", () => {
  assert.doesNotMatch(ZH_THINKING_RULE, /〔A2〕|〔A1〕/);
});
