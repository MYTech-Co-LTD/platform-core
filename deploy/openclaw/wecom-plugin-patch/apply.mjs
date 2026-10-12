#!/usr/bin/env node
// apply.mjs —— 给官方 @wecom/wecom-openclaw-plugin 的 **WS 路径**补「思考过程流式展示」桥。
//
// 依据：docs/superpowers/specs/2026-10-12-shanhai-openclaw-reasoning-stream-design.md（issue #580）
//
// 设计原则（缺一不可，见设计稿 §2.1 / §5）：
//   ① 自跳过：目标源码已含 onReasoningStream ⇒ 上游已支持 ⇒ **不打补丁、不改一字**
//              （这就是「官方做了能低成本切回官方」的落点：上游一发布，本步骤自动失效）
//   ② 幂等：重复执行结果一致（以 MARKER 识别「已打」）
//   ③ 最小：单一注入点 + 独立实现文件；整体回退 = 删掉构建期这一步
//   ④ 失败要响：找不到注入锚点 ⇒ **非零退出**（宁可构建失败，不可静默降级成旧行为）
//
// 用法：
//   node apply.mjs <插件目录> [--check]
//     --check  只报告将要做什么，不写盘（排障 / CI 用）
//
// ⚠️ 期 1（本文件当前形态）：只做「探测 + 自跳过 + 锚点定位」，**尚未注入** ⇒ 零行为变化。
//    期 2 在此处加上 bridge 实现与注入；期 3 加边界与加严（20480 字节下正文优先）。

import fs from "node:fs";
import path from "node:path";

/** 已打补丁的标记（幂等判据） */
const MARKER = "/* __WECOM_REASONING_BRIDGE__ */";
/** 上游已支持的判据：插件 WS 路径一旦自己实现，源码必然出现该回调名 */
const UPSTREAM_SIGNAL = "onReasoningStream";
/** 注入锚点：WS 路径 replyOptions 对象起始处 */
const ANCHOR = "replyOptions: {";
/** WS 路径实现文件的候选位置（不同打包形态） */
const WS_CANDIDATES = ["dist/src/monitor.js", "dist/src/monitor.mjs"];

const log = (m) => console.log(`[wecom-patch] ${m}`);
const die = (m, code = 2) => {
  console.error(`[wecom-patch] ERROR: ${m}`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check");
const root = argv.find((a) => !a.startsWith("--"));

if (!root) die("用法: node apply.mjs <插件目录> [--check]");
if (!fs.existsSync(root)) die(`插件目录不存在: ${root}`);
if (checkOnly) log("模式: --check（只报告，不写盘）");

const wsFile = WS_CANDIDATES.map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
if (!wsFile) die(`未找到 WS 路径实现（找过 ${WS_CANDIDATES.join(" / ")}）于 ${root}`);

const src = fs.readFileSync(wsFile, "utf8");
const rel = path.relative(root, wsFile);
log(`目标: ${rel}（${src.length} bytes）`);

// ① 自跳过 —— 上游已支持（低成本切回官方的落点）
if (src.includes(UPSTREAM_SIGNAL)) {
  log(`上游已支持：源码已含 ${UPSTREAM_SIGNAL} ⇒ **跳过本方补丁，不改一字**。`);
  log("（这意味着可以删除本构建步骤，改用官方实现；见设计稿 §2.1）");
  process.exit(0);
}

// ② 幂等 —— 本方已打过
if (src.includes(MARKER)) {
  log("已打过本方补丁（幂等）⇒ 跳过。");
  process.exit(0);
}

// ④ 失败要响 —— 锚点必须找得到
const at = src.indexOf(ANCHOR);
if (at < 0) {
  die(`未找到注入锚点 ${JSON.stringify(ANCHOR)} —— 上游结构可能已变，请人工核对后再升版本号。`);
}
log(`注入锚点已定位: offset=${at} ✓（锚点前缀: ${src.slice(at, at + 40)}）`);

if (checkOnly) {
  log("--check：检查通过（探测/自跳过/锚点定位均正常），未写盘。");
  process.exit(0);
}

// ── 期 2 将在此注入：复制 bridge 实现文件 + 在锚点后插入 onReasoningStream ──
log("期 1（骨架）：**本步骤尚不注入** —— 零行为变化。");
process.exit(0);
