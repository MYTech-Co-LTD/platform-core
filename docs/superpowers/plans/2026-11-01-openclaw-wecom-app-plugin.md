# OpenClaw 企微自建应用插件（wecom-app）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给山海 openclaw bot 加 `wecom-app` native plugin：17 把企微自建应用（1000009）固定端点工具 + 使用人白名单（fail-closed）+ 随插件发布的 SKILL，让 agent 涉及企微内部功能时不再用 exec 硬试。

**Architecture:** 插件 = 纯逻辑 `lib.js`（env/白名单/错误映射/token/HTTP，node --test 直跑）+ `index.js`（数据驱动的 17 个工具 DEF + 注册，每把工具 execute 先过白名单门再透传 /cgi-bin）。凭据零明文：secret 经 `WECOM_APP_SECRET_FROM` 间接引用既有项目 env。部署走 Dockerfile COPY + 容器内 install + allowlist 三道门。

**Tech Stack:** Node ESM（无新依赖，Node 24 / `node --test`）/ OpenClaw plugin SDK（`definePluginEntry`、`api.registerTool`）/ openship MCP（部署接线）。

**设计 spec（唯一事实源）:** `docs/superpowers/specs/2026-11-01-openclaw-wecom-app-plugin-design.md`（§4 决策 D1–D10、§5 工具面、§7 错误文案、§9 实测证据）。

## Global Constraints（每个任务隐式继承）

- **凭据只经 env**：`WECOM_APP_SECRET` 直给或 `WECOM_APP_SECRET_FROM` 指名间接取（现配 `WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`）；secret/access_token 不进 openclaw.json、不进日志、不进工具回包。
- **白名单 fail-closed**：`ctx.requesterSenderId` 缺失或不在 `WECOM_APP_ALLOWED_USERS`（逗号分隔 userid）⇒ 返回固定拒绝文案，**零 API 调用**。
- **工具返回形状是硬契约**：一律 `{ content: [{type:"text", text}], details }`（data-query 真机实测：裸对象被判无效）。
- **contracts.tools = 注册名全集**：openclaw.plugin.json 的 `contracts.tools` 与 index.js 注册名双向一致，否则网关拒载（#989）。
- **实测形状不得凭想象改**：`create_doc` doc_type **10=智能表格**/4=电子表格/3=文档；`get_sheet` 回包在顶层 **`sheet_list`**；`add_records`/`update_records` 的 `records[].values` **键=字段标题（field_title）**、单元格 `{values:[{type:1,text|number}]}`；日程=**应用日历模型**（`oa/calendar/add`→cal_id→`schedule/add` 注入 `agentid`）；待办**无创建 API**。
- **lib.js 不 import openclaw SDK**（node --test 直跑）；index.js 不被单测 import（契约测试按源码文本提取）。
- **不动**：bot 通道、data-query 插件、`agents.entries.main.tools.allow` 既有 8 项、官方 wecom 插件的 hook 现状。
- **提交纪律**：Conventional Commits `feat(openclaw)/docs(openclaw)/chore(openclaw)`；本波走一个 issue（下文 `#1199` 为占位，**开工前建真实 issue 并全局替换**）+ 一个 PR（body 含 `Closes #<N>`）。
- 企微侧事实源：`https://qyapi.weixin.qq.com/cgi-bin/*`；出口 IP `113.249.104.181`（可信 IP 已配）。

---

### Task 1: `lib.js` 纯逻辑（TDD）

**Files:**
- Create: `deploy/openclaw/wecom-app-plugin/lib.js`
- Test: `deploy/openclaw/wecom-app-plugin/lib.test.js`

**Interfaces:**
- Consumes: 无（纯函数 + 注入式 fetch/now）。
- Produces（Task 2 的 index.js 全部消费，签名逐字如下）:
  - `DENIED_MESSAGE: string`、`NO_IDENTITY_MESSAGE: string`
  - `parseAllowedUsers(raw: unknown): string[]`
  - `isAllowed(users: string[], senderId: unknown): boolean`
  - `resolveSecret(env: object): { secret: string; source: string }`
  - `credentialsReady(env: object): boolean`
  - `mapError(errcode: number, errmsg: string): string`
  - `createTokenManager({corpId, secret, fetchImpl?, now?}): { get(): Promise<string> }`
  - `callWecom({token, path, method?, body?, fetchImpl?}): Promise<object>`（业务载荷或 `{errcode?, error}`）
  - `normalizeParams(raw: unknown): object`、`toToolResult(payload): {content:[{type:"text",text}], details}`

- [ ] **Step 1: 写失败测试**（新建 `lib.test.js`，完整内容）

