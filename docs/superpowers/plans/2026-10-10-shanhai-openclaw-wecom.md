# shanhai OpenClaw 企微 bot（通道 C 部署面）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 shanhai 租户落地自营 OpenClaw 企微 bot——compose 单元 A 新增 `openclaw` 服务 + 随仓问数插件，走平台问数 API（既有授权核心），流式输出显式开启。

**Architecture:** 平台侧零新增代码（通道 C 中间件 #146 已在山海实例上）。仓内只加三样：`openclaw` compose 服务（profiles 关闭、openship 服务级启停）、`deploy/openclaw/data-query-plugin/` 插件（native plugin factory 形式读 `requesterSenderId`，零权限逻辑薄转发）、文档。运维面（openship env / 服务启停 / 容器内初始化 / 真机验收）是独立任务，由编排者经 openship MCP 执行。

**Tech Stack:** OpenClaw v2026.9.9（ghcr digest 钉版）+ `@wecom/wecom-openclaw-plugin@2026.9.15`（容器内 npm 安装）；插件纯 Node ESM 零 npm 依赖（`node --test` 本地可测）；docker compose；openship MCP。

**Spec:** `docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md`（已评审，commit `7d1f1f7`）

---

## Global Constraints

每条隐含在**每一个**任务里。

1. **data-analysis 零接触**：不 clone 其部署面、不改其任何文件、不往那台机器（113.249.120.84）的容器装任何东西。
2. **版本钉死（逐字照抄，绝不续写/改写 SHA）**：镜像 `ghcr.io/openclaw/openclaw@sha256:7f10d5cc975a90b65192eaa099454fe33ce8ce2390806c61c65cd868e9ef730d`（= v2026.9.9）；企微插件 `@wecom/wecom-openclaw-plugin@2026.9.15`；升级以 GitHub releases 为事实源（npm `latest` 滞后，实测 2026-10-10）。
3. **B7**：全仓只两份 compose；新增 `ports` 条目必须 `127.0.0.1:` 起头、6 空格缩进列表项（`scripts/check-compose.mjs` 文本级判）。
4. **B9**：扫描面是 `apps/ packages/ modules/` 的 TS——插件（deploy/ 下 JS）不在扫描面，但 env 键仍须在根 `.env.example` 声明（`# KEY=` 注释行也算声明）。
5. **插件零 npm 依赖**：只用 `openclaw/plugin-sdk/plugin-entry` + 全局 `fetch`；工具注册必须是 **factory 形式** `api.registerTool((ctx) => toolDef, { name })`（`requesterSenderId` 只在 factory 的 `ctx` 上）；`execute` 签名是 `(toolCallId, params, signal, onUpdate)`——第一个参数是 toolCallId，**不是**模型参数（生产先例实测踩坑）。
6. **插件零权限逻辑**：词表裁剪/主体钉死/fail-closed 全在平台授权核心；插件只做「可信 userid + 渠道凭证 → 平台 API」的转发与错误文案映射。
7. **密钥不落仓**：`DATA_LLM_API_KEY`（**复用项目级，不新增**）/ `WECOM_BOT_SECRET` / `DATA_WECOM_CHANNEL_KEY` 一律走 openship env(isSecret)（生产）或本地 `.env`（gitignore）；openclaw.json 里用 `${ENV}` 插值引用；任何命令输出/日志不得回显值。
8. **提纪律**：feat 必须先有 issue（开工前置建）；PR body 带 `Closes #N`；只等 CI **CLEAN** 才合；CHANGELOG 由 release.mjs 生成（禁手写）。
9. **shell 里 `$VAR` 紧跟中文必须写 `${VAR}`**（bash 3.2 吃进变量名，本仓中文文案多）。
10. **山海部署是手工面**：platform-core（mytech）merge main 即自动部署；**platform-core-shanhai 只走 openship 手工触发**，且对新服务先备 env 再启用（2026-09-29 crash loop 教训：compose 声明 ≠ 不起，openship 按服务清单显式启停，`profiles` 对它无效）。

---

## 实施订正（2026-10-10，T3 开工时，人已裁决）

**① LLM 端点：wishub → 山海现网同源的 DeepSeek。** 本计划**全文**的 `WISHUB_API_KEY`
一律按 `DATA_LLM_API_KEY` 读，且**不新增凭据**——openclaw 服务级以 openship `sourceId`
引用 shanhai 项目级已有的同一条 env 条目（`env_Hhk3U8qYOqUaCJIA`，isSecret），值不回显、不复制。
端点 `https://api.deepseek.com/v1`、模型 `deepseek-flash`（与山海现网 `DATA_LLM_BASE_URL`/
`DATA_LLM_MODEL` 同源）。**理由**：组织内 12 个项目的 env 面逐项查过，**均无 wishub 凭据可取**；
原定 wishub 只是「配置形状循 data-analysis 先例」，非客户硬要求。spec 已同步订正
（§5 配置块 / §6 前提 / §7 openship / §10 验收 4 / §11 #2、#6）。

**② `DATA_API_BASE` 是本项目唯一 URL 键。** 本计划早期版本的 `DATA_QUERY_URL` 是**过时项**，
已删除：插件读的是 compose 给的 `DATA_API_BASE`（`http://server:13000/api/modules/data`）。

**③ 服务级 env 写入是整表替换。** `put_projects_by_id_services_by_serviceId_env` 语义是
**替换**该服务的整份 vars（不是 upsert）——写入前必须先 `get_..._env` 读回现有键再合并，
否则会清掉同服务上别的键。

**④ `WECOM_BOT_SECRET` 推迟到 T6 注入。** 客户交付前无值，写空值等同「清空」且会让
openclaw.json 的 `${WECOM_BOT_SECRET}` 插值解析成空串；T6 Step 1 拿到后一次性注入。

---

