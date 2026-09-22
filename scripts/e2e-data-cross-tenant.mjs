#!/usr/bin/env node
// e2e-data-cross-tenant.mjs — 串租户回归套件（issue #150 / 计划 Task 12；spec 验收 #2）。
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// 用法
// ═══════════════════════════════════════════════════════════════════════════════════════
//
//   E2E_PLATFORM_URL=… E2E_METRIC_ID=… … pnpm exec tsx scripts/e2e-data-cross-tenant.mjs
//   pnpm exec tsx scripts/e2e-data-cross-tenant.mjs --help     # 列出全部 env 键与含义
//
// 契约：**干净 → exit 0**（四面全过）；**有 violation → exit 1，逐条打印**；
//       **跑不起来 → exit 2**（缺 env / 配置自相矛盾 / 连不上平台）。
// exit 2 与 exit 1 必须分开：前者是「脚本/环境坏了」，后者是「被观测的系统串租户了」，
// 处置完全不同（与 `scripts/reconcile-data-tenants.mjs` 同一口径）。
//
// **缺参不许静默按默认值跑**：任何一个必需 env 缺席 ⇒ 一次列全缺的键名 + exit 2。
// 静默默认值会让「job 配错了」表现为「套件全绿」，那是本套件最不该产的假绿。
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// 为什么必须**从数据面服务侧反向验**，不能只验 UI（spec 验收 #2 原话）
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// UI 看不见别人的数据，可能只是「页门上没给入口」——那是**一张页面的事**，不是隔离。
// 本套件四处**都绕过页面**：直连模块 API（PAT）、直连 Metabase 嵌入端点（iframe 背后那个）、
// 直连 pg_duckdb 用租户 A 的 PG role 去读 B 的桶。四处里任一处能穿，隔离就没成立。
//
// ── 四面各自的「穿」长什么样，以及为什么这么判 ──────────────────────────────────────
//
// ① **问数 API**（A 的 PAT → `POST /api/modules/data/query`）
//    穿 = 结果集里出现**对侧租户的数据**。判据不能只看「有没有 B 的 org 字符串」（行里未必有
//    那一列）⇒ 用**探针串**（`E2E_TENANT_*_PROBE`：只可能出现在该租户数据里的一个标记，
//    如自家客户名/门店号）。
//    ⚠️ **探针只查单侧 = 坏桩恒绿**：只断言「B 的结果里没有 A 的探针」时，一个恒返回空数据的
//       坏桩也全绿。故**两侧探针互为对方的断言面**，并且先验「本侧探针确实在结果里」（正面信号）。
//
// ② **嵌入缓存重放**（计划点名的「**最可能漏的一条**」）
//    A 的 token 拿一次 → B 的 token 查**同一张卡** → 断言 B 拿到的是 **B 的**数据。
//    漏它的方式很特别：**套件全绿而缺陷在场**——「B 拿到 A 的缓存副本」与「B 拿到自己的数据」
//    在**接口形状上完全一样**（都是 200 + 一坨数据）⇒ 判定必须下探到**内容**（探针）。
//    为什么这条在本栈仍然有意义：Cube 否决后「cube 缓存 key 的原文依据」已失效，但
//    **Metabase 的结果缓存同样可能把 A 的结果重放给 B**——这是同一类坑在现栈的形态。
//    另外本面还回读**嵌入 token 里的 `params.tenant`**（`signEmbedToken` 的 locked 值）：
//    它必须恒等于**调用者身份**的 org。改得动它 = 数据门失守，与缓存无关也该红。
//
// ③ **凭据负测**（A 的 PG role 直连 pg_duckdb → `read_parquet(B 的桶路径)` ⇒ **必须失败**）
//    这是 T11 的 USER MAPPING/SCOPE 结构性隔离的**反证**，也是「从数据面反向验」的字面落实。
//    ⚠️ **带正对照**：同一个 role 读**自己的**桶路径必须**成功**。少了正对照，一个「pg_duckdb
//       没装 / 网络不通 / role 连不上」的坏环境会让负测**恒过**——负测的「通过」就毫无意义。
//       故正对照失败 ⇒ 红；负测失败但**原因不像授权拒绝**（连不上等）⇒ 也红（信号不可采信）。
//
// ④ **L2 词表**（A 的 PAT `GET /metrics` + `POST /mcp` 的 `tools/list`）
//    穿 = 词表里出现**B org 定义的指标 id**。两条通道**各判各的**（`routes/metrics.ts` 与
//    `routes/mcp.ts` 是两份独立的 `visibleMetrics(...)` 调用面，只判一条等于漏一半）。
//    ⚠️ 形状坏（缺 `metrics` / 缺 `result.tools`）**不许当「空词表」放过**：读不出 ≠ 没有。
//
// ── 与计划/任务书的偏离（详见 task-12-report.md §4）─────────────────────────────────
//   · 计划 L962 的 `exit 0/1` 之外**加了 exit 2**（「跑不起来」与「串租户」必须可区分）；
//   · 面② 的「同一张卡」在 T7 的**按 org 命名空间**实现下**两侧本就是不同 dashboard**
//     （`dashboardName()` = `<org>/<title>`）⇒ 共享卡形态只在「有人手工建了共用 dashboard」时
//     才出现。本套件**两种形态都判**，并在 notes 里如实记下是哪一种（不假装它一定是共享的）。
//   · 面① **只跑 A→B 一个方向**（计划 L950–954 逐字如此）；反方向由面②（两侧都查）覆盖。
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// 诚实边界（**别把本套件的全绿当隔离已证的结论**）
// ═══════════════════════════════════════════════════════════════════════════════════════
//   · 本文件**从未在两租户真栈上跑过**——真栈那一面归 T13。本文件交付的是**判据 + 判据的单测**。
//   · 面③ 依赖 T11 的 `SCOPE` 真实收窄效果，而 T11 自述该 DDL 形状**键名未验**（真机核对归 T13）
//     ⇒ 面③ 若在真栈上红，第一嫌疑是 T11 的 USER MAPPING 形状，不是本套件的判据。
//   · 探针是**配置**不是凭据：它进 env，不进 git（本文件只写键名与取法）。

