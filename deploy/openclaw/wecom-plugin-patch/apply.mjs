#!/usr/bin/env node
// apply.mjs —— 给官方 @wecom/wecom-openclaw-plugin 的 **WS 路径**注入「思考过程流式展示」桥。
//
// 依据：docs/superpowers/specs/2026-10-12-shanhai-openclaw-reasoning-stream-design.md（issue #580）
//
// 设计原则（缺一不可，见设计稿 §2.1 / §5）：
//   ① 自跳过：目标源码已含 onReasoningStream ⇒ 上游已支持 ⇒ **不打补丁、不改一字**
//              （「官方做了能低成本切回官方」的落点：上游一发布，本步骤自动失效）
//   ② 幂等：重复执行结果一致（以 MARKER 识别「已打」）
//   ③ 最小：**五个注入点**（顶层 import / replyOptions 内一个回调 / 占位文字常量 /
//            终帧投递行 `text: displayText,` / finish 帧行 `text: finishText,`），实现体在独立文件
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
//   · 占位锚点 `text: THINKING_MESSAGE,` 在 dist/src/monitor.js 内**唯一**（sendThinkingReply 内，
//     触发时机 dispatcherOptions.onReplyStart，热态实测 ~0.1s 即发出）——issue #594
//   · 终帧锚点 `text: displayText,`（流式投递的最后一帧）与 `text: finishText,`
//     （finishThinkingStream 的 finish 帧）在 dist/src/monitor.js 内各**唯一**——issue #596
//     （2026-10-12 实测：count 均 =1；真机四轮实验定型折叠帧契约，见 reasoning-bridge.mjs 头注）

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 已打补丁的标记（幂等判据）—— 注入在 import 行首，出现即视为本方已处理 */
const MARKER = "/* __WECOM_REASONING_BRIDGE__ */";
/** 上游已支持的判据：插件 WS 路径一旦自己实现，源码必然出现该回调名 */
const UPSTREAM_SIGNAL = "onReasoningStream";
/** 注入锚点：WS 路径 replyOptions 对象起始处 */
const ANCHOR = "replyOptions: {";
/** 注入点 3 锚点：官方占位文本的使用处（须**全文件唯一**）——issue #594 */
const PLACEHOLDER_ANCHOR = "text: THINKING_MESSAGE,";
/** 注入点 4 锚点：流式投递最后一帧的正文行（须**全文件唯一**）——issue #596 */
const DELIVER_ANCHOR = "text: displayText,";
/** 注入点 5 锚点：finishThinkingStream finish 帧的正文行（须**全文件唯一**）——issue #596 */
const FINISH_ANCHOR = "text: finishText,";
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
  `shouldPush as __wrbShouldPush, PLACEHOLDER_TEXT as __wrbPlaceholder } from ${JSON.stringify(bridgePath)};`;
const hasShebang = src.startsWith("#!");
const shebangEnd = hasShebang ? src.indexOf("\n") + 1 : 0;
let out = src.slice(0, shebangEnd) + importLine + "\n" + src.slice(shebangEnd);

// 注入点 2：replyOptions 内加 onReasoningStream（锚点位置因上一处插入而右移）
const anchorAt = out.indexOf(ANCHOR);
if (anchorAt < 0) die("内部错误：插入 import 后锚点丢失。");
const insertAt = anchorAt + ANCHOR.length;
const callback = `
                // 「思考过程流式展示」桥（issue #580；#596 折叠定型）：思考流式进**未闭合** <think>，
                //   维持企微「思考通道态」（内容不显示、思考中状态持续）；终帧（下方注入点 4/5）才闭合
                //   且思考+正文同帧 ⇒ 客户端把思考**折叠成条**、点击展开。折叠要求终帧落地时处于通道态，
                //   故中间帧**绝不能闭合**（闭合文字块 = 文本态 = 终帧不折叠，V1 实测）。
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
                            // ⚠️ **未闭合发送**：维持思考通道态（#596 帧契约，见 reasoning-bridge.mjs 头注）。
                            text: __wrbBuild({ reasoningText: text, visibleText: "", finish: false }),
                        });
                    } catch (e) {
                        runtime.log?.(\`[wecom][reasoning-bridge] \${String(e)}\`);
                    }
                },`;
out = out.slice(0, insertAt) + callback + out.slice(insertAt);

// 注入点 3：占位文字（issue #594 引入；#596 起与官方常量**同值**仍保留）——把占位收编到桥的单一事实源：
// 官方硬编码 `THINKING_MESSAGE` 换成桥导出的 PLACEHOLDER_TEXT（现为闭合空块 ⇒ 原生动画，见桥头注）。
// 值虽同形，占位的形态演进（如改未闭合）只动桥一处、不动本文件。
// 锚点必须**全文件唯一**：0 次（上游结构变了）或 >1 次（会改错地方）都宁可失败退出。
const placeholderHits = out.split(PLACEHOLDER_ANCHOR).length - 1;
if (placeholderHits !== 1) {
  die(
    `占位锚点 ${JSON.stringify(PLACEHOLDER_ANCHOR)} 出现 ${placeholderHits} 次（要求恰好 1 次）` +
      ` —— 上游结构可能已变，请人工核对后再升版本号。`,
  );
}
out = out.replace(PLACEHOLDER_ANCHOR, "text: __wrbPlaceholder,");

// 注入点 4/5（issue #596 折叠定型）：两个终帧正文行换成「思考+正文」同帧**闭合**形态
// ⇒ 终帧落地时客户端处于通道态（注入点 2 的未闭合帧维持）⇒ 思考折叠成条、点击展开。
// 无思考时 __wrbBuild 原样返回正文 —— 退场一致性不变（判据：与未打补丁逐字一致）。
for (const [anchor, replacement, label] of [
  [
    DELIVER_ANCHOR,
    "text: __wrbBuild({ reasoningText: state.reasoningText, visibleText: displayText, finish: true }),",
    "终帧投递",
  ],
  [
    FINISH_ANCHOR,
    "text: __wrbBuild({ reasoningText: state.reasoningText, visibleText: finishText, finish: true }),",
    "finish 帧",
  ],
]) {
  const hits = out.split(anchor).length - 1;
  if (hits !== 1) {
    die(
      `${label}锚点 ${JSON.stringify(anchor)} 出现 ${hits} 次（要求恰好 1 次）` +
        ` —— 上游结构可能已变，请人工核对后再升版本号。`,
    );
  }
  out = out.replace(anchor, replacement);
}

log(`注入完成：import ✓ / onReasoningStream ✓ / 占位文字 ✓ / 终帧投递 ✓ / finish 帧 ✓（bridge=${bridgePath}）`);

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