## 开工前置（编排者做）

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "feat(openclaw): shanhai 企微问数 bot——compose 单元 A + data-query 插件（通道 C 部署面）" \
  --body "spec: docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md
plan: docs/superpowers/plans/2026-10-10-shanhai-openclaw-wecom.md

新起自营 OpenClaw（单元 A compose + 随仓插件），企微智能机器人长连接接入，
对话身份=企微 userid→平台授权核心按人裁决；流式显式开启。data-analysis 零接触。"
```

记下 issue 号 `<N>`：PR body 末行 `Closes #<N>`。分支沿用当前 `ylwzzs/openclaw-接入`（已含 spec/plan 两个 docs 提交；push 前 `git fetch origin main` 确认基线）。

## 文件结构（新增/修改全量）

| 文件 | 职责 | 任务 |
|---|---|---|
| `deploy/openclaw/data-query-plugin/lib.js` | 纯逻辑：参数归一 + 平台调用 + 错误文案映射（无 SDK import，node --test 直跑） | T1 |
| `deploy/openclaw/data-query-plugin/lib.test.js` | `node --test` 单测（归一/fail-closed/头/各状态码映射） | T1 |
| `deploy/openclaw/data-query-plugin/index.js` | OpenClaw 入口：`definePluginEntry` + 两个 factory 工具 | T1 |
| `deploy/openclaw/data-query-plugin/openclaw.plugin.json` | 插件 manifest（contracts.tools / activation / skills） | T1 |
| `deploy/openclaw/data-query-plugin/package.json` | 包声明（`openclaw.extensions: ["./index.js"]`） | T1 |
| `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` | 教模型：先 list_metrics 再 query_data + 汇报纪律 | T1 |
| `deploy/openclaw/data-query-plugin/README.md` | 插件说明 + 运维指针 | T1 |
| `deploy/docker-compose.yml` | 新增 `openclaw` 服务（profiles 关闭）+ `openclaw_state` 卷 | T2 |
| `.env.example` | 补 `DATA_API_BASE` / `WECOM_BOT_SECRET` / `OPENCLAW_GATEWAY_TOKEN` 声明（`WISHUB_API_KEY` 已并入 `DATA_LLM_API_KEY`，见实施订正①） | T2 |
| `docs/architecture.md` | §1.2 单元 A 服务表加 `openclaw` 行 | T2 |

---

### Task 1: 问数插件 `data-query-plugin`

**Files:**
- Create: `deploy/openclaw/data-query-plugin/lib.js`
- Create: `deploy/openclaw/data-query-plugin/lib.test.js`
- Create: `deploy/openclaw/data-query-plugin/index.js`
- Create: `deploy/openclaw/data-query-plugin/openclaw.plugin.json`
- Create: `deploy/openclaw/data-query-plugin/package.json`
- Create: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`
- Create: `deploy/openclaw/data-query-plugin/README.md`

**Interfaces:**
- Consumes: 平台 API（已在 #146 落地）——`GET {DATA_API_BASE}/metrics` → `{metrics:[…]}`；`POST {DATA_API_BASE}/query` body `{metricId,args}` → 200 `{status:'ok',subject,metricId,columns,rows,truncated}` / 401 `{error:'WECOM_USER_NOT_LINKED'|'CHANNEL_KEY_INVALID'}` / 403 denied / 502 error。请求头：`x-channel-key` + `x-wecom-userid`。
- Produces: OpenClaw 工具 `list_metrics()`、`query_data({metricId, args})`；env 契约 `DATA_API_BASE`（默认 `http://server:13000/api/modules/data`）、`DATA_WECOM_CHANNEL_KEY`。

- [ ] **Step 1: 写 `lib.js`（纯逻辑，先于测试对象存在骨架）**

```js
// lib.js — 问数插件纯逻辑（不 import openclaw SDK；node --test 可直跑）。
// 权限判定零逻辑：词表裁剪/主体钉死/fail-closed 全在平台授权核心（约束 6）。
// 这里只做三件事：参数归一（宿主 execute 的 params 形状有历史差异）、平台调用、错误文案映射。

export const DEFAULT_API_BASE = "http://server:13000/api/modules/data";
// 未关联指引指向的山海平台入口（只写文案，不含任何凭证）。
export const PLATFORM_ORIGIN = "https://platform.shanhaiyiguo.com";

// 宿主 execute 第二参历史上有三种形态：直传对象 / JSON 字符串 / 单键包裹
// （input|arguments|parameters）。生产先例实测（data-analysis data-query-plugin）：
// 不归一会让参数恒 undefined → 每次必现 missing 参数。
export function normalizeParams(raw) {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  for (const key of ["input", "arguments", "parameters"]) {
    const inner = obj[key];
    if (
      Object.keys(obj).length === 1 &&
      inner && typeof inner === "object" && !Array.isArray(inner)
    ) {
      return inner;
    }
  }
  return obj;
}

// 平台调用 + 错误映射。返回值直接作为工具结果交给模型（纯对象，OpenClaw 工具契约）。
// fetchImpl 参数注入便于单测；生产用全局 fetch。
export async function callPlatform(opts) {
  const { fetchImpl = fetch, apiBase = DEFAULT_API_BASE, channelKey, userId, path, method = "GET", body } = opts;
  if (!channelKey) {
    return { error: "渠道凭证未配置（openclaw 容器缺 DATA_WECOM_CHANNEL_KEY env），请联系管理员。" };
  }
  if (!userId) {
    return { error: "无法识别请求者身份（requesterSenderId 缺失）。出于权限安全不予查询，请重新发一条消息；仍失败请联系管理员。" };
  }
  let resp;
  try {
    resp = await fetchImpl(apiBase + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-channel-key": channelKey,
        "x-wecom-userid": userId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { error: "平台问数 API 不可达：" + ((e && e.message) || String(e)) };
  }
  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.status === 401 && data.error === "WECOM_USER_NOT_LINKED") {
    return {
      code: "WECOM_USER_NOT_LINKED",
      error: `你的企微账号还没关联平台账号：用企微扫码登录一次 ${PLATFORM_ORIGIN}（登录即完成关联，无需任何绑定操作），然后回来重新提问。`,
    };
  }
  if (resp.status === 401) {
    return { code: data.error || "CHANNEL_KEY_INVALID", error: "渠道认证失败（" + (data.error || "HTTP 401") + "），请联系管理员检查渠道凭证。" };
  }
  // 403 对「未授权」与「词表外」同文案（平台刻意不区分，避免存在性探针——三通道设计 §5 约束 3）。
  if (resp.status === 403) {
    return { code: "DENIED", error: "该查询不在你的可见范围内。可用指标先调 list_metrics 看（词表按人裁剪）。" };
  }
  if (resp.status === 502) {
    return { code: data.error || "WAREHOUSE", error: "数据仓库暂时不可用（" + (data.reason || data.error || "上游错误") + "），请稍后再试。" };
  }
  if (!resp.ok) {
    return { code: data.error, error: "平台返回 HTTP " + resp.status + (data.error ? "：" + data.error : "") };
  }
  return data;
}
```