import { createRequire } from 'node:module'

// ── 出口码（三分：能不能跑 / 隔离成不成立）────────────────────────────────────────────
/** 四面全过。 */
export const EXIT_CLEAN = 0
/** 有 violation（隔离被穿过 / 判据不成立）。 */
export const EXIT_VIOLATION = 1
/** 跑不起来：缺 env、配置自相矛盾、连不上平台。**与上一条必须能区分**。 */
export const EXIT_CANNOT_RUN = 2

/** 数据模块的 id（本仓 `modules/data/manifest.yaml` 的 `id`）。 */
export const DATA_MODULE_ID = 'data'

/**
 * @typedef {Object} Violation
 * @property {string} surface 四个面之一的标识：`query` / `embed-replay` / `credential` / `catalog`
 * @property {string} message 人读的一句话（含具体值：探针、路径、指标 id —— 便于逐条排障）
 */

/**
 * @typedef {Object} Judgement
 * @property {Violation[]} violations 非空 ⇒ 该面红
 * @property {string[]} notes 「不是违规、但排障时非知道不可」的观察（**不许**塞进 violations：
 *   那会让套件恒红；也不许把 violation 降级成 note：那是假的绿灯）
 */

/** 四面判定的统一形状（不在某个面上开特例）。 */
const clean = () => /** @type {Judgement} */ ({ violations: [], notes: [] })

/**
 * @typedef {Object} TenantEnv
 * @property {string} org 该租户的 Casdoor org（= 隔离键）
 * @property {string} pat 该租户的 PAT（最小权限：`data:query`）
 * @property {string} probe 只可能出现在该租户数据里的标记串
 */

/**
 * @typedef {Object} CredentialEnv
 * @property {string} dsn 租户 A 的 PG role 直连 DSN（数据面 pg_duckdb）
 * @property {string} ownS3Path A 自己的桶前缀（**正对照**：必须能读）
 * @property {string} foreignS3Path B 的桶前缀（**负测**：必须读失败）
 */

/**
 * @typedef {Object} SuiteConfig
 * @property {string} platformUrl 平台基址（已去尾斜杠）
 * @property {string[]} metricIds 要逐指标问的指标 id（两个租户同名的那张）
 * @property {string} metricId `metricIds[0]`（便利别名）
 * @property {string} reportIdA 租户 A 侧用于取嵌入 URL 的报表 id
 * @property {string} reportIdB 租户 B 侧用于取嵌入 URL 的报表 id
 * @property {TenantEnv} tenantA
 * @property {TenantEnv} tenantB
 * @property {CredentialEnv} credential
 * @property {string[]} foreignMetricIds B org 定义的 L2 指标 id（A 侧必须看不到）
 */

/**
 * env 契约的**单一事实源**（`--help` 与「缺参一次列全」都从这里派生，别在别处复述）。
 * `secret: true` 的项**值不许进任何输出**（本文件不打印它们的值，只打印键名）。
 * @type {{ key: string, help: string, secret?: boolean }[]}
 */
export const ENV_SPEC = [
  { key: 'E2E_PLATFORM_URL', help: '平台基址，如 https://platform.example.com（模块 API 前缀 /api/modules/data 由它派生）' },
  { key: 'E2E_METRIC_ID', help: '面①要逐指标问的指标 id（逗号分隔可多个；两个租户同名的那张）' },
  { key: 'E2E_REPORT_ID', help: '面②用于取嵌入 URL 的报表 id（两侧同名报表各一行时，用下面两个覆盖）' },
  { key: 'E2E_TENANT_A_REPORT_ID', help: '选填：租户 A 侧的报表 id（缺省 = E2E_REPORT_ID）' },
  { key: 'E2E_TENANT_B_REPORT_ID', help: '选填：租户 B 侧的报表 id（缺省 = E2E_REPORT_ID）' },
  { key: 'E2E_TENANT_A_ORG', help: '面①③④：租户 A 的 Casdoor org（隔离键，**两租户必须不同值**）' },
  { key: 'E2E_TENANT_A_PAT', help: '面①②④：租户 A 的 PAT（最小权限 data:query）', secret: true },
  { key: 'E2E_TENANT_A_PROBE', help: '面①②：只可能出现在 A 数据里的标记串（如自家客户名）' },
  { key: 'E2E_TENANT_B_ORG', help: '面①②④：租户 B 的 Casdoor org' },
  { key: 'E2E_TENANT_B_PAT', help: '面①②④：租户 B 的 PAT', secret: true },
  { key: 'E2E_TENANT_B_PROBE', help: '面①②：只可能出现在 B 数据里的标记串（**必须与 A 的不同**）' },
  { key: 'E2E_TENANT_A_PG_DSN', help: '面③：租户 A 的 PG role 直连 DSN（数据面 pg_duckdb）', secret: true },
  { key: 'E2E_TENANT_A_S3_PATH', help: '面③正对照：A 自己的桶前缀（如 s3://bucket/<acme 前缀>/）' },
  { key: 'E2E_TENANT_B_S3_PATH', help: '面③负测：B 的桶前缀（**必须与 A 的不同**，否则负测退化成读自己的）' },
  { key: 'E2E_TENANT_B_METRIC_IDS', help: '面④：B org 定义的 L2 指标 id（逗号分隔；A 侧两条通道都必须看不到）' },
]