```js
// lib.test.js — 纯逻辑单测。lib.js 不 import SDK，node --test 直跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DENIED_MESSAGE, NO_IDENTITY_MESSAGE,
  parseAllowedUsers, isAllowed, resolveSecret, credentialsReady, mapError,
  createTokenManager, callWecom, normalizeParams, toToolResult,
} from "./lib.js";

test("parseAllowedUsers：逗号分隔、去空白、去重、过滤空串", () => {
  assert.deepEqual(parseAllowedUsers("ZhangDuo, yangwei,,ZhangDuo"), ["ZhangDuo", "yangwei"]);
  assert.deepEqual(parseAllowedUsers(undefined), []);
  assert.deepEqual(parseAllowedUsers(""), []);
});

test("isAllowed：fail-closed——空 sender、空名单、未命中都拒", () => {
  const users = ["ZhangDuo", "yangwei"];
  assert.equal(isAllowed(users, "ZhangDuo"), true);
  assert.equal(isAllowed(users, "yangwei"), true);
  assert.equal(isAllowed(users, "DongJiJuan"), false);
  assert.equal(isAllowed(users, ""), false);
  assert.equal(isAllowed(users, undefined), false);
  assert.equal(isAllowed([], "ZhangDuo"), false);
});

test("resolveSecret：直给优先，其次 SECRET_FROM 指名，再无则空", () => {
  assert.deepEqual(resolveSecret({ WECOM_APP_SECRET: "s1" }), { secret: "s1", source: "WECOM_APP_SECRET" });
  assert.deepEqual(
    resolveSecret({ WECOM_APP_SECRET_FROM: "X", X: "s2" }),
    { secret: "s2", source: "X" },
  );
  assert.deepEqual(resolveSecret({ WECOM_APP_SECRET_FROM: "X" }), { secret: "", source: "" });
});

test("credentialsReady：corpId + secret 缺一即 false", () => {
  assert.equal(credentialsReady({ WECOM_APP_CORP_ID: "ww", WECOM_APP_SECRET: "s" }), true);
  assert.equal(credentialsReady({ WECOM_APP_CORP_ID: "ww", WECOM_APP_SECRET_FROM: "X", X: "s" }), true);
  assert.equal(credentialsReady({ WECOM_APP_CORP_ID: "ww" }), false);
});

test("mapError：固定文案表 + 参数类错误带 detail", () => {
  assert.match(mapError(48002, "api forbidden"), /未对企业应用开放/);
  assert.match(mapError(60020, "not allow to access from your ip"), /可信 ?IP/);
  assert.match(mapError(301002, "not allow operate another agent"), /凭据与应用不匹配/);
  assert.match(mapError(301085, "invalid docid"), /未对应用可见/);
  assert.match(mapError(2022004, "field not exists, hint: [x]"), /字段标题不存在/);
  assert.match(mapError(90457, "invalid calendar id, hint: [x]"), /应用自建日历/);
  assert.match(mapError(40058, "invalid Request Parameter, hint: [x]"), /参数形状不合法.*自纠一次/);
  assert.match(mapError(93017, "wrong json format"), /参数形状不合法/);
  assert.match(mapError(99999, "whatever, hint: [x]"), /99999/);
});

test("tokenManager：缓存复用（未到期不二次 gettoken）", async () => {
  let n = 0;
  const fakeFetch = async () => { n++; return { status: 200, json: async () => ({ errcode: 0, access_token: "T" + n, expires_in: 7200 }) }; };
  let t = 0;
  const tm = createTokenManager({ corpId: "ww", secret: "s", fetchImpl: fakeFetch, now: () => t });
  assert.equal(await tm.get(), "T1");
  assert.equal(await tm.get(), "T1"); // 命中缓存
  assert.equal(n, 1);
  t = (7200 - 300) * 1000 + 1; // 越过提前刷新线
  assert.equal(await tm.get(), "T2");
  assert.equal(n, 2);
});

test("tokenManager：并发单飞（同时 get 只发一次 gettoken）", async () => {
  let n = 0; let release;
  const gate = new Promise((r) => (release = r));
  const fakeFetch = async () => { n++; await gate; return { status: 200, json: async () => ({ errcode: 0, access_token: "T", expires_in: 7200 }) }; };
  const tm = createTokenManager({ corpId: "ww", secret: "s", fetchImpl: fakeFetch, now: () => 0 });
  const p1 = tm.get();
  const p2 = tm.get(); // 并发第二次：必须复用同一 inflight
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, "T"); assert.equal(b, "T"); assert.equal(n, 1);
});

test("tokenManager：gettoken 失败抛错带 errcode", async () => {
  const fakeFetch = async () => ({ status: 200, json: async () => ({ errcode: 40001, errmsg: "invalid credential" }) });
  const tm = createTokenManager({ corpId: "ww", secret: "bad", fetchImpl: fakeFetch, now: () => 0 });
  await assert.rejects(() => tm.get(), (e) => e.errcode === 40001 && /invalid credential/.test(e.message));
});

function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status, ok: status < 400, json: async () => body }; };
  fn.calls = calls;
  return fn;
}

test("callWecom：errcode 0 原样回业务载荷（含顶层 sheet_list）", async () => {
  const f = stubFetch(200, { errcode: 0, errmsg: "ok", sheet_list: [{ sheet_id: "q979lj" }] });
  const out = await callWecom({ token: "T", path: "wedoc/smartsheet/get_sheet", body: { docid: "d" }, fetchImpl: f });
  assert.deepEqual(out.sheet_list, [{ sheet_id: "q979lj" }]);
  assert.ok(f.calls[0].url.includes("access_token=T"));
});

test("callWecom：非零 errcode → {errcode, error:mapError}", async () => {
  const f = stubFetch(200, { errcode: 2022004, errmsg: "field not exists, hint: [x]" });
  const out = await callWecom({ token: "T", path: "wedoc/smartsheet/add_records", body: {}, fetchImpl: f });
  assert.equal(out.errcode, 2022004);
  assert.match(out.error, /字段标题不存在/);
});

test("callWecom：404 端点漂移与网络错误都有文案", async () => {
  const f404 = async () => ({ status: 404, json: async () => ({}) });
  assert.match((await callWecom({ token: "T", path: "oa/calendar/list", fetchImpl: f404 })).error, /端点不存在/);
  const fNet = async () => { throw new Error("boom"); };
  assert.match((await callWecom({ token: "T", path: "x", fetchImpl: fNet })).error, /不可达/);
});

test("normalizeParams / toToolResult：形状与 data-query 同律", () => {
  assert.deepEqual(normalizeParams('{"a":1}'), { a: 1 });
  assert.deepEqual(normalizeParams({ input: { a: 1 } }), { a: 1 });
  assert.deepEqual(normalizeParams("junk"), {});
  const r = toToolResult({ x: 1 });
  assert.equal(r.content[0].type, "text");
  assert.equal(JSON.parse(r.content[0].text).x, 1);
  assert.deepEqual(r.details, { x: 1 });
});

test("拒绝文案常量在（index.js 引用，防改名漂移）", () => {
  assert.match(DENIED_MESSAGE, /使用权限/);
  assert.match(NO_IDENTITY_MESSAGE, /requesterSenderId/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deploy/openclaw/wecom-app-plugin && node --test lib.test.js`
Expected: FAIL（`Cannot find module ./lib.js`）

- [ ] **Step 3: 写 `lib.js`（完整内容）**