- [ ] **Step 2: 写失败测试 `lib.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { callPlatform, normalizeParams } from "./lib.js";

test("normalizeParams：对象直传", () => {
  assert.deepEqual(normalizeParams({ metricId: "m1" }), { metricId: "m1" });
});
test("normalizeParams：JSON 字符串", () => {
  assert.deepEqual(normalizeParams('{"metricId":"m1"}'), { metricId: "m1" });
});
test("normalizeParams：单键包裹层剥开", () => {
  assert.deepEqual(normalizeParams({ input: { metricId: "m1" } }), { metricId: "m1" });
  assert.deepEqual(normalizeParams({ arguments: { metricId: "m1" } }), { metricId: "m1" });
});
test("normalizeParams：垃圾输入回空对象", () => {
  assert.deepEqual(normalizeParams("not json"), {});
  assert.deepEqual(normalizeParams(null), {});
  assert.deepEqual(normalizeParams([1, 2]), {});
});

function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status < 400, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const BASE = { apiBase: "http://x/api", channelKey: "k", userId: "u1", path: "/query" };

test("缺渠道凭证：不发请求直接报错", async () => {
  const f = stubFetch(200, {});
  const r = await callPlatform({ ...BASE, fetchImpl: f, channelKey: "" });
  assert.match(r.error, /渠道凭证/);
  assert.equal(f.calls.length, 0);
});
test("缺 userid：fail-closed 不发请求", async () => {
  const f = stubFetch(200, {});
  const r = await callPlatform({ ...BASE, fetchImpl: f, userId: "" });
  assert.match(r.error, /身份/);
  assert.equal(f.calls.length, 0);
});
test("请求头带 x-channel-key 与 x-wecom-userid", async () => {
  const f = stubFetch(200, { metrics: [] });
  await callPlatform({ ...BASE, fetchImpl: f, path: "/metrics" });
  assert.equal(f.calls[0].init.headers["x-channel-key"], "k");
  assert.equal(f.calls[0].init.headers["x-wecom-userid"], "u1");
  assert.equal(f.calls[0].init.method, "GET");
});
test("401 WECOM_USER_NOT_LINKED → 扫码指引", async () => {
  const f = stubFetch(401, { error: "WECOM_USER_NOT_LINKED" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.code, "WECOM_USER_NOT_LINKED");
  assert.match(r.error, /扫码登录/);
});
test("403 → 文案指回 list_metrics", async () => {
  const f = stubFetch(403, { status: "denied" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.match(r.error, /list_metrics/);
});
test("502 → 仓库侧文案", async () => {
  const f = stubFetch(502, { error: "warehouse_transient" });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.match(r.error, /仓库/);
});
test("200 → ok 回包原样透传（含 subject）", async () => {
  const f = stubFetch(200, { status: "ok", subject: "shanhaiyiguo-org", columns: ["d"], rows: [[1]] });
  const r = await callPlatform({ ...BASE, fetchImpl: f });
  assert.equal(r.status, "ok");
  assert.equal(r.subject, "shanhaiyiguo-org");
});
```

- [ ] **Step 3: 跑测试确认绿（纯函数先行，无需红-绿循环的失败态——本步验证契约本身）**

Run: `cd deploy/openclaw/data-query-plugin && node --test lib.test.js`
Expected: 全部 PASS（0 fail）。

- [ ] **Step 4: 写入口 `index.js`**