/** 选填的 env 键（有缺省值，故不参与「缺参」判定）。 */
const OPTIONAL_KEYS = ['E2E_TENANT_A_REPORT_ID', 'E2E_TENANT_B_REPORT_ID']

/** 必填的 env 键（从 `ENV_SPEC` 派生 —— 单一事实源）。 */
const REQUIRED_KEYS = ENV_SPEC
  .map(/** @param {{ key: string }} s @returns {string} */ (s) => s.key)
  .filter(/** @param {string} k @returns {boolean} */ (k) => !OPTIONAL_KEYS.includes(k))

/**
 * 去尾斜杠（否则拼出 `//api/modules/data`，多数反代会把 // 归一成 / 但别赌它）。
 * @param {string} s @returns {string}
 */
const trimSlash = (s) => s.trim().replace(/\/+$/, '')

/**
 * 逗号分隔 → 去空去重的数组。
 * @param {string} s @returns {string[]}
 */
const splitList = (s) => [...new Set(s.split(',').map((x) => x.trim()).filter((x) => x !== ''))]

/**
 * env → 配置。**缺一个必需键就抛，且一次列全缺的键名**（省掉「改一个跑一次」的往返）。
 *
 * 三道**自相矛盾**的形态校验（都是「本套件会恒绿」的形态，必须挡在跑之前）：
 *   · 两租户 org 同值 ⇒ 那不是串租户测试，是同租户自比；
 *   · 两租户探针同值 ⇒ 探针分不开两侧，「谁的数据」无从判定（**恒绿**）；
 *   · 两租户 S3 路径同值 ⇒ 面③的「负测」退化成读自己的（**恒绿**）。
 *
 * @param {Record<string, string | undefined>} env @returns {SuiteConfig}
 */
export function loadConfig(env) {
  const missing = REQUIRED_KEYS.filter((k) => (env[k] ?? '').trim() === '')
  if (missing.length > 0) {
    throw new Error(
      `缺 ${missing.length} 个必需环境变量：${missing.join(', ')}\n`
      + '（**不许静默按默认值跑**：静默默认值会让「job 配错了」表现为「套件全绿」——'
      + '那是本套件最不该产的假绿。完整清单见 --help。）',
    )
  }

  const tenantA = {
    org: (env.E2E_TENANT_A_ORG ?? '').trim(),
    pat: (env.E2E_TENANT_A_PAT ?? '').trim(),
    probe: (env.E2E_TENANT_A_PROBE ?? '').trim(),
  }
  const tenantB = {
    org: (env.E2E_TENANT_B_ORG ?? '').trim(),
    pat: (env.E2E_TENANT_B_PAT ?? '').trim(),
    probe: (env.E2E_TENANT_B_PROBE ?? '').trim(),
  }
  const credential = {
    dsn: (env.E2E_TENANT_A_PG_DSN ?? '').trim(),
    ownS3Path: (env.E2E_TENANT_A_S3_PATH ?? '').trim(),
    foreignS3Path: (env.E2E_TENANT_B_S3_PATH ?? '').trim(),
  }

  if (tenantA.org === tenantB.org) {
    throw new Error(
      `两租户 org 同值（${tenantA.org}）：那不是串租户测试，是同租户自比（会恒绿）。`
      + '请给两个真正不同的 Casdoor org。',
    )
  }
  if (tenantA.probe === tenantB.probe) {
    throw new Error(
      `两租户探针同值（${tenantA.probe}）：探针分不开两侧，「谁的数据」就无从判定 —— `
      + '整个套件会恒绿。两个探针必须各自只可能出现在自己租户的数据里。',
    )
  }
  if (credential.ownS3Path === credential.foreignS3Path) {
    throw new Error(
      `面③的 S3 路径两侧同值（${credential.ownS3Path}）：凭据负测会退化成「读自己的」——`
      + '正负两测都成功、判据恒绿。请给 B 的真正不同的桶前缀。',
    )
  }

  const metricIds = splitList(env.E2E_METRIC_ID ?? '')
  const reportId = (env.E2E_REPORT_ID ?? '').trim()
  return {
    platformUrl: trimSlash(env.E2E_PLATFORM_URL ?? ''),
    metricIds,
    metricId: metricIds[0] ?? '',
    reportIdA: (env.E2E_TENANT_A_REPORT_ID ?? '').trim() || reportId,
    reportIdB: (env.E2E_TENANT_B_REPORT_ID ?? '').trim() || reportId,
    tenantA,
    tenantB,
    credential,
    foreignMetricIds: splitList(env.E2E_TENANT_B_METRIC_IDS ?? ''),
  }
}

