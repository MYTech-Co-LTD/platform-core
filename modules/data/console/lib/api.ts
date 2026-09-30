// console/lib/api.ts —— 模块 API 薄封装：前缀拼接、错误体翻译、非 JSON 回落。
// 契约照 modules/aftersales/console/lib/api.ts（同一套语义，别改形状）——但**各模块一份**，
// 模块之间不互相依赖（B1），所以这里整文件复制语义而不 import aftersales。
import { platformFetch } from '@platform/sdk/web'

/** 三同纪律：模块 id = DB schema = API 前缀。 */
const PREFIX = '/api/modules/data'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return new ApiError(res.status, typeof body.error === 'string' ? body.error : `HTTP_${res.status}`)
  } catch {
    // 响应体不是 JSON（edge 502 的 HTML 页等）⇒ 回落成状态码，**不因解析失败吞掉状态**
    return new ApiError(res.status, `HTTP_${res.status}`)
  }
}

export async function apiGet(path: string): Promise<unknown> {
  const res = await platformFetch(PREFIX + path)
  if (!res.ok) throw await toError(res)
  return res.json()
}

export async function apiSend(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<unknown> {
  const res = await platformFetch(PREFIX + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
  if (!res.ok) throw await toError(res)
  return res.status === 204 ? undefined : res.json()
}

const MESSAGES: Record<string, string> = {
  INVALID_BODY: '输入不合法，请检查后重试',
  NOT_FOUND: '目标不存在或已被删除',
  LLM_UNCONFIGURED: '本站未开启智能问数（未配置 LLM）',
  AGENT_FAILED: '问数过程中出错了，请稍后重试',
  // 报表面（#150 T7）。两码分开：没接 = 配置状态（运维该去配），调用失败 = 上游故障（该重试）
  METABASE_UNCONFIGURED: '本站未接报表服务（未配置 Metabase）',
  METABASE_ERROR: '报表服务暂时不可用，请稍后重试',
  TENANT_PARAM_RESERVED: 'tenant 参数由平台保留，不能自定义',
  // renderer='platform' 的行**没有** Metabase 嵌入通道（#150/#391：platform 行的「打开」自
  // 2026-09-30 Task 4 起改走平台自绘渲染器 SpecView，**不**调 embed-url——见报表页接线用例）。
  // 这条因此是**防御性**文案——只有「加载后该行才变成 platform」这种陈旧视图/竞态才会点到；
  // 服务端守卫见 `GET /reports/:id/embed-url`（409 同码）。
  RENDERER_NOT_EMBEDDABLE: '平台自绘报表没有嵌入预览通道',
  // 编辑入口（#346 计划 3）。与上面那条**同构**：列表里 platform 行的「编辑」已不渲染
  // （逐行按 renderer 判），这条是**防御性**文案——只有陈旧视图/竞态才会点到；
  // 服务端守卫见 `GET /reports/:id/edit-url`（409 同码）。
  RENDERER_NOT_EDITABLE: '平台自绘报表没有可编辑的 Metabase 页面',
  // 自绘规格读写（#391 计划 6 Task 3）：打到 metabase 行上的 `GET/PUT /reports/:id/spec`。
  // 与上面两条 renderer 守卫同族——列表按 renderer 分流后正常点不到，这条是**防御性**文案
  // （陈旧视图/竞态才会点到）；服务端守卫见 routes/reports.ts 的两个 /spec 端点（409 同码）。
  RENDERER_NOT_SELF_DRAWN: '只有平台自绘报表才能读写规格',
  // 「没配」与「配了但坏了」要分开：本条 = 配置状态（`MB_PROXY_PUBLIC_ORIGIN` 缺配/非 https，
  // 或 `PLATFORM_SESSION_SECRET` 过短——均属运维侧，见 `modules/data/routes/reports.ts` 的
  // fail-closed 前置检查）。用户自己做什么都没用，所以直接说联系运维，别让他反复重试。
  EDIT_PROXY_UNCONFIGURED: '编辑入口未配置（请联系运维）',
  // 页门未放行（spec：管理清单**不裁行**，所以「门是自己没有的 scope」的行会出现在管理员表里）。
  // 列表里这类行的「打开」已按页门置灰，这条与上面那条同样是**防御性**文案——只有陈旧视图/竞态
  // 才会点到；没有它时界面直接吐英文裸码 `FORBIDDEN`。
  // ⚠️ 文案**必须中性**：`FORBIDDEN` 是**宿主通用码**，而本表是模块级共享的（四个页签共用）
  //    ——「指标」页签挂载即打 `GET /metrics/all`（data:manage），只持 data:query 的普通员工
  //    在那里也会撞到 403。写死「报表/页门」会把别的页签的 403 误标成报表页门（撒谎比裸码更坏）。
  FORBIDDEN: '没有权限执行该操作（需要更高授权或页门放行）',
  // L2 派生指标（#150 T8）。逐码给文案：这几个都是**调用方改一下就能过**的错，
  // 回落成裸码（如 UNKNOWN_DIM）会让用户不知道该改什么——而这一页的用户正是要自己定义指标的人。
  L1_BASE_NOT_FOUND: '要派生的平台指标不存在（平台词表以 dbt 声明为准）',
  UNKNOWN_DIM: '用到了平台指标没有声明的维度，请从下拉里选',
  BAD_FILTER: '过滤条件不合法：用 = 只能给一个值，用 in 至少给一个值',
  ID_RESERVED_BY_L1: '这个 id 属于平台词表，不能占用（换一个 id）',
  READONLY_L1: '平台词表经 API 只读，改它要改 dbt 声明后重新物化',
  TARGET_NOT_SUPPORTED: '目标值当前没有存储位置，暂不支持',
  L1_BASE_SQL_INVALID: '平台指标的 SQL 形状不合契约，请联系平台侧处理',
  ID_MISMATCH: '路径 id 与提交内容不一致',
  // ── 写保护（spec §3③）───────────────────────────────────────────────────────────
  // **登记侧**冲突：`PUT`/`DELETE /reports/:id` 带回的版本 ≠ 服务端现值（别人刚改过）。
  // 文案说的是**已经发生**的事（页面动作：catch 里 `await load()` 重新拉列表）——别在这句里
  // 承诺「已回滚」之类没有的动作。两条端点同码（PUT 232 行 / DELETE 335 行）。
  STALE_WRITE: '这份报表刚被别人改过，已为你刷新，请重试',
  // **内容侧**缺失指纹：`POST /reports`（重登记既有报表）不带 `expectedFingerprint` ⇒ 409。
  // ⚠️ console **不调这个端点**（登记在 API/管线侧），本条纯属**防御性**文案：若将来把重登记
  //    搬进 console，裸码 `VERSION_REQUIRED` 会直接漏到界面上。与 `STALE_WRITE` 同族但不是同一件事
  //    （一个「没带版本」、一个「版本过期」），故分成两条。
  // ⚠️ 文案**不含**「已为你刷新」（评审 Minor ②，2026-09-29）：那句承诺的前提是 `catch` 里
  //    `await load()`，而本码唯一的产出方 `POST /reports` **不由 console 驱动** ⇒ 刷新根本没发生，
  //    写上就是**撒谎**（真到这一步的用户照「已刷新」去重试只会再撞）。补语去掉，只留可验证的动作。
  VERSION_REQUIRED: '缺少版本信息，请先读取最新版本再提交',
  // **客户端侧**自检码（无 HTTP 状态：本表里唯一不由服务端产出的码）。管理清单若有行缺
  // `version`，写动作会发出 `?expectedVersion=undefined`（PUT 则整键被 JSON 丢弃）⇒ 服务端只回
  // 400「输入不合法」，**清单契约破损被静默**。console 于是 fail-closed：坏快照不落地并说这句。
  SNAPSHOT_INVALID: '报表清单缺少版本号，请刷新页面；若仍如此请联系平台侧',
  INVALID_SPEC: '报表规格不合法（含不支持的字段或取值）',
  UNKNOWN_CHART_TYPE: '这个图型平台还不支持（图型白名单由平台代码维护）',
  SPEC_TOO_LARGE: '报表规格过大（面板数超出上限）',
}

/** 已知码给中文文案；未知码回落成码本身（便于排障）。 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.code
  return '网络异常，请稍后重试'
}
