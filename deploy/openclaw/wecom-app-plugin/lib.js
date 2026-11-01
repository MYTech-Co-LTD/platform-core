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

/** GET 的参数必须走 query 串：fetch 的 GET 带 body 会被 undici 直接抛 TypeError
 *  （"Request with GET/HEAD method cannot have body"），再被 catch 吞成「企微 API 不可达」，
 *  status/departments/users 三个 GET 工具会恒坏（#1238 评审 Important 1）。
 *  只取「有值」的键（undefined/null 不进 query）；body 为 undefined/空对象 ⇒ URL 原样。
 *  POST 行为一律不变。 */
function bodyToQuery(body) {
  if (!body || typeof body !== "object") return "";
  const entries = Object.entries(body).filter(([, v]) => v !== undefined && v !== null);
  return entries.length === 0 ? "" : `&${new URLSearchParams(entries).toString()}`;
}

/** 业务载荷原样回；非零 errcode → {errcode, error}；404/网络错误有固定文案。 */
export async function callWecom({ token, path, method = "POST", body, fetchImpl = fetch }) {
  const isGet = method === "GET";
  let resp;
  try {
    resp = await fetchImpl(
      `${API_BASE}/${path}?access_token=${token}${isGet ? bodyToQuery(body) : ""}`,
      isGet
        ? { method }
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
    );
  } catch (e) {
    return { error: `企微 API 不可达：${e.message}` };
  }
  if (resp.status === 404) {
    return { error: `企微端点不存在（404）：${path}——插件与官方文档漂移，请联系维护者。` };
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    return { error: `企微 API 返回了无法解析的响应（HTTP ${resp.status}）` };
  }
  if (typeof data.errcode === "number") {
    if (data.errcode === 0) return data;
    return { errcode: data.errcode, error: mapError(data.errcode, data.errmsg) };
  }
  if (!resp.ok) return { error: `企微 API 异常响应（HTTP ${resp.status}）` };
  return data;
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