/**
 * 模块 API 基址（宿主挂载前缀；声明路径是模块相对的，见 `modules/data/manifest.yaml` 注记）。
 * @param {string} platformUrl @param {string} [moduleId] @returns {string}
 */
export function moduleApiBase(platformUrl, moduleId = DATA_MODULE_ID) {
  return `${trimSlash(platformUrl)}/api/modules/${moduleId}`
}

// ═══ 判定：面① 问数 API ═══════════════════════════════════════════════════════════════

/**
 * 命中对侧探针的那一行（**把具体行带进 message**：逐条打印的价值全在「哪一行串了」）。
 * rows 是 `unknown[][]`（见 `QueryOk` —— **不是**对象数组）。
 * @param {any[]} rows @param {string} needle @returns {string} 没命中 = `''`
 */
function findRow(rows, needle) {
  for (const r of rows) {
    const t = JSON.stringify(r)
    if (t.includes(needle)) return t
  }
  return ''
}

/**
 * 面① 判定。
 *
 * 三档结局，**每一档都必须有明确的红/绿**：
 *   · 问数没成功（denied / error）⇒ **红**（把「没跑到」当通过是最典型的假绿）；
 *   · 结果里出现对侧探针 ⇒ **红**（串租户本体）；
 *   · 本侧探针一次都没出现（含空结果集）⇒ **红**（正面信号缺席：分不清「没串」与「没数据」）。
 *
 * @param {{ tenant: string, probe: string, foreignProbe: string, outcome: any }} args
 * @returns {Judgement}
 */
export function judgeQueryResult({ tenant, probe, foreignProbe, outcome }) {
  const out = clean()
  if (!outcome || typeof outcome !== 'object' || outcome.status !== 'ok') {
    out.violations.push({
      surface: 'query',
      message: `面① 问数未成功（status=${String(outcome?.status)}，reason=${String(outcome?.reason)}，`
        + `detail=${String(outcome?.detail ?? '')}）：本面**无法判定**。「没跑到」不许当通过 —— `
        + '那会把「PAT 失效 / 仓库连不上 / 词表空」一律显示成全绿。',
    })
    return out
  }

  const rows = Array.isArray(outcome.rows) ? outcome.rows : []
  out.notes.push(`面① 租户 ${tenant} 问到 ${rows.length} 行（metricId=${String(outcome.metricId)}）`)

  const leaked = findRow(rows, foreignProbe)
  if (leaked !== '') {
    out.violations.push({
      surface: 'query',
      message: `面① 串租户：租户 ${tenant} 的问数结果里出现**对侧租户**的数据`
        + `（探针 '${foreignProbe}'，命中行 ${leaked}）—— 词表裁剪 / 主体钉死没有生效。`,
    })
  }

  const own = findRow(rows, probe)
  if (own === '') {
    out.violations.push({
      surface: 'query',
      message: `面① 正面信号缺席：租户 ${tenant} 的结果里一次都没出现**本租户探针** '${probe}'`
        + `（${rows.length} 行）⇒ 「没有串租户」与「根本没拿到数据」在这个结果里分不开。`
        + '空结果集也算这一条（坏桩/空库都会是这个形态）。',
    })
  } else {
    out.notes.push(`面① 本租户探针命中行 ${own}`)
  }
  return out
}

// ═══ 判定：面② 嵌入缓存重放 ═══════════════════════════════════════════════════════════

/**
 * 解出嵌入 JWT 的 `resource.dashboard` 与 `params.tenant`（**不验签**：本套件读的是
 * 「token 里锁了哪个租户」，签名真伪由 Metabase 侧判——验签会在本机需要 secret，那是凭据面）。
 *
 * 读不出就是读不出 ⇒ **抛**。**不许**回落成 `{ tenant: undefined }` 把判据放空
 * （那会让「token 没锁租户」这种最严重的情形被判成「与 org 不符」之外的空过）。
 *
 * @param {string} token @returns {{ dashboardId: number, tenant: string }}
 */
export function decodeEmbedToken(token) {
  /** @param {string} why @returns {never} */
  const bad = (why) => { throw new Error(`嵌入 token ${why}：读不出 dashboard/tenant，判据无从成立`) }
  if (typeof token !== 'string') bad('不是字符串')
  const parts = token.split('.')
  if (parts.length !== 3) bad(`不是三段式 JWT（${parts.length} 段）`)
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    bad('payload 不是合法 JSON')
  }
  const dashboardId = payload?.resource?.dashboard
  const tenant = payload?.params?.tenant
  if (typeof dashboardId !== 'number' || typeof tenant !== 'string') {
    bad('payload 缺 resource.dashboard（数字）或 params.tenant（字符串）')
  }
  return { dashboardId, tenant }
}