```js
// index.js — OpenClaw native plugin 入口。
// 为什么是 native plugin：核心只给 native plugin 注入 toolContext.requesterSenderId（可信企微
// userid），不透传给 mcp.servers（2026-09-21 三通道设计 §4 硬约束，data-analysis 实测）。
// 注册形式：api.registerTool(factory, { name })——name 必须放第二参 metadata；factory 每轮调用，
// 从 ctx.requesterSenderId 取当轮可信 userid，execute 闭包捕获。
// ⚠️ execute 签名 (toolCallId, params, signal, onUpdate)：第一参是 toolCallId 不是模型参数。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callPlatform, normalizeParams, DEFAULT_API_BASE } from "./lib.js";

const CHANNEL_KEY = process.env.DATA_WECOM_CHANNEL_KEY || "";
// 同一轮后续工具调用 ctx.requesterSenderId 偶发为空的兜底（对齐生产先例实测行为）。
let lastUserId = "";

const LIST_DEF = {
  name: "list_metrics",
  description:
    "列出当前用户可见的问数指标（词表按人裁剪）。不确定有哪些指标、指标 id 或参数时先调它；以返回为准，不要凭记忆猜指标。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const QUERY_DEF = {
  name: "query_data",
  description:
    "按指标查数：metricId 来自 list_metrics；args 按该指标的参数说明给（日期一律 YYYY-MM-DD）。回包带 subject（本次钉死的数据主体）与 columns/rows；truncated=true 表示截断，改用聚合口径。",
  parameters: {
    type: "object",
    properties: {
      metricId: { type: "string", description: "指标 id（来自 list_metrics）" },
      args: {
        type: "object",
        description: "指标参数键值对（如日期范围），以 list_metrics 返回的参数说明为准",
        additionalProperties: true,
      },
    },
    required: ["metricId"],
    additionalProperties: false,
  },
};

export default definePluginEntry({
  id: "data-query",
  name: "Data Query",
  description: "问数通道 C：可信企微 userid + 渠道凭证 → 平台问数 API；权限由平台授权核心按人裁决。",
  register(api) {
    const apiBase = process.env.DATA_API_BASE || DEFAULT_API_BASE;
    const factory = (def, run) => (ctx) => {
      const userId = (ctx && ctx.requesterSenderId) || lastUserId;
      if (userId) lastUserId = userId;
      return {
        ...def,
        execute: (_toolCallId, params) => run(normalizeParams(params), userId),
      };
    };
    api.registerTool(
      factory(LIST_DEF, (_params, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/metrics" }),
      ),
      { name: LIST_DEF.name },
    );
    api.registerTool(
      factory(QUERY_DEF, (params, userId) =>
        callPlatform({
          apiBase,
          channelKey: CHANNEL_KEY,
          userId,
          path: "/query",
          method: "POST",
          body: { metricId: params.metricId, args: params.args ?? {} },
        }),
      ),
      { name: QUERY_DEF.name },
    );
  },
});
```

- [ ] **Step 5: 写 `openclaw.plugin.json`**

```json
{
  "id": "data-query",
  "name": "Data Query",
  "description": "问数通道 C：可信企微 userid + 渠道凭证 → 平台问数 API；权限由平台授权核心按人裁决。",
  "version": "0.1.0",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },
  "activation": { "onStartup": true },
  "contracts": { "tools": ["list_metrics", "query_data"] },
  "skills": ["./skills"]
}
```

- [ ] **Step 6: 写 `package.json`**

```json
{
  "name": "openclaw-plugin-data-query",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "问数通道 C 插件——可信企微 userid 转发平台问数 API（platform-core 授权核心按人裁决）。",
  "scripts": {
    "test": "node --test lib.test.js"
  },
  "files": ["index.js", "lib.js", "skills", "openclaw.plugin.json", "README.md"],
  "peerDependencies": {
    "openclaw": ">=2026.3.28"
  },
  "openclaw": {
    "extensions": ["./index.js"]
  }
}
```

- [ ] **Step 7: 写 `skills/data-query/SKILL.md`**

```markdown
---
name: data-query
description: 平台问数。用户问业务数据（销售额/订单/商品/门店/趋势等）时激活：先 list_metrics 看可见词表，再 query_data 查数，用表格/要点汇报。
metadata:
  openclaw:
    emoji: "📊"
---

# 平台问数 Skill

用户问**业务数据**时使用。权限由平台按当前对话人实时裁决——你能看到的词表就是这个人能问的全部。

## 用法

1. **先 `list_metrics()`**：看当前用户可见的指标（id/名称/参数说明）。词表按人裁剪且随权限实时变——**以返回为准，勿凭记忆**。
2. **再 `query_data({ metricId, args })`**：args 按该指标的参数说明给，日期一律 `YYYY-MM-DD`。
3. 回包里 `subject` 是本次钉死的数据主体（汇报时顺带说明数据范围）；`columns`/`rows` 是列名与行；`truncated=true` 表示被截断——改用聚合口径或缩小日期范围重查，不要把截断结果当全量。

## 汇报与行为

- **调工具前先说一句要查什么**（如「我查一下上周销售额」）——用户立刻能看到进度，不用干等。
- 数据用 markdown 表格 + 一句话结论；该范围没有数据就如实说，**不要编数**。
- `error` 带「扫码登录」= 对话人还没关联平台账号：把指引原样转告即可，**不要重试**。
- `error` 提示不在可见范围 = 权限如此：如实转告，**不要换词试探其他指标**。
```

- [ ] **Step 8: 写 `README.md`**

```markdown
# data-query-plugin（问数通道 C 客户端）

OpenClaw native tool-plugin：把可信企微 userid（`toolContext.requesterSenderId`）+ 渠道凭证
转发到平台问数 API，权限由 platform-core 授权核心按人裁决（词表裁剪/主体钉死/fail-closed）。
本插件**零权限逻辑**。

设计：`docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md`。

## 工具

| 工具 | 作用 |
|---|---|
| `list_metrics` | `GET {DATA_API_BASE}/metrics`——当前用户可见词表（按人裁剪） |
| `query_data` | `POST {DATA_API_BASE}/query` `{metricId,args}`——查数，回包带 subject |

## env 契约（容器注入）

| 键 | 说明 |
|---|---|
| `DATA_API_BASE` | 平台问数 API 基址；缺省 `http://server:13000/api/modules/data`（同 compose 网络服务名） |
| `DATA_WECOM_CHANNEL_KEY` | 渠道服务凭证；与 platform `server` 服务的同名 env **同值**（openship env isSecret） |

## 本地测试

```bash
node --test lib.test.js
```

## 部署

