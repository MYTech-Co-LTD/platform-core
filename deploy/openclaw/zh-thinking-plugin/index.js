// index.js — 中文思考：用 typed hook 把「格式契约」**前置**注入系统上下文（issue #587；措辞定案 #601）。
//
// 注入点选择（2026-10-12 复核定案）：
//   · 本版（2026.9.9）没有可用的「系统提示 / 思考语言」配置项：全文 schema 检索 +
//     深度≤20 路径 walk 均 0 命中；`systemPromptOverride` 被 schema 明确拒收
//     （`Unrecognized key`）；唯一 language/locale 键是 UI 语言与媒体转写提示。
//   · `before_prompt_build` 是运行时提供的**可改写提示**的 typed hook；返回
//     `prependSystemContext` 即把文本**前置**到系统上下文（位置最高），且**不整份替换**
//     系统提示（比 `systemPromptOverride` 安全）。该钩子**每轮 prompt 构建都触发**。
//   · 工作区文件（workspace/AGENTS.md）同文本也**有效**（#601 实证：有效性与措辞类型强相关，
//     与注入层级弱相关）——本插件的额外价值在「随镜像分发、不依赖实例卷手工状态」。
//     山海生产实例两处都注（卷内 AGENTS.md 已落同文本）＝冗余加固，非双事实源：正典在本文件。
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
  description: "把「内部思考中文格式契约」前置注入系统上下文（before_prompt_build 钩子）。",
  register(api) {
    const { name, fn } = resolveHookRegistrar(api);
    // 前置 + 追加都注（文档：动态区段靠后更"近因"）。
    // #601 定案：文本换**格式契约**后实证有效——山海生产满史真通道会话压缩后连过 3/3 中文，
    // 含 2 个工具输出全英文的真工具轮；全新会话 2/2。旧「语言要求」措辞确实压不住，已废弃。
    // ⚠️ 运维口径：**满史长会话对上下文文本更新不敏感**（陈旧到连「每轮输出标记」都不出）——
    //    改契约文本后，存量会话须 `openclaw sessions compact --agent main <key>` 重建上下文
    //    才吃到新文本；新会话自动生效。详见 WeKnora 条目 23fb20ff §9。
    fn("before_prompt_build", async () => ({
      prependSystemContext: ZH_THINKING_RULE,
      appendSystemContext: ZH_THINKING_RULE,
    }));
    console.log(`[zh-thinking] 已注册 before_prompt_build 钩子（api.${name}）`);
  },
});