/**
 * 面② 判定 —— **本套件的「最可能漏的一条」**。
 *
 * 判据（两侧互为对方的断言面，且先验正面信号）：
 *   · token 的 `params.tenant` 必须 = **该侧调用者的 org**（locked 参数被改写 = 数据门失守）；
 *   · A 的 body 里不许出现 B 的探针；**B 的 body 里不许出现 A 的探针**（← 缓存重放的红线）；
 *   · 每侧的 body 里**必须出现自己的探针**，否则该侧「拿到数据了没有」无从判定 ⇒ 红。
 *
 * @param {{ a: { org: string, claims: { dashboardId: number, tenant: string }, body: string },
 *           b: { org: string, claims: { dashboardId: number, tenant: string }, body: string },
 *           probes: { a: string, b: string } }} args
 * @returns {Judgement}
 */
export function judgeEmbedReplay({ a, b, probes }) {
  const out = clean()

  // 两侧各判一次（**不写成 [['A',a],['B',b]] 的异质元组数组**：checkJs 会把元素类型加宽成
  // `string | {…}`，那是本仓在案的类型书写陷阱 —— 团队记忆「单形状、字段恒在」。）
  /** @param {string} label @param {{ org: string, claims: { dashboardId: number, tenant: string } }} side */
  const checkTenantLock = (label, side) => {
    if (side.claims.tenant !== side.org) {
      out.violations.push({
        surface: 'embed-replay',
        message: `面② 租户 ${label} 的嵌入 token 里 params.tenant='${side.claims.tenant}' ≠ 该侧 org=`
          + `'${side.org}'：locked 参数被改写 ⇒ 数据门失守（token 里的 tenant 必须恒等于调用者身份）。`,
      })
    }
  }
  checkTenantLock('A', a)
  checkTenantLock('B', b)

  // 对侧数据出现在本侧 = 串租户。B 侧命中 A 的探针**正是缓存重放的形态**，措辞要点名。
  const aLeak = a.body.includes(probes.b)
  const bLeak = b.body.includes(probes.a)
  if (bLeak) {
    out.violations.push({
      surface: 'embed-replay',
      message: `面② **缓存重放**：租户 B 的嵌入响应里出现**租户 A 的数据**（探针 '${probes.a}'）`
        + '—— 即「B 查同一张卡拿到了 A 的那份」。Metabase 结果缓存的 key 若不含 locked 参数，'
        + '就是这个形态：接口形状与正常完全一样（200 + 数据），只有下探内容才看得见。',
    })
  }
  if (aLeak) {
    out.violations.push({
      surface: 'embed-replay',
      message: `面② 串租户（反方向）：租户 A 的嵌入响应里出现**租户 B 的数据**（探针 '${probes.b}'）。`,
    })
  }

  // 正面信号：每侧都必须看得见自己的探针，否则「没重放」与「没数据」分不开。
  if (!a.body.includes(probes.a)) {
    out.violations.push({
      surface: 'embed-replay',
      message: `面② 正面信号缺席：租户 A 的嵌入响应里一次都没出现**本侧探针** '${probes.a}'`
        + ' ⇒ 「A 没看到 B 的数据」这条**无法判定**（空响应、报错页、桩没覆盖都会是这个形态）。',
    })
  }
  if (!b.body.includes(probes.b)) {
    out.violations.push({
      surface: 'embed-replay',
      message: `面② 正面信号缺席：租户 B 的嵌入响应里一次都没出现**本侧探针** '${probes.b}'`
        + ' ⇒ 「B 没拿到 A 的缓存副本」与「B 根本没拿到数据」在这个响应里分不开（**不要**据此判绿）。',
    })
  }

  // 结构性观察：两侧 token 是否指向同一张卡。**同一张**才存在「一份缓存被两个租户读」的结构；
  // 不同卡时重放风险不在跨卡缓存上，但仍在本租户的缓存面上 —— 两种都要如实记下。
  if (a.claims.dashboardId === b.claims.dashboardId) {
    out.notes.push(
      `面② 两侧 token 指向**同一张 dashboard**（id=${a.claims.dashboardId}）：这是「一份缓存被两个`
      + '租户读」的结构形态（计划设想的共享卡），重放风险最高，本面的红线判据尤其关键。',
    )
  } else {
    out.notes.push(
      `面② 两侧 token 各自指向**不同的** dashboard（A=${a.claims.dashboardId} / B=`
      + `${b.claims.dashboardId}）：与 T7 的按 org 命名空间（\`<org>/<title>\`）实现一致 ⇒ `
      + '跨租户共享卡的重放路径在这个部署形态下不存在；本面仍然验证了同租户缓存面与 tenant 锁定。',
    )
  }
  return out
}

// ═══ 判定：面③ 凭据负测 ═══════════════════════════════════════════════════════════════

/** 「读失败的原因看起来像**授权拒绝**」的判据（不像 ⇒ 负测的通过不可采信）。 */
const DENIAL_RE = /permission|access denied|not authorized|forbidden|unauthoriz|scope|403/i

/**
 * 面③ 判定 —— 从数据面反向验 T11 的凭据/schema 结构性隔离。
 *
 * 三档，**每一档都要能被看见**：
 *   · **正对照失败**（读不了自己的桶）⇒ 红：环境本身坏了，负测的「通过」毫无意义；
 *   · 负测**读成功了**（读到了 B 的桶）⇒ 红：凭据没收紧，结构性隔离的反证失败；
 *   · 负测失败但**原因不像授权拒绝**（连不上 / 没装扩展 / 路径拼错）⇒ 红：信号不可采信 ——
 *     不然「pg_duckdb 没装」会让本面**恒过**。
 *
 * @param {{ ownPath: string, foreignPath: string,
 *           positive: { ok: boolean, error: string },
 *           negative: { ok: boolean, error: string } }} args
 * @returns {Judgement}
 */