```js
// lib.js — wecom-app 插件纯逻辑（不 import openclaw SDK；node --test 直跑）。
// 权限裁决全部在企微服务端；这里只做：env 解析、白名单门、token 管理、HTTP、错误文案映射。
// 实测依据 2026-11-01（spec §9）：见各常量注释。

export const DENIED_MESSAGE =
  "你没有企微应用能力的使用权限（需管理员把你的企微 userid 加入 WECOM_APP_ALLOWED_USERS 白名单）。";
export const NO_IDENTITY_MESSAGE =
  "无法识别请求者身份（requesterSenderId 缺失）。出于权限安全不予调用企微应用能力，请重新发一条消息。";
export const NO_CREDENTIALS_MESSAGE =
  "企微应用凭据未配置（缺 WECOM_APP_CORP_ID 或 secret/WECOM_APP_SECRET_FROM），请联系管理员。";

export const API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";

export function parseAllowedUsers(raw) {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export function isAllowed(users, senderId) {
  return typeof senderId === "string" && senderId.length > 0 && users.includes(senderId);
}

/** secret 直给（WECOM_APP_SECRET）优先；否则 WECOM_APP_SECRET_FROM 指名的 env（间接引用，零明文复制）。 */
export function resolveSecret(env = process.env) {
  if (env.WECOM_APP_SECRET) return { secret: env.WECOM_APP_SECRET, source: "WECOM_APP_SECRET" };
  const from = env.WECOM_APP_SECRET_FROM;
  if (from && env[from]) return { secret: env[from], source: from };
  return { secret: "", source: "" };
}

export function credentialsReady(env = process.env) {
  return Boolean(env.WECOM_APP_CORP_ID && resolveSecret(env).secret);
}

/** 固定文案表（spec §7；判读口径全部实测）。 */
const ERROR_COPY = [
  [48002, "该能力未对企业应用开放：请联系管理员在企微后台为应用（消息通知/1000009）开启对应 API 权限。"],
  [60020, "调用方 IP 不在企业可信 IP 内：请联系管理员把实例出口 IP 加入应用可信 IP。"],
  [301002, "应用凭据与应用不匹配（token 属于另一个应用）：请联系管理员检查 corpId/secret/agentId。"],
  [301085, "该文档未对应用可见：需要在企微文档里把它共享给应用，或改用应用自建表格（wecom_app_doc_create）。"],
  [2022004, "字段标题不存在：先调 wecom_app_sheet_fields 看真实字段标题——records 的键=字段标题（field_title），不是 field_id。"],
  [90457, "cal_id 无效：日程只能读写应用自建日历——先 wecom_app_calendar_create 拿 cal_id，成员个人日历不可寻址。"],
];

export function mapError(errcode, errmsg) {
  for (const [code, copy] of ERROR_COPY) if (errcode === code) return copy;
  const brief = String(errmsg || "").split(" hint:")[0].trim();
  if (errcode === 40058 || errcode === 93017) {
    return `参数形状不合法：${brief}（读 detail 自纠一次，不要原样重试）`;
  }
  return `企微 API 返回 ${errcode}：${brief}`;
}

/** gettoken 缓存：过期前 5 分钟刷新；并发单飞；失败抛带 errcode 的 Error。 */
export function createTokenManager({ corpId, secret, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  let inflight = null;
  return {
    async get() {
      if (cached && cached.expireAt > now()) return cached.token;
      if (inflight) return inflight;
      inflight = (async () => {
        const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
        const resp = await fetchImpl(url);
        const data = await resp.json().catch(() => ({}));
        if (!data.access_token) {
          const e = new Error(mapError(data.errcode ?? -1, data.errmsg));
          e.errcode = data.errcode;
          throw e;
        }
        cached = { token: data.access_token, expireAt: now() + (data.expires_in - 300) * 1000 };
        return cached.token;
      })().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/** 业务载荷原样回；非零 errcode → {errcode, error}；404/网络错误有固定文案。 */
export async function callWecom({ token, path, method = "POST", body, fetchImpl = fetch }) {
  let resp;
  try {
    resp = await fetchImpl(`${API_BASE}/${path}?access_token=${token}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { error: `企微 API 不可达：${e.message}` };
  }
  if (resp.status === 404) {
    return { error: `企微端点不存在（404）：${path}——插件与官方文档漂移，请联系维护者。` };
  }
  const data = await resp.json().catch(() => ({}));
  if (data.errcode === 0 || data.errcode === undefined) return data;
  return { errcode: data.errcode, error: mapError(data.errcode, data.errmsg) };
}

/** 宿主 execute 第二参历史形状：直传对象 / JSON 串 / 单键包裹（与 data-query 同律）。 */
export function normalizeParams(raw) {
  let obj = raw;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return {}; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  for (const key of ["input", "arguments", "parameters"]) {
    const inner = obj[key];
    if (Object.keys(obj).length === 1 && inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
  }
  return obj;
}

/** OpenClaw 工具结果契约：必须 {content:[{type:"text",text}], details}（data-query 2026-10-12 真机实测）。 */
export function toToolResult(payload) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
    details: payload,
  };
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd deploy/openclaw/wecom-app-plugin && node --test lib.test.js`
Expected: PASS（0 fail）

- [ ] **Step 5: Commit**

```bash
git add deploy/openclaw/wecom-app-plugin/lib.js deploy/openclaw/wecom-app-plugin/lib.test.js
git commit -m "feat(openclaw): wecom-app 纯逻辑 lib——白名单/env 间接引用/token/错误文案映射 (#1199)"
```

---

### Task 2: 插件脚手架 + `index.js`（17 工具）+ 契约测试

**Files:**
- Create: `deploy/openclaw/wecom-app-plugin/package.json`
- Create: `deploy/openclaw/wecom-app-plugin/openclaw.plugin.json`
- Create: `deploy/openclaw/wecom-app-plugin/index.js`
- Test: `deploy/openclaw/wecom-app-plugin/contracts.test.js`

**Interfaces:**
- Consumes: Task 1 的 lib 全部导出。
- Produces: 插件 id `wecom-app`；17 个工具名（`contracts.tools` 与 SKILL/allowlist 同名引用）：
  `wecom_app_status, wecom_app_departments, wecom_app_users, wecom_app_doc_create, wecom_app_sheet_sheets, wecom_app_sheet_fields, wecom_app_sheet_records, wecom_app_sheet_add_records, wecom_app_sheet_update_records, wecom_app_meetings, wecom_app_meeting_info, wecom_app_meeting_create, wecom_app_calendar_create, wecom_app_schedules, wecom_app_schedule_add, wecom_app_todo_get, wecom_app_todo_update`

- [ ] **Step 1: 写契约测试（先红）**

```js
// contracts.test.js — 网关契约回归（同 data-query #989 口径）：
// ① index.js 注册的工具名 ⊆ openclaw.plugin.json contracts.tools（漏登=网关拒载）；
// ② 两侧集合一致（无陈旧残留）；③ 防正则静默匹配零条的假绿（KNOWN 全集先断言）。
// index.js import openclaw SDK，node --test 无法加载 ⇒ 按源码文本提取（形状固定：name: "wecom_app_*"）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
const defNames = [...indexSrc.matchAll(/name:\s*"(wecom_app_[a-z_]+)"/g)].map((m) => m[1]);