插件源码随仓分发：compose 把本目录只读挂载到容器 `/opt/plugins/data-query-plugin`，
容器内 `openclaw plugins install -l /opt/plugins/data-query-plugin` 一次性注册（写进 state 卷的
openclaw.json，跨部署持久）；部署更新代码后重启容器即生效。
初始化步骤见计划 Task 4（openship exec 操作）。
```

- [ ] **Step 9: 全量验证**

Run: `cd deploy/openclaw/data-query-plugin && node --test lib.test.js && node --check index.js && node --check lib.js`
Expected: 测试全 PASS；`node --check` 无输出（语法 OK）。

- [ ] **Step 10: 提交**

```bash
git add deploy/openclaw/data-query-plugin
git commit -m "feat(openclaw): data-query 插件——通道 C 薄转发（可信 userid→平台问数 API）"
```

---

### Task 2: compose 服务 + env 模板 + 架构文档（同 PR）

**Files:**
- Modify: `deploy/docker-compose.yml`（`services:` 末尾加 `openclaw`；`volumes:` 加 `openclaw_state`）
- Modify: `.env.example`（数据面声明区追加「问数 bot」块：`DATA_API_BASE`/`WECOM_BOT_SECRET`/
  `OPENCLAW_GATEWAY_TOKEN` 三键；均注释态，仅声明键名——B9 门禁只扫 `.ts/.tsx`，这几键不由 TS 代码读取，
  故**可以**注释掉，但仍要声明，理由见该块注释。**LLM key 不新增**：复用上方已声明的
  `DATA_LLM_API_KEY`，见实施订正①）
- Modify: `docs/architecture.md:20`（§1.2 服务表）

**Interfaces:**
- Consumes: Task 1 的插件目录（只读挂载 `./openclaw/data-query-plugin`——**相对 compose 文件所在的 `deploy/` 解析**，
  即 `deploy/openclaw/data-query-plugin/`。写成 `../openclaw/…` 会解析到仓根 `openclaw/`（不存在），
  且首段不以 `.` / `/` 开头会被 compose 当成**命名卷** ⇒ `refers to undefined volume` 直接起不来）。
- Produces: compose 服务名 `openclaw`（Task 3/4 的 openship 操作对象）；容器 env `DATA_API_BASE`（默认 `http://server:13000/api/modules/data`）、`DATA_WECOM_CHANNEL_KEY`、`DATA_LLM_API_KEY`、`WECOM_BOT_SECRET`（后三者来自 env_file/openship 注入）。

- [ ] **Step 1: `deploy/docker-compose.yml` 加服务（放在 `mb-proxy` 之后、顶层 `volumes:` 之前）**

```yaml
  # 问数 bot（通道 C，spec 2026-10-10）：企微智能机器人 WebSocket 长连接 → 平台问数 API。
  # **profiles 只是本机 docker compose 的默认启停语义，不是部署闸门**（同 mb-proxy 的教训）：
  # openship 按自己的服务清单逐服务显式启停 ⇒「仅 shanhai 启用」的闸门 = openship 服务级
  # enabled：platform-core-shanhai 项目置 true（先备 env），mytech platform-core 项目保持 false。
  # 插件源码随仓只读挂载（部署即更新）；state（openclaw.json/workspace）走命名卷跨部署持久。
  # 版本钉死见 spec §3（GitHub releases 为事实源；digest 绝不手改）。
  openclaw:
    image: ghcr.io/openclaw/openclaw@sha256:7f10d5cc975a90b65192eaa099454fe33ce8ce2390806c61c65cd868e9ef730d # v2026.9.9
    profiles: ['openclaw']
    env_file:
      - path: ../.env
        required: false
    environment:
      # 平台问数 API 基址：同 compose 网络走服务名（本地与生产一致，不出公网）。
      DATA_API_BASE: http://server:13000/api/modules/data
      # ── 状态/工作目录与网关：照 data-analysis 生产先例显式钉死，不依赖镜像默认值 ──
      # 镜像 Env 里既无 HOME 也无 OPENCLAW_*，状态目录只靠 os.homedir() 兜底（未验证）；
      # 而 Task 4 要按 OPENCLAW_CONFIG_PATH 去 seed openclaw.json，是压秤的假设 ⇒ 显式写死。
      # ⚠️ 不在此列 OPENCLAW_GATEWAY_TOKEN：`${VAR:-}` 取的是 shell/项目 .env，取不到会**以空值
      # 覆盖 env_file** 注入；token 一律由 env_file(../.env) 或 openship env 注入，不经这里。
      HOME: /home/node
      OPENCLAW_HOME: /home/node
      OPENCLAW_STATE_DIR: /home/node/.openclaw
      OPENCLAW_CONFIG_PATH: /home/node/.openclaw/openclaw.json
      OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace
      OPENCLAW_GATEWAY_PORT: '18789'
      OPENCLAW_GATEWAY_BIND: lan
      OPENCLAW_GATEWAY_MODE: local
    volumes:
      - openclaw_state:/home/node/.openclaw
      - ./openclaw/data-query-plugin:/opt/plugins/data-query-plugin:ro
    ports:
      # Gateway Control UI（运维用），只回环（B7 规则二）。
      - '127.0.0.1:18789:18789'
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
    restart: unless-stopped
```

顶层 `volumes:` 块改为：

```yaml
volumes:
  pgdata:
  openclaw_state:
```

- [ ] **Step 2: `.env.example` 追加（放在 `DATA_METABASE_SECRET_KEY=` 行之后）**

```bash
# ── 问数 bot（通道 C，openclaw 服务；仅 platform-core-shanhai 项目启用）──
# 平台问数 API 基址：compose 已定 http://server:13000/api/modules/data，一般无需设。
# DATA_API_BASE=
# LLM 提供商 key 不新增：openclaw 复用上方已声明的 DATA_LLM_API_KEY（服务级 sourceId 引用）。
# 端点/模型同样与山海现网同源（api.deepseek.com/v1 + deepseek-flash），见实施订正①。
# 企微智能机器人 secret。取法：客户企微后台「管理工具→智能机器人→API模式创建→通过长连接配置」交付。
# WECOM_BOT_SECRET=
# Gateway Control UI token（非必设，不设则回环口无鉴权）。取法：openship env(isSecret) 生成。
# ⚠️ 只走 env_file/openship 注入；不要在 compose 的 environment 里写 ${OPENCLAW_GATEWAY_TOKEN:-}
# （取不到会以空值覆盖 env_file 注入）。
# OPENCLAW_GATEWAY_TOKEN=
```

