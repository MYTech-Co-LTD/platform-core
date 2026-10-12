// index.js — 中文思考：用 typed hook 把语言要求**前置**注入系统上下文（issue #587）。
//
// 为什么走钩子而不是配置/工作区文件（都已实测排除）：
//   · 工作区上下文文件按固定优先级注入（AGENTS.md=10 → SOUL.md=20 → …），**位置最弱**，
//     实测压不住模型 CoT 的「语言漂移」（工具返回英文内容时思考翻成英文）；
//   · 本版（2026.9.9）**没有可用的「系统提示 / 思考语言」配置项**：全文 schema 检索 +
//     深度≤20 路径 walk 均 0 命中；`systemPromptOverride` 被 schema 明确拒收
//     （`Unrecognized key`）；唯一 language/locale 键是 UI 语言与媒体转写提示。
//   · `before_prompt_build` 是运行时提供的**可改写提示**的 typed hook；返回
//     `prependSystemContext` 即把文本**前置**到系统上下文（位置最高），且**不整份替换**
//     系统提示（比 `systemPromptOverride` 安全）。该钩子**每轮 prompt 构建都触发**，正对冲漂移。
//
// ⚠️ 运行时门禁（非内置插件用会话类钩子必须显式开）：
//     plugins.entries.zh-thinking.hooks.allowConversationAccess = true
//
// ⚠️ 钩子注册方法名：**2026.9.9 实测公开方法是 `api.on`**（`registerTypedHook` 是内部注册器，
//    直接调会 `TypeError: api.registerTypedHook is not a function`）。这里做兼容垫片，并在
//    全都不可用时把 API 上的可用方法名打出来自诊断——免得下一次又只能靠猜。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ZH_THINKING_RULE } from "./rule.js";

/** 依次尝试已知的几种注册名（不同版本/包装层暴露不一）。 */
function resolveHookRegistrar(api) {
  for (const name of ["on", "registerTypedHook", "registerHook"]) {
    if (typeof api?.[name] === "function") return { name, fn: api[name].bind(api) };
  }
  const available = api && typeof api === "object"
    ? Object.keys(api).filter((k) => typeof api[k] === "function")
    : [];
  throw new Error(`zh-thinking: 未找到钩子注册方法（试过 on / registerTypedHook / registerHook）；api 上的函数有: ${available.join(", ") || "(none)"}`);
}

export default definePluginEntry({
  id: "zh-thinking",
  name: "Chinese Thinking",
  description: "把「内部思考与回答一律用简体中文」前置注入系统上下文（before_prompt_build 钩子）。",
  register(api) {
    const { name, fn } = resolveHookRegistrar(api);
    // 前置 + 追加都注（文档：动态区段靠后更"近因"）。实测两者都注仍**压不住工具轮的语言漂移**，
    // 但**非工具轮已能稳定输出中文思考** ⇒ 保留（代价仅 ~252 字符/轮）。
    fn("before_prompt_build", async () => ({
      prependSystemContext: ZH_THINKING_RULE,
      appendSystemContext: ZH_THINKING_RULE,
    }));
    console.log(`[zh-thinking] 已注册 before_prompt_build 钩子（api.${name}）`);
  },
});