const KNOWN_TOOLS = [
  "wecom_app_status", "wecom_app_departments", "wecom_app_users", "wecom_app_doc_create",
  "wecom_app_sheet_sheets", "wecom_app_sheet_fields", "wecom_app_sheet_records",
  "wecom_app_sheet_add_records", "wecom_app_sheet_update_records",
  "wecom_app_meetings", "wecom_app_meeting_info", "wecom_app_meeting_create",
  "wecom_app_calendar_create", "wecom_app_schedules", "wecom_app_schedule_add",
  "wecom_app_todo_get", "wecom_app_todo_update",
];

test("正则提取非空：17 个已知工具全部命中（防正则失配假绿）", () => {
  for (const n of KNOWN_TOOLS) assert.ok(defNames.includes(n), `没提取到 ${n}——DEF 形状变了先修提取`);
});

test("index.js 注册名 ⊆ contracts.tools（漏登=网关拒载）", () => {
  const declared = manifest.contracts?.tools ?? [];
  for (const n of defNames) assert.ok(declared.includes(n), `${n} 未登记 contracts.tools`);
});

test("contracts.tools 无陈旧残留（两侧集合一致）", () => {
  const declared = manifest.contracts?.tools ?? [];
  assert.deepEqual(declared.filter((n) => !defNames.includes(n)), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd deploy/openclaw/wecom-app-plugin && node --test contracts.test.js`
Expected: FAIL（找不到 index.js / openclaw.plugin.json）

- [ ] **Step 3: 写 `package.json` + `openclaw.plugin.json`**

`package.json`（对齐 data-query 体例）：

```json
{
  "name": "openclaw-plugin-wecom-app",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "企微自建应用（1000009）工具插件——通讯录/文档·智能表格/会议/应用日历/待办，按人白名单 fail-closed。",
  "scripts": { "test": "node --test" },
  "files": ["index.js", "lib.js", "skills", "openclaw.plugin.json", "README.md"],
  "peerDependencies": { "openclaw": ">=2026.3.28" },
  "openclaw": { "extensions": ["./index.js"] }
}
```

`openclaw.plugin.json`：

```json
{
  "id": "wecom-app",
  "name": "WeCom App Tools",
  "description": "企微自建应用能力：通讯录/文档·智能表格/会议/应用日历/待办。凭据走 env，使用人白名单 fail-closed，权限裁决在企微服务端。",
  "version": "0.1.0",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },
  "activation": { "onStartup": true },
  "contracts": {
    "tools": [
      "wecom_app_status", "wecom_app_departments", "wecom_app_users", "wecom_app_doc_create",
      "wecom_app_sheet_sheets", "wecom_app_sheet_fields", "wecom_app_sheet_records",
      "wecom_app_sheet_add_records", "wecom_app_sheet_update_records",
      "wecom_app_meetings", "wecom_app_meeting_info", "wecom_app_meeting_create",
      "wecom_app_calendar_create", "wecom_app_schedules", "wecom_app_schedule_add",
      "wecom_app_todo_get", "wecom_app_todo_update"
    ]
  },
  "skills": ["./skills"]
}
```

- [ ] **Step 4: 写 `index.js`（完整内容，数据驱动 17 工具）**

```js
// index.js — OpenClaw native plugin 入口（wecom-app）。
// 为什么 native plugin：只有它能拿到可信 ctx.requesterSenderId（MCP 通道拿不到）——白名单判定依赖它。
// 注册形式与 data-query 同律：api.registerTool(factory(def), { name })，factory 每轮调用、execute 闭包捕获。
// 实测形状（spec §9，勿凭想象改）：doc_type 10=智能表格；get_sheet→顶层 sheet_list；
// add/update_records 的 records[].values 键=字段标题；日程=应用日历（calendar/add→cal_id→schedule/add 注入 agentid）。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  DENIED_MESSAGE, NO_IDENTITY_MESSAGE, NO_CREDENTIALS_MESSAGE,
  parseAllowedUsers, isAllowed, resolveSecret, credentialsReady,
  createTokenManager, callWecom, normalizeParams, toToolResult,
} from "./lib.js";

const ALLOWED = parseAllowedUsers(process.env.WECOM_APP_ALLOWED_USERS || "");

/** 工具表：name/description 是模型可见面（写清形状与边界）；exec(params, call) 返回业务载荷或 {error}。 */
const TOOLS = [
  {
    name: "wecom_app_status",
    description: "企微应用自检：回应用身份（agentid/名称）与凭据就绪状态。排障第一步；不泄露 secret。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    exec: async (_p, call) => {
      const { source } = resolveSecret();
      const info = await call("agent/get", { agentid: Number(process.env.WECOM_APP_AGENT_ID || 0) }, "GET");
      return { ...info, credentials: { corpId: process.env.WECOM_APP_CORP_ID || "", agentId: process.env.WECOM_APP_AGENT_ID || "", secretSource: source, allowedUsers: ALLOWED } };
    },
  },
  {
    name: "wecom_app_departments",
    description: "列部门树（企业通讯录）。参数 id 可选（缺省根部门 1）。",
    parameters: { type: "object", properties: { id: { type: "number" } }, additionalProperties: false },
    exec: async (p, call) => call("department/list", { id: p.id ?? 1 }, "GET"),
  },
  {
    name: "wecom_app_users",
    description: "列某部门成员（含 userid/姓名/部门）。参数：department_id（数字，必填）、fetch_child（是否递归子部门，可选）。",
    parameters: { type: "object", properties: { department_id: { type: "number" }, fetch_child: { type: "number" } }, required: ["department_id"], additionalProperties: false },
    exec: async (p, call) => call("user/list", { department_id: p.department_id, fetch_child: p.fetch_child ?? 0 }, "GET"),
  },
  {
    name: "wecom_app_doc_create",
    description: "新建企微文档。doc_type：10=智能表格（默认，可配合 sheet 工具读写）、4=电子表格、3=普通文档。回 docid 与 url。应用自建文档天然对应用可见（无 301085 问题）。",
    parameters: { type: "object", properties: { doc_name: { type: "string" }, doc_type: { type: "number" } }, required: ["doc_name"], additionalProperties: false },
    exec: async (p, call) => call("wedoc/create_doc", { doc_name: p.doc_name, doc_type: p.doc_type ?? 10 }),
  },
  {
    name: "wecom_app_sheet_sheets",
    description: "列智能表格的子表。注意：回包在顶层 sheet_list（每项含 sheet_id/title）。新建的智能表格自带默认子表与默认字段。",
    parameters: { type: "object", properties: { docid: { type: "string" } }, required: ["docid"], additionalProperties: false },
    exec: async (p, call) => call("wedoc/smartsheet/get_sheet", { docid: p.docid }),
  },
  {
    name: "wecom_app_sheet_fields",
    description: "列某子表的字段定义（field_title/field_type/property）。写记录前必看——records 的键=field_title。",
    parameters: { type: "object", properties: { docid: { type: "string" }, sheet_id: { type: "string" } }, required: ["docid", "sheet_id"], additionalProperties: false },
    exec: async (p, call) => call("wedoc/smartsheet/get_fields", { docid: p.docid, sheet_id: p.sheet_id }),
  },
  {
    name: "wecom_app_sheet_records",
    description: "读智能表格记录（offset/limit 分页）。回 record_id 列表与 values。",
    parameters: { type: "object", properties: { docid: { type: "string" }, sheet_id: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["docid", "sheet_id"], additionalProperties: false },
    exec: async (p, call) => call("wedoc/smartsheet/get_records", { docid: p.docid, sheet_id: p.sheet_id, offset: p.offset ?? 0, limit: p.limit ?? 100 }),
  },
  {
    name: "wecom_app_sheet_add_records",
    description: "智能表格追加记录。records[].values 的键=字段标题（field_title，不是 field_id！），单元格形状 {values:[{type:1,text|number}]}。例：{docid,sheet_id,records:[{values:{文本:{values:[{type:1,text:\"x\"}]}}}]}。先 wecom_app_sheet_fields 看真实字段标题。",
    parameters: { type: "object", properties: { docid: { type: "string" }, sheet_id: { type: "string" }, records: { type: "array" } }, required: ["docid", "sheet_id", "records"], additionalProperties: false },
    exec: async (p, call) => call("wedoc/smartsheet/add_records", { docid: p.docid, sheet_id: p.sheet_id, records: p.records }),
  },
  {
    name: "wecom_app_sheet_update_records",
    description: "智能表格更新记录（按 record_id，来自 add 回包或 get_records）。values 键同 add=字段标题。写后用 wecom_app_sheet_records 回读验证。",
    parameters: { type: "object", properties: { docid: { type: "string" }, sheet_id: { type: "string" }, records: { type: "array" } }, required: ["docid", "sheet_id", "records"], additionalProperties: false },
    exec: async (p, call) => call("wedoc/smartsheet/update_records", { docid: p.docid, sheet_id: p.sheet_id, records: p.records }),
  },
  {
    name: "wecom_app_meetings",
    description: "列某成员时间窗内的会议 ID（userid + begin_time/end_time，unix 秒）。",
    parameters: { type: "object", properties: { userid: { type: "string" }, begin_time: { type: "number" }, end_time: { type: "number" } }, required: ["userid", "begin_time", "end_time"], additionalProperties: false },
    exec: async (p, call) => call("meeting/get_user_meetingid", { userid: p.userid, begin_time: p.begin_time, end_time: p.end_time }),
  },
  {
    name: "wecom_app_meeting_info",
    description: "会议详情（meetingid 来自 wecom_app_meetings）。",
    parameters: { type: "object", properties: { meetingid: { type: "string" } }, required: ["meetingid"], additionalProperties: false },
    exec: async (p, call) => call("meeting/get_info", { meetingid: p.meetingid }),
  },
  {
    name: "wecom_app_meeting_create",
    description: "创建预约会议。body 形状按官方文档 meeting/create（title/start_time/end_time/attendees 等）原样透传。",
    parameters: { type: "object", properties: { body: { type: "object", description: "meeting/create 请求体（官方文档形状）" } }, required: ["body"], additionalProperties: false },
    exec: async (p, call) => call("meeting/create", p.body),
  },
  {
    name: "wecom_app_calendar_create",
    description: "创建应用日历，回 cal_id。日程（schedule）只能挂在应用日历上——成员个人日历不可寻址（这是企微 API 边界，不是权限问题）。",
    parameters: { type: "object", properties: { summary: { type: "string" }, color: { type: "string" }, description: { type: "string" } }, required: ["summary"], additionalProperties: false },
    exec: async (p, call) => call("oa/calendar/add", { calendar: { summary: p.summary, color: p.color, description: p.description } }),
  },
  {
    name: "wecom_app_schedules",
    description: "列应用日历的日程（cal_id 必填——来自 wecom_app_calendar_create；不是 userid！成员日程查不了）。start_time/end_time unix 秒。",
    parameters: { type: "object", properties: { cal_id: { type: "string" }, start_time: { type: "number" }, end_time: { type: "number" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["cal_id", "start_time", "end_time"], additionalProperties: false },
    exec: async (p, call) => call("oa/schedule/get_by_calendar", { cal_id: p.cal_id, start_time: p.start_time, end_time: p.end_time, offset: p.offset ?? 0, limit: p.limit ?? 50 }),
  },
  {
    name: "wecom_app_schedule_add",
    description: "在应用日历建日程（cal_id 必填；summary/start_time/end_time unix 秒）。agentid 由插件注入，不用传。",
    parameters: { type: "object", properties: { cal_id: { type: "string" }, summary: { type: "string" }, start_time: { type: "number" }, end_time: { type: "number" }, description: { type: "string" } }, required: ["cal_id", "summary", "start_time", "end_time"], additionalProperties: false },
    exec: async (p, call) => call("oa/schedule/add", { agentid: Number(process.env.WECOM_APP_AGENT_ID || 0), schedule: { cal_id: p.cal_id, summary: p.summary, start_time: p.start_time, end_time: p.end_time, description: p.description } }),
  },
  {
    name: "wecom_app_todo_get",
    description: "获取待办详情（todo_id）。注意：企微没有「创建待办」服务端 API——只能读与改状态。",
    parameters: { type: "object", properties: { todo_id: { type: "string" } }, required: ["todo_id"], additionalProperties: false },
    exec: async (p, call) => call("todo/get", { todo_id: p.todo_id }),
  },
  {
    name: "wecom_app_todo_update",
    description: "更新待办状态（todo_id + status；形状按官方文档 todo/update 透传其余字段）。没有创建待办的 API。",
    parameters: { type: "object", properties: { todo_id: { type: "string" }, status: { type: "number" } }, required: ["todo_id"], additionalProperties: false },
    exec: async (p, call) => call("todo/update", { todo_id: p.todo_id, status: p.status }),
  },
];

export default definePluginEntry({
  id: "wecom-app",
  name: "WeCom App Tools",
  description: "企微自建应用能力：通讯录/文档·智能表格/会议/应用日历/待办（白名单 fail-closed）。",
  register(api) {
    if (!credentialsReady()) {
      console.log("[wecom-app] 凭据未配置（WECOM_APP_CORP_ID/secret），工具将返回配置错误而非崩溃");
    }
    const tokens = createTokenManager({
      corpId: process.env.WECOM_APP_CORP_ID || "",
      secret: resolveSecret().secret,
    });
    const call = async (path, body, method) => {
      let token;
      try {
        token = await tokens.get();
      } catch (e) {
        return { error: `获取 access_token 失败：${e.message}` };
      }
      return callWecom({ token, path, method, body });
    };
    for (const tool of TOOLS) {
      api.registerTool(
        (ctx) => {
          const senderId = (ctx && ctx.requesterSenderId) || "";
          return {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            execute: async (_toolCallId, params) => {
              if (!isAllowed(ALLOWED, senderId)) {
                return toToolResult({ error: senderId ? DENIED_MESSAGE : NO_IDENTITY_MESSAGE });
              }
              if (!credentialsReady()) {
                return toToolResult({ error: NO_CREDENTIALS_MESSAGE });
              }
              return toToolResult(await tool.exec(normalizeParams(params), call));
            },
          };
        },
        { name: tool.name },
      );
    }
    console.log(`[wecom-app] 注册 ${TOOLS.length} 把工具；白名单 ${ALLOWED.length} 人（env WECOM_APP_ALLOWED_USERS）`);
  },
});
```

- [ ] **Step 5: 跑契约测试 + lib 测试确认全绿**

Run: `cd deploy/openclaw/wecom-app-plugin && node --test`
Expected: PASS（lib + contracts 全绿）

- [ ] **Step 6: Commit**

```bash
git add deploy/openclaw/wecom-app-plugin/
git commit -m "feat(openclaw): wecom-app 插件入口——17 工具注册+白名单门+透传调用 (#1199)"
```

---

### Task 3: SKILL.md + README.md

**Files:**
- Create: `deploy/openclaw/wecom-app-plugin/skills/wecom-app/SKILL.md`
- Create: `deploy/openclaw/wecom-app-plugin/README.md`（读者：运维/下一个改插件的人）

**Interfaces:**
- Consumes: Task 2 的 17 个工具名与 lib 的错误文案。
- Produces: 模型可见的技能指令（随镜像走）；运维文档。

- [ ] **Step 1: 写 `skills/wecom-app/SKILL.md`（完整内容）**

```markdown
---
name: wecom-app
description: 企微内部能力（通讯录/文档·智能表格/会议/应用日历/待办）走 wecom_app_* 工具——不要用 exec/curl 硬试。白名单外的用户会收到拒绝文案，如实转告。
metadata:
  openclaw:
    emoji: "🏢"
---

# 企微应用工具 Skill

用户要动**企微内部对象**（查人/查部门/读填文档与智能表格/查建会议/查建日程/看待办）时用
`wecom_app_*` 工具；这些工具走企业自建应用的服务端权限，与你手上的 shell 无关。

## 路由表

| 用户要什么 | 工具链 |
|---|---|
| 公司有哪些部门 / 某部门有哪些人 | `wecom_app_departments` → `wecom_app_users(department_id)` |
| 建表并写入数据 | `wecom_app_doc_create(doc_type=10)` → `wecom_app_sheet_sheets` → `wecom_app_sheet_fields` → `wecom_app_sheet_add_records` → `wecom_app_sheet_records` 回读 |
| 改已有表格的数据 | `wecom_app_sheet_fields`（看字段标题）→ `wecom_app_sheet_records`（拿 record_id）→ `wecom_app_sheet_update_records` → 回读 |
| 查/建会议 | `wecom_app_meetings(userid, 时间窗)` → `wecom_app_meeting_info(meetingid)`；建：`wecom_app_meeting_create(body)` |
| 查/建日程 | 日程只挂在**应用日历**上：`wecom_app_calendar_create`（拿 cal_id，一次建好可复用）→ `wecom_app_schedule_add` / `wecom_app_schedules(cal_id, 时间窗)` |
| 待办 | `wecom_app_todo_get(todo_id)` / `wecom_app_todo_update`。**没有创建待办的 API**——用户要"新建待办"时如实说明做不到，不要编造成功 |
| 排障第一步 | `wecom_app_status`（应用身份+凭据+白名单） |

## 硬纪律

1. 企微内部功能**只用** `wecom_app_*` 工具；禁止为企微功能用 `exec`/`curl`/读插件源码/翻 env。
2. **写操作三步走**：先读现状（fields/records）→ 写（add/update）→ 回读验证目标状态。
3. `wecom_app_sheet_add_records` / `update_records` 的 `records[].values` **键 = 字段标题**
   （不是 field_id）；单元格 `{values:[{type:1,text|number}]}`。不确定字段标题先
   `wecom_app_sheet_fields`，不要臆造。
4. 报错读 detail 自纠**一次**；同一调用不要原样重试。固定文案的错（48002/60020/301085 等）
   是管理员动作，如实转告用户，不要换参数试探。
5. 白名单拒绝文案出现时如实转告（"你没有企微应用能力的使用权限"），不要绕。

## 边界（如实告知，不编）

- 成员**个人日历**查不了（企微 API 只开放应用自建日历）。
- 待办只能读和改状态，不能创建。
- `301085` = 该文档没共享给应用：要么让用户在企微文档里共享，要么用 `wecom_app_doc_create`
  建新表（应用自建天然可见）。
```

- [ ] **Step 2: 写 `README.md`**

```markdown
# wecom-app-plugin（企微自建应用工具）

OpenClaw native plugin：17 把固定端点工具（通讯录/文档·智能表格/会议/应用日历/待办），
凭据走 env、使用人白名单 fail-closed、权限裁决在企微服务端。设计正典：
`docs/superpowers/specs/2026-11-01-openclaw-wecom-app-plugin-design.md`。

## env

| 键 | 说明 |
|---|---|
| `WECOM_APP_CORP_ID` | 企业 CorpID |
| `WECOM_APP_AGENT_ID` | 自建应用 agentId（1000009） |
| `WECOM_APP_SECRET` | CorpSecret 明文（可选，优先） |
| `WECOM_APP_SECRET_FROM` | 间接引用：secret 所在的 env 变量名（现配 `WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`） |
| `WECOM_APP_ALLOWED_USERS` | 逗号分隔的企微 userid 白名单 |

## 工具（17 把）

| 工具 | 端点（cgi-bin/） | 读/写 |
|---|---|---|
| `wecom_app_status` | `agent/get` | 读 |
| `wecom_app_departments` / `wecom_app_users` | `department/list` / `user/list` | 读 |
| `wecom_app_doc_create` | `wedoc/create_doc` | 写 |
| `wecom_app_sheet_sheets` / `_fields` / `_records` | `wedoc/smartsheet/get_sheet` / `get_fields` / `get_records` | 读 |
| `wecom_app_sheet_add_records` / `_update_records` | `wedoc/smartsheet/add_records` / `update_records` | 写 |
| `wecom_app_meetings` / `_info` / `_create` | `meeting/get_user_meetingid` / `get_info` / `create` | 读/读/写 |
| `wecom_app_calendar_create` | `oa/calendar/add` | 写 |
| `wecom_app_schedules` / `_schedule_add` | `oa/schedule/get_by_calendar` / `add` | 读/写 |
| `wecom_app_todo_get` / `_todo_update` | `todo/get` / `todo/update` | 读/写（无创建 API） |

## 部署（三道门）

1. 镜像：`deploy/Dockerfile.openclaw` 已 COPY 到 `/opt/plugins/wecom-app-plugin`；
2. 容器内：`openclaw plugins install -l /opt/plugins/wecom-app-plugin --force --accept-capabilities`；
3. `openclaw config set agents.entries.main.tools.allow '[…既有 8 项…, "wecom_app_status", … ]'`
   （17 个工具名），然后重启网关。工具注册成功 ≠ agent 可见——allowlist 是最后一道门。

## 测试

`node --test`（lib 纯逻辑 + contracts 契约）。改动实测形状前先读 spec §9 的证据表。
```

- [ ] **Step 3: Commit**

```bash
git add deploy/openclaw/wecom-app-plugin/skills deploy/openclaw/wecom-app-plugin/README.md
git commit -m "docs(openclaw): wecom-app SKILL——路由表/硬纪律/能力边界 (#1199)"
```

---

### Task 4: Dockerfile 接线 + 全量验证 + PR

**Files:**
- Modify: `deploy/Dockerfile.openclaw`（zh-thinking COPY 块之后加一行）

**Interfaces:**
- Consumes: Task 1–3 产物。
- Produces: 镜像内 `/opt/plugins/wecom-app-plugin`；PR。

- [ ] **Step 1: Dockerfile 加 COPY**

在 `COPY deploy/openclaw/zh-thinking-plugin /opt/plugins/zh-thinking-plugin` 之后插入：

```dockerfile
# 企微自建应用工具插件（spec 2026-11-01-openclaw-wecom-app-plugin-design.md）。
# 凭据不进镜像：容器经 openship 服务行 env 注入（WECOM_APP_*，secret 间接引用）。
COPY deploy/openclaw/wecom-app-plugin /opt/plugins/wecom-app-plugin
```

- [ ] **Step 2: 插件全量测试**

Run: `cd deploy/openclaw/wecom-app-plugin && node --test`
Expected: 全绿

- [ ] **Step 3: 仓级门禁（确认没碰别人）**

Run: `node scripts/check-compose.mjs && node scripts/check-env-example.mjs`（在仓根；若仓有统一 gates 命令以 `README §常用命令` 为准）
Expected: PASS（本插件零 compose/env 模板改动，B9 门禁不受影响——插件不读仓级 .env.example 的键）

- [ ] **Step 4: Commit + push + PR**

```bash
git add deploy/Dockerfile.openclaw
git commit -m "build(openclaw): 镜像纳入 wecom-app 插件源 (#1199)"
git push -u origin docs/wecom-app-plugin-spec  # 或按当次分支名
```

PR：标题 `feat(openclaw): wecom-app 企微自建应用插件——17 工具+白名单+SKILL (#1199)`，
body 含 `Closes #1199`、spec/plan 链接、`node --test` 结果贴文。

---

### Task 5: 部署接线（ops，openship MCP——不裸 SSH）

**Files:** 无仓内改动（全部运行态）。

**Interfaces:**
- Consumes: Task 4 的 PR 合入 main（山海项目走手动更版：merge 后 `POST deploy` 触发，见
  `deploy/openship-adopt.md` / 山海一键更版 webhook）。
- Produces: 容器内已注册+allowlist 放行+网关重启后的可用工具面。

- [ ] **Step 1: 触发山海部署并确认镜像带插件**

openship MCP：部署 `proj_GLXUtN2bJ92DpPrS`（merge main 后手动触发）。
service exec 验证：`ls /opt/plugins/wecom-app-plugin`（有 index.js/lib.js/skills 即新镜像）。

- [ ] **Step 2: 容器内注册（一次性，写 state 卷）**

```sh
openclaw plugins install -l /opt/plugins/wecom-app-plugin --force --accept-capabilities
openclaw plugins list | grep wecom-app
```
Expected: `wecom-app` enabled。

- [ ] **Step 3: allowlist 追加 17 名 + 重启网关**

```sh
openclaw config set agents.entries.main.tools.allow '["list_metrics","query_data","query_detail","describe_metric","sample_dimension_values","get_freshness","automations","exec","wecom_app_status","wecom_app_departments","wecom_app_users","wecom_app_doc_create","wecom_app_sheet_sheets","wecom_app_sheet_fields","wecom_app_sheet_records","wecom_app_sheet_add_records","wecom_app_sheet_update_records","wecom_app_meetings","wecom_app_meeting_info","wecom_app_meeting_create","wecom_app_calendar_create","wecom_app_schedules","wecom_app_schedule_add","wecom_app_todo_get","wecom_app_todo_update"]'
openclaw gateway restart   # 若 CLI 不支持则经 openship 重启 openclaw 服务
```

- [ ] **Step 4: 网关侧探针（session-key 探针法，不占真渠道）**

```sh
openclaw agent --agent main --session-key agent:main:probe-wecomapp \
  -m '不要用 exec。只调用一次 wecom_app_status，把结果原样贴出来。' --json
openclaw sessions delete agent:main:probe-wecomapp --agent main --yes
```
Expected: `toolSummary.tools=["wecom_app_status"]`、calls=1（CLI 无 requesterSenderId ⇒ 回
白名单/身份拒绝文案也算"工具已进 LLM 面"；真正的放行验证在 Task 6 真渠道）。

⚠️ 别用 `openclaw agent exec` 验工具面（隔离嵌入式运行看不到插件工具，假阴性）。

- [ ] **Step 5: D2 隐藏层（best-effort，不生效不阻塞）**

```sh
openclaw config set tools.toolsBySender '{"channel:wecom:ZhangDuo":{},"channel:wecom:yangwei":{},"*":{"deny":["wecom_app_*"]}}' --strict-json
openclaw gateway restart
```
验证：ZhangDuo 探针轮仍能见 `wecom_app_*`（specific 条目覆盖 `*`）；若通配 deny 误伤白名单内
成员 ⇒ **立即回滚该键**（`openclaw config unset tools.toolsBySender`）并记录为已知边界——
插件层 fail-closed（Task 1/2）不受影响，安全不依赖这层。

- [ ] **Step 6: env 消费方逐一验证（deploy-verify 规则）**

service exec：`env | grep '^WECOM_APP'`（4 键在场）+ `openclaw plugins doctor`（无 wecom-app
相关 WARN）。

---

### Task 6: 真渠道验收（人工参与）+ 回填

**Files:**
- Modify: `docs/superpowers/specs/2026-11-01-openclaw-wecom-app-plugin-design.md`（状态行改"已上线"）
- 经验库：更新《OpenClaw 工具层接企微自建应用权限…》条目

- [ ] **Step 1: 白名单内（ZhangDuo，企微私聊）**

问「公司现在有哪些部门」→ 会话转录里整轮工具 = `['wecom_app_departments']`，零 `exec`；
问「建一个智能表格，写入一行：门店 测试店，销售额 100」→ `doc_create`+`sheet_*` 链且回读一致。
（转录取证：`agents/main/agent/openclaw-agent.sqlite` 的 transcript_events 按
`"name":"wecom_app_` 计数。）

- [ ] **Step 2: 白名单外（任一非名单用户，如 DongJiJuan）**

同问「列出所有部门」→ 收到固定拒绝文案；transcript 中 **零** `wecom_app_*` 调用（fail-closed 生效）。

- [ ] **Step 3: 问数回归**

问「昨天的净销售额」→ 仍走 `list_metrics`/`query_data`，工具面无串扰。

- [ ] **Step 4: 回填**

spec 状态行 + WeKnora 条目（§8 增补"已上线+验收锚点"）；`wecom_app_status` 里的
`secretSource` 字段确认是 `WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`（间接引用生效）。

---

## Self-Review 记录

- 覆盖 spec：D1（Task1 resolveSecret/Task5 env）、D2（Task1 isAllowed + Task2 门 + Task6-2）、
  D3/D5/D6（Task2 TOOLS 形状与文案）、D4（Task2 描述+Task3 SKILL）、D7（Task1 tokenManager）、
  D8（Task3 SKILL 随镜像）、D9（Task5 三道门）、D10（无任务触碰 dmPolicy）、§7 文案（Task1 ERROR_COPY）、
  §10 验收（Task6）。
- 17 工具名在 KNOWN_TOOLS / manifest / Task5 allowlist 三处逐字一致。
- 无占位符；todo/meeting_create 的官方参数形状差异由"透传 + errmsg 自纠"吸收（SKILL 纪律 4）。
