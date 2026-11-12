// lib/explain.ts — 错误码 → 人话（单页双层的「默认层」文案来源）。
//
// 为什么集中在一张表：错误码是**工程师的定位信息**，业务不该读它；但专业人要能拿到原码。
// 所以界面主句走本表，原码放进 `<TechDetails>`。表之外的码**回落到通用句 + 保留原码**，
// 绝不吞掉（吞掉 = 排障时看不到真实原因）。
//
// 加新码 = 服务端新增错误分支时在这里补一行；不补也能用（回落），只是文案不够具体。

export interface HumanError {
  /** 默认层：一句人话 + 下一步动作。 */
  text: string
  /** 专业层：原始 code（始终保留）。 */
  code: string
  /** 服务端给的定位信息（缺省 undefined）。 */
  detail?: string
}

const BY_CODE: Record<string, string> = {
  // 身份 / 权限
  UNAUTHENTICATED: '登录状态失效了，刷新页面重新登录一次',
  FORBIDDEN: '你没有这个操作的权限，需要找管理员开通',
  NOT_FOUND: '这条记录不存在，可能已经被删了',
  RANGE_DENIED: '你没有这个数据范围的权限，找管理员给你加范围',

  // 输入
  INVALID_BODY: '提交的内容格式不对，检查必填项后重试',
  INVALID_STATUS: '状态取值不合法，刷新页面重试',
  INVALID_LIMIT: '数量参数不合法（必须是正整数）',

  // 指标 / 候选
  METRIC_EXISTS: '这个指标名已经被占用了，换一个名字',
  ID_RESERVED_BY_L1: '这个名字和平台已有指标重名了，换一个',
  METRIC_NOT_DECLARED: '找不到这个指标，可能已下线',
  METRIC_NOT_TOTALABLE: '这个指标不能跨维度相加（非可加口径）',
  METRIC_SOURCE_NOT_ADOPTED: '该指标所属的数据源还没有接入本租户',
  CANDIDATE_NOT_ADOPTABLE: '这条候选已经被处理过（采用/拒绝/过期），刷新列表看看最新状态',
  CANDIDATE_NOT_REJECTABLE: '这条候选已经不是待处理状态，刷新列表看看',
  CANDIDATE_NOT_PROMOTABLE: '这条候选当前不能升级为平台口径',

  // 指标变更单（Wave 5 P0）
  CHANGE_STATE_CHANGED: '这条已经被处理过了，刷新列表看看最新状态',
  PREVIEW_UNAVAILABLE: '还没跑成试算，不能采纳；先点「跑试算」',
  DECISION_REQUIRES_SESSION: '这个操作只能本人登录后做，不能用程序身份',
  REASON_REQUIRED: '驳回要写清哪里不对',
  COLUMN_NOT_NUMERIC: '这一列不是数值，做不了求和/平均这类计算',
  COLUMN_NOT_FOUND: '候选里引用的列在仓库里不存在，可能源表结构变了',
  DIM_MASKED: '这个字段被脱敏了，不能用来分组',
  RELATION_NOT_WHITELISTED: '这张表还没被纳入可用范围',

  // 草稿 / 发布
  NOT_PUBLISHED: '报表/指标还没发布，先发布再分享',
  STALE_WRITE: '有人刚改过同一份内容，刷新后重新提交',
  VERSION_REQUIRED: '缺少版本号，刷新页面重试',
  USE_PUBLISH_ENDPOINT: '保存和发布是两步：先保存草稿，再点发布',

  // 环境
  METABASE_UNCONFIGURED: '报表引擎还没配置好，找管理员',
  METABASE_ERROR: '报表引擎返回异常，稍后重试；持续失败请找管理员',
  AI_TEXT_REQUIRES_DATA_PANEL: '这一页还没有数据面板，先加一个面板再生成解读',
  SEMANTICS_UNREADABLE: '指标口径文件读不出来，找管理员',
}

/** 把错误翻成「主句 + 原码」。表里没有的码用通用句，**原码永远保留**。 */
export function humanError(e: unknown): HumanError {
  const code = codeOf(e)
  const detail = detailOf(e)
  const text = BY_CODE[code] ?? '操作没有成功，可以重试一次；反复失败请把下面的信息发给管理员'
  return { text, code, ...(detail === undefined ? {} : { detail }) }
}

function codeOf(e: unknown): string {
  if (e !== null && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code
  }
  if (e instanceof Error) return e.message
  return String(e)
}

function detailOf(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && 'detail' in e) {
    const d = (e as { detail: unknown }).detail
    return typeof d === 'string' && d !== '' ? d : undefined
  }
  return undefined
}

// ── 术语词典（Wave 4.4）───────────────────────────────────────────────────────
//
// 目的：把界面上出现的「工程词」集中解释一次，全站复用同一个组件（`<Explain term>`），
// 各页不各写一套文案。**只收默认层会出现的词**——纯工程细节（SQL/聚合函数）不进这里，
// 它们本来就在 `<TechDetails>` 里，且有错误码表兜底。
//
// 写法纪律：一句话说「是什么 + 对我意味着什么」，不解释实现。出现新术语 ⇒ 加一行 + 在界面上用
// （`explain.test.ts` 断言「被引用的术语都存在」，防止 `term` 打错后静默空提示）。

export interface TermEntry {
  /** 术语本身（标题）。 */
  label: string
  /** 人话解释（一句话，可两句）。 */
  text: string
}

export const TERMS: Record<string, TermEntry> = {
  caliber: {
    label: '口径',
    text: '这个数是怎么算出来的规则（含哪些数据、怎么加总）。平台口径由数据平台维护；租户口径是本租户自己的算法。',
  },
  certified: {
    label: '已认证 / 草稿口径',
    text: '已认证 = 平台复核过的口径，可直接用于对外报表；草稿口径 = 还在验证中，重要结论请先跟数据管理员确认。',
  },
  override: {
    label: '口径覆盖',
    text: '本租户把平台口径换成了自己的算法。看到「覆盖」标记，说明这个数与其他租户的同名指标可能不一样。',
  },
  confidence: {
    label: '置信度',
    text: '系统对「这条建议靠不靠谱」的打分，越高越可能是你真要的指标。只是参考，最终由你决定要不要。',
  },
  visibility: {
    label: '谁看得到',
    text: '这份报表的可见范围：全租户可看，或者只有你和共享名单里的人/部门能看。',
  },
  deptGate: {
    label: '部门门',
    text: '按组织架构限制谁能看：只有指定部门（含下属部门）的人能看到这份报表。',
  },
  freshness: {
    label: '数据截至',
    text: '这份数据里最新一天的日期。它比今天早，通常是正常的数据更新延迟；比平时晚太多才需要留意。',
  },
  scope: {
    label: '所需权限',
    text: '要查看这个指标需要开通的权限码。看不到数时先看这一项，再找管理员开通。',
  },
}

/** 取术语解释；未登记的 term 返回 null（调用方不渲染问号，避免空提示）。 */
export function termEntry(term: string): TermEntry | null {
  return TERMS[term] ?? null
}
