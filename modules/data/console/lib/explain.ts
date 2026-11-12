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
