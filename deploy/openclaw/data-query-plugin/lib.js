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
