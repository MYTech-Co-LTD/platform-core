// apply.test.mjs —— apply.mjs 的**注入行为**单测（`node --test` 直跑；不依赖真插件包）
//
// 为什么单独有这个文件：apply.mjs 是唯一**改源码**的环节 —— 锚点找错 = 改错地方，
// 锚点不唯一 = 静默只改一处。这些风险只有**真的跑一遍 apply.mjs** 才能拦住
// （断言必须走到它声称的那一行；deploy/openclaw/** 不被 CI 覆盖，见 issue #583）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPLY = path.join(HERE, "apply.mjs");
const BRIDGE = path.join(HERE, "reasoning-bridge.mjs");

/** 最小可用「插件」夹具：同时含两个必锚点（`replyOptions: {` 与官方占位 `text: THINKING_MESSAGE,`）。 */
const FIXTURE = `import { THINKING_MESSAGE } from "./const.js";
async function sendThinkingReply(params) {
    const { wsClient, frame, streamId, runtime, state } = params;
    await sendWeComReply({
        wsClient,
        frame,
        text: THINKING_MESSAGE,
        runtime,
        finish: false,
        streamId,
    });
}
function buildReply(wsClient, frame, runtime, state) {
    return {
        replyOptions: {
        },
    };
}
`;

function makePluginDir(fileBody = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-patch-test-"));
  fs.mkdirSync(path.join(dir, "dist", "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "src", "monitor.js"), fileBody);
  return dir;
}

const monitorOf = (dir) => path.join(dir, "dist", "src", "monitor.js");

function runApply(dir) {
  try {
    const stdout = execFileSync(process.execPath, [APPLY, dir, "--bridge-path", BRIDGE], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

test("apply：三个注入点都落位（import / onReasoningStream / 占位文字）", () => {
  const dir = makePluginDir();
  const r = runApply(dir);
  assert.equal(r.status, 0, `apply 应成功；stderr=${r.stderr}`);
  const out = fs.readFileSync(monitorOf(dir), "utf8");
  assert.ok(out.includes("PLACEHOLDER_TEXT as __wrbPlaceholder"), "import 应含占位常量别名");
  assert.ok(out.includes("text: __wrbPlaceholder,"), "#594：占位应换成桥常量");
  assert.ok(!out.includes("text: THINKING_MESSAGE,"), "#594：原占位锚点应消失");
  assert.ok(out.includes("onReasoningStream"), "桥回调应注入");
});

test("apply：占位锚点**不唯一** ⇒ 非零退出，且**不改文件**（不静默只改一处）", () => {
  const dup = FIXTURE.replace(
    "        text: THINKING_MESSAGE,\n",
    "        text: THINKING_MESSAGE,\n        text: THINKING_MESSAGE,\n",
  );
  assert.equal(dup.split("text: THINKING_MESSAGE,").length - 1, 2, "夹具构造应真的出现两次锚点");
  const dir = makePluginDir(dup);
  const before = fs.readFileSync(monitorOf(dir), "utf8");
  const r = runApply(dir);
  assert.notEqual(r.status, 0, "锚点不唯一必须非零退出");
  assert.equal(fs.readFileSync(monitorOf(dir), "utf8"), before, "失败时不得留下半成品");
});

test("apply：幂等（跑两遍结果逐字一致）", () => {
  const dir = makePluginDir();
  assert.equal(runApply(dir).status, 0);
  const once = fs.readFileSync(monitorOf(dir), "utf8");
  const second = runApply(dir);
  assert.equal(second.status, 0, "第二遍应走幂等分支");
  assert.equal(fs.readFileSync(monitorOf(dir), "utf8"), once, "重复执行结果一致");
});

test("apply：上游已支持（源码已含 onReasoningStream）⇒ 不打补丁、一字不改", () => {
  const upstream = FIXTURE.replace(
    "        replyOptions: {",
    "        replyOptions: {\n            onReasoningStream: async () => {},",
  );
  assert.ok(upstream.includes("onReasoningStream"), "夹具构造应真的加上了上游信号");
  const dir = makePluginDir(upstream);
  const r = runApply(dir);
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(monitorOf(dir), "utf8"), upstream, "上游已支持时不得改动");
});
