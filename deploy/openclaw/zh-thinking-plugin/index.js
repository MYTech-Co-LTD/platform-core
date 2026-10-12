// index.js — 中文思考：用 typed hook 把语言要求**前置**注入系统上下文（issue #587）。
//
// 为什么走钩子而不是配置/工作区文件（都已实测排除）：
//   · 工作区上下文文件按固定优先级注入（AGENTS.md=10 → SOUL.md=20 → …），**位置最弱**，
//     实测压不住模型 CoT 的「语言漂移」（工具返回英文内容时思考翻成英文）；
//   · 本版（2026.9.9）**没有可用的「系统提示 / 思考语言」配置项**：全文 schema 检索 +
//     深度≤20 路径 walk 均为 0 命中；`systemPromptOverride` 被 schema 明确拒收
//     （`Unrecognized key`）；唯一 language/locale 键是 UI 语言与媒体转写提示。
//   · `before_prompt_build` 是运行时提供的**可改写提示**的 typed hook；返回
//     `prependSystemContext` 即把文本**前置**到系统上下文（位置最高），且**不整份替换**
//     系统提示（比 `systemPromptOverride` 安全）。该钩子**每轮 prompt 构建都触发**，
//     正好对冲漂移。
//
// ⚠️ 运行时门禁（非内置插件用会话类钩子必须显式开，否则钩子被静默挡住）：
//     plugins.entries.zh-thinking.hooks.allowConversationAccess = true
//     —— 开启它意味着该插件可访问会话/提示内容（我们自己的代码，已知风险）。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ZH_THINKING_RULE } from "./rule.js";

export default definePluginEntry({
  id: "zh-thinking",
  name: "Chinese Thinking",
  description: "把「内部思考与回答一律用简体中文」前置注入系统上下文（before_prompt_build 钩子）。",
  register(api) {
    api.registerTypedHook("before_prompt_build", async () => ({
      prependSystemContext: ZH_THINKING_RULE,
    }));
  },
});