export function judgeCredentialProbe({ ownPath, foreignPath, positive, negative }) {
  const out = clean()

  if (positive.ok !== true) {
    out.violations.push({
      surface: 'credential',
      message: `面③ **正对照失败**：租户 A 的 PG role 读**自己的**桶路径 ${ownPath} 就失败了`
        + `（${positive.error}）⇒ 环境本身坏了（pg_duckdb 未装 / 凭据错 / 网络不通），`
        + '负测的「通过」毫无意义（空转防护）。先修环境，再读本面结论。',
    })
  } else {
    out.notes.push(`面③ 正对照通过：A 的 role 能读自己的 ${ownPath}`)
  }

  if (negative.ok === true) {
    out.violations.push({
      surface: 'credential',
      message: `面③ **凭据未收紧**：租户 A 的 PG role 直接 read_parquet 读到了**租户 B 的**桶路径 `
        + `${foreignPath}（应当被 USER MAPPING/SCOPE 拦住）—— 结构性隔离的反证失败，`
        + '两条租户的数据面完全没有分开。',
    })
  } else if (!DENIAL_RE.test(negative.error)) {
    out.violations.push({
      surface: 'credential',
      message: `面③ 负测失败的原因**不像授权拒绝**（${foreignPath} → ${negative.error}）：`
        + '「读不到」这个信号**不可采信**——连不上 / 未装 pg_duckdb / 路径拼错都会是这个样子。'
        + '必须拿到明确的权限/scope 级拒绝才算隔离成立。',
    })
  } else {
    out.notes.push(`面③ 负测被拦：读 ${foreignPath} 报「${negative.error}」`)
  }
  return out
}

// ═══ 判定：面④ L2 词表 ═════════════════════════════════════════════════════════════════

/**
 * 从 GET /metrics 的响应里取 id 列表；形状坏 ⇒ `null`（**不许**回落成 `[]`）。
 * @param {any} body @returns {string[] | null}
 */
function metricIdsOf(body) {
  const list = body?.metrics
  if (!Array.isArray(list)) return null
  return list.map((/** @type {any} */ m) => (typeof m?.id === 'string' ? m.id : ''))
}

/**
 * 从 MCP tools/list 的响应里取 name 列表；形状坏 / 协议级错误 ⇒ `null`。
 * @param {any} body @returns {string[] | null}
 */
function toolNamesOf(body) {
  if (body?.error !== undefined) return null
  const list = body?.result?.tools
  if (!Array.isArray(list)) return null
  return list.map((/** @type {any} */ t) => (typeof t?.name === 'string' ? t.name : ''))
}

/**
 * 面④ 判定 —— L2 词表裁剪（两条通道**各判各的**）。
 *
 * `routes/metrics.ts` 与 `routes/mcp.ts` 是两份独立的 `visibleMetrics(...)` 调用面 ⇒
 * 只判一条等于漏一半。形状坏（缺 `metrics` / 缺 `result.tools` / 协议级 error）**不算空词表**：
 * 读不出 ≠ 没有，回落成空会把「端点坏了」显示成「裁剪生效」。
 *
 * @param {{ foreignMetricIds: string[], metrics: any, tools: any }} args
 * @returns {Judgement}
 */
export function judgeCatalog({ foreignMetricIds, metrics, tools }) {
  const out = clean()
  const viaMetrics = metricIdsOf(metrics)
  const viaTools = toolNamesOf(tools)

  if (viaMetrics === null) {
    out.violations.push({
      surface: 'catalog',
      message: '面④ GET /metrics 的响应**形状读不出**（缺 `metrics` 数组）：本面无法判定 —— '
        + '读不出不许当「空词表」放过（那会把「端点坏了」显示成「裁剪生效」）。',
    })
  }
  if (viaTools === null) {
    out.violations.push({
      surface: 'catalog',
      message: '面④ MCP tools/list 的响应**形状读不出**（缺 `result.tools` 数组，或回了协议级 error）：'
        + '本面无法判定 —— 同上，读不出 ≠ 没有。',
    })
  }

  for (const id of foreignMetricIds) {
    if (viaMetrics !== null && viaMetrics.includes(id)) {
      out.violations.push({
        surface: 'catalog',
        message: `面④ 串租户：GET /metrics 的词表里出现**对侧租户定义的 L2 指标** '${id}'`
          + `（租户 A 的 PAT 不该看见 B org 的词表）—— 词表裁剪没生效。`,
      })
    }
    if (viaTools !== null && viaTools.includes(id)) {
      out.violations.push({
        surface: 'catalog',
        message: `面④ 串租户：MCP **tools/list** 里出现**对侧租户定义的 L2 指标** '${id}'`
          + '（这是与 GET /metrics 独立的第二条通道，必须各判各的）。',
      })
    }
  }

  if (viaMetrics !== null && viaTools !== null && out.violations.length === 0) {
    out.notes.push(
      `面④ 两条通道都看不到对侧指标：GET /metrics ${viaMetrics.length} 项 / tools/list `
      + `${viaTools.length} 项，对侧 ${foreignMetricIds.length} 个 id 均未出现。`,
    )
  }
  return out
}

