// rule.js — 语言要求文本（**独立成模块**：不 import openclaw SDK，故 `node --test` 可直跑）。
// 为什么单独一个文件：这条文本是本插件存在的**唯一理由**，必须能被测试锁住（见 rule.test.js），
// 而不是埋在依赖 SDK 的 index.js 里、只能靠肉眼保证。

/** 中英双语：模型对英文指令的遵从度往往更高，故两条都给。 */
export const ZH_THINKING_RULE = [
  "【语言要求（最高优先级）】",
  "无论用户使用什么语言提问，你的**内部思考（reasoning / chain of thought）**与**对外回答**一律使用**简体中文**。",
  "即使工具返回的内容是英文，也不要把思考漂移成英文。",
  "ALWAYS write your internal chain-of-thought in Simplified Chinese, regardless of the language of tool outputs or of the user's question.",
].join("\n");
