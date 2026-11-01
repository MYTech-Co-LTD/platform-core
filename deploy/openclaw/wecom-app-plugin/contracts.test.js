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

test("execute 顺序契约：isAllowed 门先于 credentialsReady、二者先于任何 exec 调用（fail-closed 顺序锚）", () => {
  const iAllowed = indexSrc.indexOf("if (!isAllowed(");
  // ① credentialsReady 在 index.js 出现两处：register 期的告警（在前）+ execute 的门（在后）。
  //    必须从 isAllowed 之后找，锚定的才是 execute 里的那道门（评审代码原样 indexOf 会撞 register 告警误红）。
  const iCred = indexSrc.indexOf("if (!credentialsReady(", iAllowed);
  const iExec = indexSrc.indexOf("await tool.exec(");
  assert.ok(iAllowed >= 0 && iCred > iAllowed && iExec > iCred, `顺序锚失效：isAllowed=${iAllowed}, credentialsReady=${iCred}, exec=${iExec}——重构不得把白名单门挪后`);
  assert.ok(indexSrc.includes("DENIED_MESSAGE") && indexSrc.includes("NO_IDENTITY_MESSAGE"), "拒绝文案常量必须被引用");
});

test("TOOLS 名单无重名（重名会静默顶掉前一把的工具面）", () => {
  assert.equal(new Set(defNames).size, defNames.length, `defNames 有重名：${defNames.join(",")}`);
});
