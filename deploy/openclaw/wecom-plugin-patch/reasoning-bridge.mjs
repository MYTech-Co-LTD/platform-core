// reasoning-bridge.mjs —— 「思考过程流式展示」桥的**纯逻辑**实现（issue #580）
//
// 设计稿：docs/superpowers/specs/2026-10-12-shanhai-openclaw-reasoning-stream-design.md
//
// 约束：
//   · 不 import openclaw SDK、不引用插件内部 ⇒ `node --test` 可直跑（见 reasoning-bridge.test.mjs）
//   · 注入方式见同目录 apply.mjs（**三个注入点**：顶层 import / WS 路径 replyOptions 内一个回调 / 占位文字）
//
// 用户口径（原话）：「有正式内容出来就只展示正式内容也行」⇒ 正文一到，`<think>` 块**闭合并让位于正文**。
//
// 2026-10-12 真机实测订正（issue #585）：企微**只在 `<think>…</think>` 闭合后**才渲染思考内容，
//   未闭合只驱动「思考中」动画（内容永不显示）⇒ 调用方一律**闭合发送**。
// 2026-10-12 追加（issue #594）：首帧占位由「空块（转原生动画）」改为**带文字的**块（见 PLACEHOLDER_TEXT），
//   用户侧从**文字**起步，思考到达后原位顶替 ⇒ 消除「动画→文字」的形态跳变。
//
// ★ 与社区实现的**加严点**（判据 5）：企微流内容上限 20480 字节，思考与正文**共用**该额度 ——
//   本实现**正文优先**：额度不足时**先截断思考**，正文一律完整。社区源码未见此处理。

/** 思考流更新节流（毫秒）——防 SDK 队列积压。
 *  800ms（社区值）实测偏钝：core 其实**逐字**投递 reasoning（仪表实测 payload 逐条 4→14→21→…→144），
 *  800ms 下每帧跨度太大、观感不连贯 ⇒ 2026-10-12 真机下调到 300ms（issue #585）。 */
export const THROTTLE_MS = 300;

/** 企微流式消息内容上限（字节，UTF-8）——官方文档：20480。 */
export const STREAM_MAX_BYTES = 20480;

/**
 * 首帧占位文本（issue #594）——替换官方硬编码常量 `THINKING_MESSAGE = "<think></think>"`。
 *
 * 企微规矩：`<think>` 块**空** ⇒ 转原生「思考中」动画；块**有文字** ⇒ 渲染文字。
 * 官方那个空块会让用户先看到动画、思考到达时**跳变**成文字；本常量让反馈从**文字**起步，
 * 随后被桥的思考帧**原位顶替**（同一 streamId，文字→文字）。
 *
 * 注意：必须是**闭合**块且**非空**——空块回到动画、未闭合则不渲染内容（issue #585）。
 */
export const PLACEHOLDER_TEXT = "<think>思考中…</think>";

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
 * - `finish=false` 且无正文：`<think>{思考}` —— **未闭合**形态（仅驱动企微的「思考中」动画，**内容不渲染**）
 * - `finish=true` 或无正文以外：`<think>{思考}</think>` —— **闭合**（企微**只在此形态下渲染思考内容**）
 *
 * ⚠️ 调用方（注入的 `onReasoningStream`）现一律传 `finish: true` 闭合发送 —— 2026-10-12 真机实测：
 *    未闭合帧的内容**永不显示**，用户只看到「思考中」动画（issue #585）。「未闭合」分支保留供将来使用。
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
