// reasoning-bridge.test.mjs —— 桥的纯逻辑单测（`node --test` 直跑，不依赖 openclaw）
//
// 对应设计稿 §3 的判据：2（闭合）/ 5（字节上限正文优先，**加严点**）/ 7（有正文后不再掺思考）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THROTTLE_MS,
  STREAM_MAX_BYTES,
  PLACEHOLDER_TEXT,
  normalizeReasoningText,
  clampReasoning,
  buildStreamContent,
  shouldPush,
} from "./reasoning-bridge.mjs";

const bytes = (s) => Buffer.byteLength(s, "utf8");

test("normalizeReasoningText：去 Reasoning: 前缀、统一换行、去首尾空白", () => {
  assert.equal(normalizeReasoningText("Reasoning: 好的"), "好的");
  assert.equal(normalizeReasoningText("  a\r\nb  "), "a\nb");
  assert.equal(normalizeReasoningText(undefined), "");
  assert.equal(normalizeReasoningText(123), "");
});

test("bridge 保留未闭合形态（调用方现按 issue #585 传 finish:true 闭合发送）", () => {
  const out = buildStreamContent({ reasoningText: "正在想", visibleText: "", finish: false });
  assert.equal(out, "<think>正在想");
  assert.ok(!out.includes("</think>"));
});

// 调用方（onReasoningStream 注入点）现按 issue #585 一律这样调：finish:true、只给思考 ⇒ 闭合帧。
// 这条锁住「注入点用的那个调用形态」，防止有人顺手改回未闭合（那样内容就不渲染了）。
test("注入点调用形态（finish:true + 仅思考）⇒ 必为闭合帧", () => {
  const out = buildStreamContent({ reasoningText: "正在查数", visibleText: "", finish: true });
  assert.equal(out, "<think>正在查数</think>");
  assert.ok(out.includes("</think>"), "必须闭合，否则企微不渲染内容");
});

test("判据2/7：正文出现 ⇒ 闭合 + 换行分隔，思考在前正文在后", () => {
  const out = buildStreamContent({ reasoningText: "先算合计", visibleText: "合计 100", finish: false });
  assert.equal(out, "<think>先算合计</think>\n合计 100");
});

test("判据2：finish=true 即使无正文也闭合", () => {
  const out = buildStreamContent({ reasoningText: "只想了", visibleText: "", finish: true });
  assert.equal(out, "<think>只想了</think>");
});

test("退场一致性：无思考时输出与未打补丁**逐字相同**", () => {
  assert.equal(buildStreamContent({ reasoningText: "", visibleText: "正文" }), "正文");
  assert.equal(buildStreamContent({ reasoningText: "Reasoning: ", visibleText: "正文" }), "正文");
  assert.equal(buildStreamContent({}), "");
});

test("判据5（加严）：字节超限时**截断思考、正文完整**，且总字节 ≤ 上限", () => {
  const reasoning = "想".repeat(10000); // 3 字节/字 ⇒ 30000 字节，必然超限
  const visible = "合计 100 元（正文必须完整保留）";
  const out = buildStreamContent({ reasoningText: reasoning, visibleText: visible });
  assert.ok(bytes(out) <= STREAM_MAX_BYTES, `总字节 ${bytes(out)} 应 ≤ ${STREAM_MAX_BYTES}`);
  assert.ok(out.endsWith(visible), "正文必须逐字完整保留且在末尾");
  assert.ok(out.includes("已截断"), "应标注思考被截断");
  assert.ok(out.startsWith("<think>"), "思考块仍以 <think> 开头");
  assert.ok(out.includes("</think>"), "思考块仍闭合");
});

test("判据5：正文本身超限时，思考退让到空（只保正文）", () => {
  const visible = "正".repeat(STREAM_MAX_BYTES); // 自身已达上限
  const out = buildStreamContent({ reasoningText: "思考", visibleText: visible });
  assert.equal(out, visible.trim(), "放不下思考时应只给正文");
});

test("clampReasoning：预算 0/负 ⇒ 空串", () => {
  assert.equal(clampReasoning("abc", 0), "");
  assert.equal(clampReasoning("abc", -5), "");
});

test("clampReasoning：预算足够时原样返回", () => {
  assert.equal(clampReasoning("abc", 100), "abc");
});

// ---- issue #594：首帧占位从「空 think（原生动画）」改为「带文字的 think」 ----

test("判据9（#594）：占位是**闭合且非空**的 think 块 ⇒ 渲染文字而非原生动画", () => {
  assert.ok(PLACEHOLDER_TEXT.startsWith("<think>"), "须以 <think> 开头");
  assert.ok(PLACEHOLDER_TEXT.endsWith("</think>"), "须闭合：未闭合企微不渲染内容（#585）");
  const inner = PLACEHOLDER_TEXT.slice("<think>".length, -"</think>".length);
  assert.ok(inner.trim().length > 0, "须非空：空块会转回原生「思考中」动画 —— 本 issue 就是要去掉它");
});

test("判据9（#594）：占位远小于流上限（不挤占后续思考/正文额度）", () => {
  assert.ok(bytes(PLACEHOLDER_TEXT) < STREAM_MAX_BYTES, "占位必须远小于 20480");
});

test("shouldPush：去重 + 节流", () => {
  assert.equal(shouldPush({ text: "", now: 1e9 }), false, "空文本不推");
  assert.equal(shouldPush({ text: "a", lastText: "a", now: 1e9, lastAt: 0 }), false, "内容没变不推");
  assert.equal(shouldPush({ text: "a", lastText: "", now: 100, lastAt: 0 }), false, "节流窗内不推");
  assert.equal(shouldPush({ text: "a", lastText: "", now: THROTTLE_MS, lastAt: 0 }), true, "过窗即推");
  assert.equal(shouldPush({ text: "b", lastText: "a", now: 1e9, lastAt: 0 }), true, "内容变了即推");
});