（`DATA_WECOM_CHANNEL_KEY=` 已在 L50 声明，**不重复加**；openclaw 服务与 server 服务共用同值。）

- [ ] **Step 3: `docs/architecture.md` §1.2 服务表更新**

`部署单元 A（deploy/docker-compose.yml）的两个服务：` 改为 `部署单元 A（deploy/docker-compose.yml）的服务：`，表格追加一行：

```markdown
| `openclaw` | **问数 bot（通道 C）**：`ghcr.io/openclaw/openclaw`（digest 钉 v2026.9.9，spec §3），`profiles: ['openclaw']` 本机默认不起；**仅 platform-core-shanhai 项目在 openship 服务级启用**（mytech 项目保持 disabled）。企微智能机器人 WebSocket 长连接接入；插件 `deploy/openclaw/data-query-plugin/` 随仓只读挂载。设计 `docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md` |
```

- [ ] **Step 4: 跑守卫 + compose 校验**

```bash
npx tsx scripts/check-compose.mjs && npx tsx scripts/check-env-example.mjs
docker compose -f deploy/docker-compose.yml config --quiet && echo COMPOSE-OK
```
Expected: `check-compose: OK`、`check-env-example: OK`、`COMPOSE-OK`。

- [x] **Step 5: 本地起服务冒烟 —— 本机跳过，改服务器侧验（编排者裁定，2026-10-10）**

**跳过原因（实测）**：本机到 ghcr CDN 的**直连吞吐 31 KB/s** ⇒ 1261.8 MB 的 arm64 镜像约需 **11 小时**
（本机 Docker Desktop 未配代理，守护进程直拉）；经本机代理 `127.0.0.1:7897` 为 2.39 MB/s（约 9 分钟），
但为一次性冒烟改本机 Docker 守护进程代理配置不值得、也不该碰。**Step 5 不是代码正确性证据**——
它只是「镜像能起 + healthz 200」的运行时确认，而这在 Task 3 的服务器侧 refresh 部署里会以**更硬的方式**
验到（openship 部署产物 + 容器创建时间 > 镜像构建时间 + healthz 探活）。

本地能做的替代验证（**已做**）：
```bash
npx tsx scripts/check-compose.mjs && npx tsx scripts/check-env-example.mjs   # 守卫
docker compose -f deploy/docker-compose.yml --profile openclaw config --quiet  # 解析
docker compose -f deploy/docker-compose.yml --profile openclaw config --format json  # 抽验解析结果
```
`config` 已确认：openclaw 的 `environment` 九个键齐全、`ports` 为 `127.0.0.1:18789`、
挂载解析为绝对路径 `…/deploy/openclaw/data-query-plugin`（**证明短语法被当作 bind 而非命名卷**——
即本 Step 修复的那个坑）。

- [ ] **Step 6: 跑仓库级门禁面（本地近似）**

```bash
pnpm typecheck && pnpm test:guard
```
Expected: 全绿（本任务不触碰 TS 代码，这是防误伤的回归确认）。

- [ ] **Step 7: 提交 + PR**

```bash
git add deploy/docker-compose.yml .env.example docs/architecture.md \
        docs/superpowers/plans/2026-10-10-shanhai-openclaw-wecom.md
git commit -m "feat(openclaw): 单元 A 加 openclaw 服务（profiles 关闭，仅 shanhai 项目启用）"
git push -u origin ylwzzs/openclaw-接入
gh pr create --fill --body "Closes #<N>

spec: docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md
plan: docs/superpowers/plans/2026-10-10-shanhai-openclaw-wecom.md"
```

等 CI **CLEAN** 才合（merge 只等 CLEAN——UNSTABLE 强合出过生产 502）。

---

### Task 3（ops，openship MCP）: merge 后接线——先保 mytech，再备 shanhai

**前置：** Task 2 的 PR 已 merge（mytech `platform-core` 项目会自动部署本次 main）。

**Interfaces:**
- Produces: shanhai 项目 openclaw 服务行 enabled=true + env 注入齐备；mytech 项目 openclaw 行 enabled=false；`DATA_WECOM_CHANNEL_KEY`（自生成随机值，两服务同值）。

- [ ] **Step 1: merge 后**立即**核查 mytech 项目服务行**

openship MCP：`get_projects`（platform-core）→ `get_projects_by_id_services`（proj_v0QZ68VYDc0pkFxL）→ 找 `openclaw` 行。
若 `enabled !== false`：`patch_projects_by_id_services_by_serviceId` 置 `enabled: false`。
判据：该行 enabled=false；mytech 侧容器 `docker ps` 无 openclaw（可 `post_projects_by_id_services_containers` 验证）。

- [ ] **Step 2: 生成渠道凭证并注入 shanhai 两服务**

本机生成（值只进 openship，不进任何文件/聊天）：

```bash
openssl rand -hex 32
```

openship MCP：platform-core-shanhai（proj_GLXUtN2bJ92DpPrS）→
两服务的 env 写入均为**整表替换**语义（先 `get_..._env` 读回现有键再合并，见实施订正③）：
- `server` 服务（svc_zdxMxawfymf9u5ST）：`DATA_WECOM_CHANNEL_KEY=<值>`（isSecret）
- `openclaw` 服务（svc_3R9wVrQSz__9nwgc）：`DATA_WECOM_CHANNEL_KEY=<同值>`（isSecret）+
  `DATA_LLM_API_KEY`（**`sourceId: env_Hhk3U8qYOqUaCJIA` 引用项目级同一条，不带值**）
- `WECOM_BOT_SECRET` **此处不写**（实施订正④：空值等同清空 ⇒ 推迟到 T6 Step 1 客户交付后注入）

- [ ] **Step 3: shanhai 项目启用 openclaw 并 env-only refresh**

