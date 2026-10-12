#!/usr/bin/env node
// apply.mjs —— 给官方 @wecom/wecom-openclaw-plugin 的 **WS 路径**注入「思考过程流式展示」桥。
//
// 依据：docs/superpowers/specs/2026-10-12-shanhai-openclaw-reasoning-stream-design.md（issue #580）
//
// 设计原则（缺一不可，见设计稿 §2.1 / §5）：
//   ① 自跳过：目标源码已含 onReasoningStream ⇒ 上游已支持 ⇒ **不打补丁、不改一字**
//              （「官方做了能低成本切回官方」的落点：上游一发布，本步骤自动失效）
//   ② 幂等：重复执行结果一致（以 MARKER 识别「已打」）
//   ③ 最小：**两个注入点**（顶层 import + replyOptions 内一个回调），实现体在独立文件
//            reasoning-bridge.mjs；整体回退 = 删掉构建期这一步
//   ④ 失败要响：找不到锚点 / 打完语法不过 ⇒ **非零退出**（宁可构建失败，不可静默降级）
//
// 用法：
//   node apply.mjs <插件目录> [--check] [--bridge-path <绝对路径>]
//
// 实测依据（2026-10-12，插件 2026.9.15）：
//   · 锚点 `replyOptions: {` 存在于 dist/src/monitor.js
//   · `state.streamId` 在 dispatch **之前**就已创建（`const state = { accumulatedText: "", streamId }`）
//     ⇒ 回调可安全复用同一 stream（原位更新）
//   · 回调体用到的 `state / wsClient / frame / runtime / sendWeComReply` 均在同一函数作用域内

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 已打补丁的标记（幂等判据）—— 注入在 import 行首，出现即视为本方已处理 */
const MARKER = "/* __WECOM_REASONING_BRIDGE__ */";
/** 上游已支持的判据：插件 WS 路径一旦自己实现，源码必然出现该回调名 */
const UPSTREAM_SIGNAL = "onReasoningStream";
/** 注入锚点：WS 路径 replyOptions 对象起始处 */
const ANCHOR = "replyOptions: {";
/** WS 路径实现文件的候选位置（不同打包形态） */
const WS_CANDIDATES = ["dist/src/monitor.js", "dist/src/monitor.mjs"];
/** 默认 bridge 实现路径（构建期 COPY 进镜像的固定位置） */
const DEFAULT_BRIDGE_PATH = "/opt/plugins/wecom-plugin-patch/reasoning-bridge.mjs";

const log = (m) => console.log(`[wecom-patch] ${m}`);
const die = (m, code = 2) => {
  console.error(`[wecom-patch] ERROR: ${m}`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const bridgeAt = argv.indexOf("--bridge-path");
const bridgePath = bridgeAt >= 0 ? argv[bridgeAt + 1] : DEFAULT_BRIDGE_PATH;
const root = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--bridge-path");

if (!root) die("用法: node apply.mjs <插件目录> [--check] [--bridge-path <绝对路径>]");
if (!fs.existsSync(root)) die(`插件目录不存在: ${root}`);
if (checkOnly) log("模式: --check（只报告，不写盘）");

const wsFile = WS_CANDIDATES.map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
if (!wsFile) die(`未找到 WS 路径实现（找过 ${WS_CANDIDATES.join(" / ")}）于 ${root}`);

const src = fs.readFileSync(wsFile, "utf8");
const rel = path.relative(root, wsFile);
log(`目标: ${rel}（${src.length} bytes）`);

// ② 幂等 —— 本方已打过（**必须排在①之前**：本方补丁自己也会引入 UPSTREAM_SIGNAL，
//    否则打过的文件会被误判成「上游已支持」）
if (src.includes(MARKER)) {
  log("已打过本方补丁（幂等）⇒ 跳过。");
  process.exit(0);
}

// ① 自跳过 —— 上游已支持（低成本切回官方的落点）
if (src.includes(UPSTREAM_SIGNAL)) {
  log(`上游已支持：源码已含 ${UPSTREAM_SIGNAL} ⇒ **跳过本方补丁，不改一字**。`);
  log("（这意味着可以删除本构建步骤、改用官方实现；见设计稿 §2.1）");
  process.exit(0);
}

// ④ 失败要响 —— 锚点必须找得到
const at = src.indexOf(ANCHOR);
if (at < 0) die(`未找到注入锚点 ${JSON.stringify(ANCHOR)} —— 上游结构可能已变，请人工核对后再升版本号。`);

// 注入点 1：顶层 import（若文件以 shebang 开头则插在其后）
const importLine =
  `${MARKER}\n` +
  `import { buildStreamContent as __wrbBuild, normalizeReasoningText as __wrbNormalize, ` +
  `shouldPush as __wrbShouldPush } from ${JSON.stringify(bridgePath)};`;
const hasShebang = src.startsWith("#!");
const shebangEnd = hasShebang ? src.indexOf("\n") + 1 : 0;
let out = src.slice(0, shebangEnd) + importLine + "\n" + src.slice(shebangEnd);

// 注入点 2：replyOptions 内加 onReasoningStream（锚点位置因上一处插入而右移）
const anchorAt = out.indexOf(ANCHOR);
if (anchorAt < 0) die("内部错误：插入 import 后锚点丢失。");
const insertAt = anchorAt + ANCHOR.length;
const callback = `
                // 「思考过程流式展示」桥（issue #580）：思考流式进 <think>，正文一到即让位。
                // 用户口径：有正式内容后只展示正式内容；未闭合态让企微在「思考中」里展开。
                onReasoningStream: async (payload) => {
                    try {
                        if (!state.streamId || state.streamExpired) return;
                        const text = __wrbNormalize(payload && payload.text);
                        if (!text) return;
                        state.reasoningText = text;
                        const now = Date.now();
                        if (!__wrbShouldPush({
                            lastAt: state.__wrbLastAt || 0,
                            lastText: state.__wrbLastText || "",
                            now,
                            text,
                        })) return;
                        state.__wrbLastAt = now;
                        state.__wrbLastText = text;
                        await sendWeComReply({
                            wsClient,
                            frame,
                            runtime,
                            finish: false,
                            streamId: state.streamId,
                            // ⚠️ 必须**闭合发送**：企微只在 <think>…</think> **闭合后**才渲染思考内容，
                            //    未闭合只驱动「思考中」动画（内容永不显示）——2026-10-12 真机实测，issue #585。
                            text: __wrbBuild({ reasoningText: text, visibleText: "", finish: true }),
                        });
                    } catch (e) {
                        runtime.log?.(\`[wecom][reasoning-bridge] \${String(e)}\`);
                    }
                },`;
out = out.slice(0, insertAt) + callback + out.slice(insertAt);

log(`注入完成：import ✓ / onReasoningStream ✓（bridge=${bridgePath}）`);

if (checkOnly) {
  log("--check：检查通过（不写盘）。");
  process.exit(0);
}

// ④ 语法门 —— 打完先验语法，防把网关打挂（同 2026-10-12 SecretRef 事故的教训）
fs.writeFileSync(wsFile, out);
try {
  execFileSync(process.execPath, ["--check", wsFile], { stdio: "pipe" });
  log("语法门通过（node --check）✓");
} catch (e) {
  // 回滚，避免留下半成品
  fs.writeFileSync(wsFile, src);
  die(`打完补丁语法不过（已回滚）: ${String(e.stderr || e.message).slice(0, 500)}`, 3);
}