// ═══ 编排 ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} SuiteDeps
 * @property {SuiteConfig} config
 * @property {(url: string, init?: any) => Promise<any>} fetch 注入点（生产 = 全局 fetch）
 * @property {(s3Path: string) => Promise<{ ok: boolean, error: string }>} readParquet
 *   以**租户 A 的 PG role** 试读某个桶路径（生产 = 真连 pg_duckdb，见 `probeReadParquet`）
 */

/**
 * 一次带 PAT 的 JSON 调用（非 2xx / 非 JSON 一律抛 —— 读不出就是读不出）。
 * @param {SuiteDeps} deps @param {string} method @param {string} path @param {string} pat
 * @param {unknown} [body] @returns {Promise<any>}
 */
async function callJson(deps, method, path, pat, body) {
  const res = await deps.fetch(`${moduleApiBase(deps.config.platformUrl)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${pat}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res || res.ok !== true) {
    throw new Error(`${method} ${path} → HTTP ${String(res?.status)}（PAT 失效 / 路径或前缀不对？）`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error(`${method} ${path} → 2xx 但不是 JSON：读不出，不许当空结果`)
  }
}

/**
 * 取某一侧的嵌入 URL（走平台的 embed-url 端点 —— 那也是 locked tenant 的唯一落点）。
 * @param {SuiteDeps} deps @param {TenantEnv} tenant @param {string} reportId @returns {Promise<string>}
 */
async function embedUrlOf(deps, tenant, reportId) {
  const body = await callJson(deps, 'GET', `/reports/${encodeURIComponent(reportId)}/embed-url`, tenant.pat)
  if (typeof body?.url !== 'string' || body.url === '') {
    throw new Error(`embed-url 响应里没有 url（拿到 ${JSON.stringify(body)}）`)
  }
  return body.url
}

/**
 * 取嵌入页正文（iframe 背后就是它；判定只看正文里有没有探针）。
 * @param {SuiteDeps} deps @param {string} url @returns {Promise<string>}
 */
async function embedBodyOf(deps, url) {
  const res = await deps.fetch(url)
  if (!res || res.ok !== true) throw new Error(`嵌入页 ${url} → HTTP ${String(res?.status)}`)
  return await res.text()
}

/**
 * 跑完四面，收齐 violations 与 notes（I/O 全经 `deps`，故单测可全桩）。
 * @param {SuiteDeps} deps @returns {Promise<Judgement>}
 */
export async function runSuite(deps) {
  const { config } = deps
  const out = clean()
  /** @param {Judgement} j */
  const merge = (j) => { out.violations.push(...j.violations); out.notes.push(...j.notes) }

  // ── 面① 问数 API（A 的 PAT 逐指标；方向 A→B，与计划 L950–954 逐字一致）──────────────
  for (const metricId of config.metricIds) {
    const outcome = await callJson(deps, 'POST', '/query', config.tenantA.pat, { metricId, args: {} })
    merge(judgeQueryResult({
      tenant: config.tenantA.org,
      probe: config.tenantA.probe,
      foreignProbe: config.tenantB.probe,
      outcome,
    }))
  }

  // ── 面② 嵌入缓存重放（A 先查一次 → B 查同一张卡 → B 必须拿到 B 的数据）──────────────
  const aUrl = await embedUrlOf(deps, config.tenantA, config.reportIdA)
  const aBody = await embedBodyOf(deps, aUrl)
  const bUrl = await embedUrlOf(deps, config.tenantB, config.reportIdB)
  const bBody = await embedBodyOf(deps, bUrl)
  merge(judgeEmbedReplay({
    a: { org: config.tenantA.org, claims: decodeEmbedToken(aUrl.split('/public/dashboard/')[1] ?? ''), body: aBody },
    b: { org: config.tenantB.org, claims: decodeEmbedToken(bUrl.split('/public/dashboard/')[1] ?? ''), body: bBody },
    probes: { a: config.tenantA.probe, b: config.tenantB.probe },
  }))

  // ── 面③ 凭据负测（A 的 role：正对照读自己 / 负测读 B）────────────────────────────────
  const positive = await deps.readParquet(config.credential.ownS3Path)
  const negative = await deps.readParquet(config.credential.foreignS3Path)
  merge(judgeCredentialProbe({
    ownPath: config.credential.ownS3Path,
    foreignPath: config.credential.foreignS3Path,
    positive,
    negative,
  }))

  // ── 面④ L2 词表（A 的 PAT 两条通道）────────────────────────────────────────────────
  const metrics = await callJson(deps, 'GET', '/metrics', config.tenantA.pat)
  const tools = await callJson(deps, 'POST', '/mcp', config.tenantA.pat, {
    jsonrpc: '2.0', id: 1, method: 'tools/list',
  })
  merge(judgeCatalog({ foreignMetricIds: config.foreignMetricIds, metrics, tools }))

  return out
}

// ═══ 生产 I/O：pg_duckdb 试读 ══════════════════════════════════════════════════════════

/**
 * SQL 字面量转义（单引号加倍）。
 * @param {string} s @returns {string}
 */
const quoteLiteral = (s) => `'${String(s).replaceAll("'", "''")}'`

/**
 * 以 `dsn` 的身份试读一个 parquet 路径（**真的执行**，不模拟）。
 *
 * ⚠️ `pg` 解析锚到 `apps/server`：pnpm workspace 里 `pg` 是 apps/server 的依赖，而 `scripts/`
 * 不属于任何包 —— 裸 `import 'pg'` 在仓库根/容器里都解析不到（与 `reconcile-data-tenants.mjs`
 * / `migrate-tenant-module-to-subs.mjs` 同坑同修）。
 *
 * 连接失败**不抛**：回落成 `{ok:false,error}` 交给 `judgeCredentialProbe` 判 —— 那正是
 * 「正对照失败 ⇒ 红（空转防护）」要吃掉的那种形态。抛出去会变成 exit 2，把「环境坏了」
 * 与「隔离没成立」混为一谈。
 *
 * @param {string} dsn @param {string} s3Path
 * @returns {Promise<{ ok: boolean, error: string }>}
 */
export async function probeReadParquet(dsn, s3Path) {
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Client } = requireFromServer('pg')
  const client = new Client({ connectionString: dsn })
  try {
    await client.connect()
    // LIMIT 0 也要真去解析路径/对象 ⇒ 权限与 SCOPE 判据照样触发，且不拉数据。
    await client.query('select 1 from read_parquet(' + quoteLiteral(s3Path) + ') limit 0')
    return { ok: true, error: '' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await client.end().catch(() => {})
  }
}

// ═══ CLI ═══════════════════════════════════════════════════════════════════════════════

/** `--help` 正文：env 契约从 `ENV_SPEC` 派生（单一事实源，别在别处复述）。 */
export function helpText() {
  const lines = [
    '串租户回归套件（issue #150 / 计划 Task 12；spec 验收 #2）—— 四面：问数 / 嵌入缓存重放 / 凭据负测 / L2 词表',
    '',
    '用法：pnpm exec tsx scripts/e2e-data-cross-tenant.mjs           # 四面全跑',
    '      pnpm exec tsx scripts/e2e-data-cross-tenant.mjs --help    # 本页',
    '',
    '出口码：0 = 四面全过；1 = 有 violation（逐条打印）；2 = 跑不起来（缺 env / 配置矛盾 / 连不上）',
    '',
    'env 契约（两租户的 org / PAT / 探针 + 仓库 DSN + 对侧指标 id；**值只经 env，不进 git**）：',
  ]
  for (const s of ENV_SPEC) {
    lines.push(`  ${s.key.padEnd(26)}${s.help}${s.secret ? '  【敏感：值不许进任何输出】' : ''}`)
  }
  lines.push(
    '',
    '⚠️ 本套件**从未在两租户真栈上跑过**（真栈那一面归 T13），且面③ 依赖 T11 的 SCOPE 真实收窄',
    '   （该 DDL 形状 T11 自述「键名未验」）⇒ 面③ 若红，第一嫌疑是 T11 的 USER MAPPING 形状。',
    '建议：并入 reconcile job（或独立低濒 job）定时跑 —— 退出码就是信号面，不靠人读日志。',
  )
  return lines.join('\n')
}

/**
 * 打印判定结果（violation **逐条**、带面标签；notes 另起一段，不混进违规）。
 * @param {Judgement} j
 */
function printJudgement(j) {
  for (const n of j.notes) console.log(`[e2e-cross-tenant] · ${n}`)
  if (j.violations.length === 0) {
    console.log('[e2e-cross-tenant] OK：四面全过（问数 / 嵌入缓存重放 / 凭据负测 / L2 词表）')
    return
  }
  console.log(`[e2e-cross-tenant] ${j.violations.length} 条 violation（逐条如下）：`)
  for (const [i, v] of j.violations.entries()) {
    console.log(`  ${i + 1}. [${v.surface}] ${v.message}`)
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(helpText())
    process.exitCode = EXIT_CLEAN
    return
  }
  let config
  try {
    config = loadConfig(process.env)
  } catch (e) {
    console.error(`[e2e-cross-tenant] 跑不起来（exit 2）：${/** @type {Error} */ (e).message}`)
    console.error('[e2e-cross-tenant] 完整 env 契约见 --help')
    process.exitCode = EXIT_CANNOT_RUN
    return
  }

  let judgement
  try {
    judgement = await runSuite({
      config,
      fetch: /** @type {any} */ (fetch),
      readParquet: (p) => probeReadParquet(config.credential.dsn, p),
    })
  } catch (e) {
    console.error(`[e2e-cross-tenant] 跑不起来（exit 2）：${/** @type {Error} */ (e).message}`)
    console.error('[e2e-cross-tenant] 「跑不起来」与「串租户」是两回事：先修环境，别把 exit 2 读成隔离通过')
    process.exitCode = EXIT_CANNOT_RUN
    return
  }

  printJudgement(judgement)
  process.exitCode = judgement.violations.length === 0 ? EXIT_CLEAN : EXIT_VIOLATION
}

if (process.argv[1]?.endsWith('e2e-data-cross-tenant.mjs')) {
  main().catch((e) => {
    console.error(`[e2e-cross-tenant] 意外失败（exit 2）：${/** @type {Error} */ (e).message}`)
    process.exit(EXIT_CANNOT_RUN)
  })
}