`patch_projects_by_id_services_by_serviceId`（openclaw 行，enabled: true）→ 触发 refresh 部署（`post_deployments_build_access` 带 `refresh: true` + `serviceIds: [server, openclaw]`，env-only 重建秒级）。

- [ ] **Step 4: 部署后验证（deploy-verify 规则：进容器验，不信探活）**

server exec（shanhai server）：
```sh
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep openclaw
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'server|openclaw'
```
Expected: openclaw 容器存在且 `Up (healthy)`；server 容器创建时间新于 refresh 时刻。
镜像拉取失败 → 上服务器跑 `docker info --format '{{range .RegistryConfig.Mirrors}}{{println .}}{{end}}'` 应无输出（mirror 残留会压过 proxy，team-harness `check-docker-mirror.sh` 巡检清理）。

---

### Task 4（ops，openship exec）: 容器内初始化——插件注册 + openclaw.json seed

**Interfaces:**
- Consumes: Task 3 的健康容器；客户交付的 `botId`（secret 走 env `${WECOM_BOT_SECRET}` 插值）。
- Produces: state 卷内 openclaw.json（channel/模型/流式配置齐备）；插件已注册。

- [ ] **Step 1: 容器内注册插件（一次性，写 state 卷持久）**

```sh
openclaw plugins install -l /opt/plugins/data-query-plugin && openclaw plugins list && openclaw skills list
```
Expected: `data-query` 出现在 plugins list；`data-query` skill 出现在 skills list。
⚠️ 卸载注意（生产先例教训）：`plugins uninstall --force` 会残留 `plugins.load.paths` 导致 gateway 起不来——卸载必须 `openclaw doctor --fix` 或手清 openclaw.json。

- [ ] **Step 2: seed openclaw.json（botId 值从客户拿到后填入 `<BOT_ID>`；secret 用 `${WECOM_BOT_SECRET}` 插值引用容器 env）**

```sh
cat > /home/node/.openclaw/openclaw.json <<'EOF'
{
  channels: {
    wecom: {
      enabled: true,
      connectionMode: "websocket",
      botId: "<BOT_ID>",
      secret: "${WECOM_BOT_SECRET}",
      sendThinkingMessage: true,
      streaming: { block: { enabled: true } },
    },
  },
  models: {
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "${DATA_LLM_API_KEY}",
        models: [{ id: "deepseek-flash", name: "deepseek-flash", contextWindow: 128000, maxTokens: 8192 }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-flash" },
      // 流式三件套（spec §6）：核心默认 off＝全量憋话，显式开块流式 + 节奏 + 禁拟人停顿
      blockStreamingDefault: "on",
      blockStreamingBreak: "text_end",
      blockStreamingChunk: { minChars: 120, maxChars: 800, breakPreference: "paragraph" },
      blockStreamingCoalesce: { minChars: 200, idleMs: 800 },
      humanDelay: { mode: "off" },
    },
  },
}
EOF
```

（此步骤经 openship exec 在 openclaw 容器内执行；json5 带注释需在 heredoc 里去掉注释——**执行时删除上面中文注释行**，json5 支持注释但稳妥起见不留。）

- [ ] **Step 3: 重启 gateway 并验证配置生效**

```sh
openclaw gateway restart && sleep 5 && openclaw doctor
```
Expected: doctor 无 config 报错；`${DATA_LLM_API_KEY}` 插值被识别（doctor 或 Control UI 显示 key 来自环境变量）。
`${WECOM_BOT_SECRET}` 此时**尚未注入**（实施订正④）⇒ wecom 通道段会报缺值、WS 连接重连失败刷日志——
**属预期**，T6 建好 bot 并注入 secret 即消。
**若插值不被识别**（doctor 报 key 缺失/字面量原样出现）：fallback——经 exec 用 `sed -i` 把字面量替换为真实值（值从 openship env 读，操作时确保命令不回显），并在本计划与 spec 的待核实表记录「env 插值不可用，已用字面量 + 卷权限收口」。
企微 WS 连接在 botId/secret 齐备前会重连失败刷日志——属预期，Task 6 建好 bot 即消。

- [ ] **Step 4: 验证插件加载与流式配置**

```sh
openclaw plugins inspect data-query --runtime && openclaw config get agents.defaults.blockStreamingDefault
```
Expected: 插件 runtime 正常（tools: list_metrics/query_data）；config 返回 `on`。

---

### Task 5（ops，openship exec）: 平台探针 + 词表分档实测

**Interfaces:**
- Consumes: Task 3 注入的 `DATA_WECOM_CHANNEL_KEY` 值（操作者生成时已知）；一个已扫码登录过山海平台的企微 userid（关联验证）。

- [ ] **Step 1: 探针（shanhai server exec；`$KEY` 处代入 Task 3 Step 2 的值，注意不回显）**

```sh
KEY='<DATA_WECOM_CHANNEL_KEY 值>'
# ① 正确 key + 已关联 userid → 200 且带 subject（userid 用平台上实际管理员账号的企微 userid）
curl -s -X POST http://127.0.0.1:13000/api/modules/data/query -H 'Content-Type: application/json' -H "x-channel-key: ${KEY}" -H 'x-wecom-userid: <已关联userid>' -d '{"metricId":"<任一已登记指标>","args":{}}'
# ② 错 key → 401 CHANNEL_KEY_INVALID
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:13000/api/modules/data/query -H 'Content-Type: application/json' -H 'x-channel-key: wrong' -H 'x-wecom-userid: x' -d '{}'
# ③ 未关联 userid → 401 WECOM_USER_NOT_LINKED
curl -s -X POST http://127.0.0.1:13000/api/modules/data/query -H 'Content-Type: application/json' -H "x-channel-key: ${KEY}" -H 'x-wecom-userid: nobody-123' -d '{"metricId":"x","args":{}}'
# ④ 词表外指标 → 403（denied）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:13000/api/modules/data/query -H 'Content-Type: application/json' -H "x-channel-key: ${KEY}" -H 'x-wecom-userid: <已关联userid>' -d '{"metricId":"no-such-metric","args":{}}'
# ⑤ GET /metrics 同头 → 200 {metrics:[...]}
curl -s http://127.0.0.1:13000/api/modules/data/metrics -H "x-channel-key: ${KEY}" -H 'x-wecom-userid: <已关联userid>' | head -c 400
```
Expected: ①200+subject ②401 ③401+WECOM_USER_NOT_LINKED ④403 ⑤200。
①若 401 NOT_LINKED → 该 userid 未扫码登录过平台：请管理员先扫码登录一次再探。
执行后 `history -c` 或确认 exec 会话不留 key（openship exec 日志含命令文本——**用后考虑轮换该 key**，或在探针命令里从容器 env 读：`docker exec <server容器> printenv DATA_WECOM_CHANNEL_KEY` 取用不落盘）。

