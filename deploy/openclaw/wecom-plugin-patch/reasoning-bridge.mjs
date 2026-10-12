// reasoning-bridge.mjs —— 「思考过程流式展示」桥的**纯逻辑**实现（issue #580）
//
// 设计稿：docs/superpowers/specs/2026-10-12-shanhai-openclaw-reasoning-stream-design.md
//
// 约束：
//   · 不 import openclaw SDK、不引用插件内部 ⇒ `node --test` 可直跑（见 reasoning-bridge.test.mjs）
//   · 注入方式见同目录 apply.mjs（两个注入点：顶层 import + WS 路径 replyOptions 内一个回调）
//
// 用户口径（原话）：「有正式内容出来就只展示正式内容也行」⇒ 正文一到，`<think>` 块**闭合并让位于正文**；
// 未闭合态（纯思考期）发 `<think>{思考}`，让企微在「思考中」里逐步展开（不加 `</think>`）。
//
// ★ 与社区实现的**加严点**（判据 5）：企微流内容上限 20480 字节，思考与正文**共用**该额度 ——
//   本实现**正文优先**：额度不足时**先截断思考**，正文一律完整。社区源码未见此处理。

/** 思考流更新节流（毫秒）——防 SDK 队列积压（社区同做法）。 */
export const THROTTLE_MS = 800;

/** 企微流式消息内容上限（字节，UTF-8）——官方文档：20480。 */
export const STREAM_MAX_BYTES = 20480;

/** 截断标记（英文冒号+括号，避免与 Markdown 混淆）。 */
const TRUNCATION_NOTE = "\n…（思考过长，已截断）";

const byteLen = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

/** 归一思考文本：去 `Reasoning:` 前缀、统一换行、去首尾空白。 */
export function normalizeReasoningText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^\s*Reasoning:\s*/i, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * 把 reasoning 裁到字节预算内（**保留开头**——思考的开头信息量最大）。
 * 预算为 0 或负 ⇒ 返回空串（即放弃思考、只保正文）。
 */
export function clampReasoning(reasoning, budgetBytes) {
  if (!reasoning) return "";
  if (budgetBytes <= 0) return "";
  if (byteLen(reasoning) <= budgetBytes) return reasoning;
  // 先留出截断标记的位置；逐步按比例回退，直到落进预算。
  const withNote = () => `${cut}${TRUNCATION_NOTE}`;
  let cut = reasoning;
  for (let i = 0; i < 64 && cut.length > 0; i += 1) {
    const candidate = withNote();
    if (byteLen(candidate) <= budgetBytes) return candidate;
    const next = cut.slice(0, Math.max(0, Math.floor(cut.length * 0.9) - 1));
    if (next === cut) break;
    cut = next;
  }
  cut = cut.slice(0, Math.max(0, budgetBytes));
  return cut ? `${cut}` : "";
}

/**
 * 拼 WS 流式内容（企微 `stream.content`）。
 *
 * - 纯思考期（无正文、未 finish）：`<think>{思考}` —— **不闭合**，企微据此显示「思考中」并逐步展开
 * - 正文出现 或 finish：`<think>{思考}</think>\n{正文}` —— 闭合，思考与正文**明确分离**
 * - 无思考：只给正文 ⇒ **与未打补丁时逐字一致**（便于整体退场）
 * - 字节超限：**截断思考、保正文完整**（判据 5）
 *
 * @param {{reasoningText?: string, visibleText?: string, finish?: boolean, maxBytes?: number}} [p]
 * @returns {string}
 */
export function buildStreamContent({
  reasoningText = "",
  visibleText = "",
  finish = false,
  maxBytes = STREAM_MAX_BYTES,
} = {}) {
  const visible = String(visibleText ?? "").trim();
  const reasoning = normalizeReasoningText(reasoningText);
  if (!reasoning) return visible;

  const shouldClose = Boolean(finish) || Boolean(visible);
  const openTag = "<think>";
  const closeTag = shouldClose ? "</think>" : "";
  const separator = visible ? "\n" : "";
  // 固定开销：标签 + 分隔换行 + 正文 ⇒ 余量才是思考的预算
  const overhead = byteLen(openTag) + byteLen(closeTag) + byteLen(separator) + byteLen(visible);
  const budget = Math.max(0, maxBytes - overhead);
  const clamped = clampReasoning(reasoning, budget);
  if (!clamped) return visible; // 思考一点都放不下 ⇒ 只保正文

  const thinkBlock = `${openTag}${clamped}${closeTag}`;
  return visible ? `${thinkBlock}${separator}${visible}` : thinkBlock;
}

/**
 * 是否值得推送（节流判据）：内容变了 且 距上次推送 ≥ throttleMs。
 * 纯函数，便于单测。
 *
 * @param {{lastAt?: number, lastText?: string, now?: number, text?: string, throttleMs?: number}} [p]
 * @returns {boolean}
 */
export function shouldPush({ lastAt = 0, lastText = "", now = 0, text = "", throttleMs = THROTTLE_MS } = {}) {
  if (!text) return false;
  if (text === lastText) return false;
  return now - lastAt >= throttleMs;
}
