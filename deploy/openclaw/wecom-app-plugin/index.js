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