- [ ] **Step 2: 词表分档（spec §9）**

用 admin 会话（或 ⑤ 的返回）看词表：
- **非空且覆盖零售核心**（销售额/订单量/客单价等日粒度）→ 本任务只补漏，进 Task 6
- **空或明显不够** → 停：另开 issue「feat(data): shanhai 首批问数指标登记」，从湖 L1/L2 物化表接（走 metric-write 面），登记完成再进 Task 6。**不要**跳过词表直接端到端——bot 无词可问等于白验。

---

### Task 6（ops + 客户配合）: 企微建 bot + 端到端验收

**Interfaces:**
- Consumes: Task 4 的容器配置（botId 待填）、Task 5 的词表结论。

- [ ] **Step 1: 客户建智能机器人 + corpId 核对**

请客户在企微管理后台：**管理工具 → 智能机器人 → API 模式创建 → 通过长连接配置**，交付 `botId` + `secret`。
核对：机器人所在企业与 shanhai 租户 Casdoor 企微扫码 provider 同一企业（对照租户企微登录配置的 corpId；不一致则反查恒 401——发现不一致即停，回来对齐 provider）。
拿到后：secret 经 openship env upsert `WECOM_BOT_SECRET`（isSecret）→ openclaw 服务 env-only refresh；botId 经 exec 改 openclaw.json（Task 4 Step 2 的 `<BOT_ID>`）→ gateway restart。

- [ ] **Step 2: 长连接建立确认**

```sh
openclaw gateway status && docker logs <openclaw容器> --tail 50 2>&1 | grep -i 'websocket\|connected' | tail -5
```
Expected: WS 已连接、无重连风暴。企微后台机器人状态「在线」。

- [ ] **Step 3: 端到端（真机）**

1. 已关联账号私聊机器人：「我查一下近7天销售额」
   Expected: ≤2s 出「思考中」占位 → 首块文本（模型先说查什么）→ 数据表格流式补全。
   同时容器日志观察：`[plugin -> server] streamId=… finish=false` 多次 + `finish=true` 收尾（流式在跳）。
2. 未关联账号私聊：Expected: 扫码登录指引文案（不重试）。
3. 群聊 @机器人提问：Expected: 按提问者权限回答（不同权限成员问同一指标，可见性不同）。
4. 首条消息后在容器日志确认 requesterSenderId 形状 == Casdoor name（diag 行 `userId=…`；形状不符即停——身份链断了，回来对齐）。

- [ ] **Step 4: 流式体验硬指标（spec §10.3）**

| 指标 | 判据 | 取证 |
|---|---|---|
| 占位首响 | ≤2s | 发消息到「思考中」出现的体感 + 日志 onReplyStart 时间戳 |
| 首块文本 | 模型首响 + ~1s | 日志首个 `finish=false` 行时间戳 |
| LLM（DeepSeek）流式 | `stream:true` 出 delta | 若生成期间消息**无**中间更新 → 先验端点流式（`api.deepseek.com/v1` 客户端直连测 `stream:true`），不支持即换端点，**不是**调参能救的 |

- [ ] **Step 5: 审计落库验证**

shanhai postgres 容器 exec：
```sh
psql -U platform -d platform -c "SELECT * FROM data.query_audit ORDER BY 1 DESC LIMIT 5"
```
Expected: 本轮问数各有一行，channel=wecom（或等价通道标识）、身份/指标/行数/裁决齐备。

- [ ] **Step 6: 收尾**

- 验收结论 + 探针输出 + 流式取证回帖 issue `<N>`；全部通过后随 merge 自动关单。
- spec §11 风险表逐项销账（requesterSenderId 已实测、LLM 流式已实测、corpId 已核对）。
- 遗留（不阻塞）：mytech 项目 openclaw 行长期 disabled 的巡检口径 → 记入 deploy runbook；插件上游改进（非阻塞中间帧）→ 视 Step 4 实测卡顿与否决定是否提 PR。

---

## Self-Review 记录

- **Spec 覆盖**：§1 拓扑→T2；§2 链路→T1/T4/T5；§3 版本→T2 镜像行+T4 插件版本；§4 仓内改动→T1/T2；§5 配置→T4 Step 2；§6 流式→T4+T6 Step 4；§7 openship→T3；§8 企微→T6 Step 1；§9 词表→T5 Step 2；§10 验收→T5/T6；§11 风险→各任务处置内联；§12 不做→Global 1/6。无缺口。
- **占位符**：`<N>`/`<BOT_ID>`/`<已关联userid>` 是运行时注入值，均有「从哪取」的说明——非计划空洞。
- **类型一致性**：env 键名（`DATA_API_BASE`/`DATA_WECOM_CHANNEL_KEY`/`DATA_LLM_API_KEY`/`WECOM_BOT_SECRET`）与工具名（`list_metrics`/`query_data`）在 T1/T2/T3/T4 间逐字一致；API 形状与 `modules/data/routes/{query,metrics}.ts` 实文核对过。
