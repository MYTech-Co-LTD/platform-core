#!/usr/bin/env node
// reconcile-tenant-sources.mjs — 对账③：平台「租户已接入源」登记 ↔ console env 声明
// （issue #389 / 计划 5 Task 6；spec 2026-09-28-report-authoring-design §3⑧ + 待办 6 的 ③）。
//
// 用法：DATABASE_URL=<平台库> \
//         ADOPTED_SOURCES_3120=lemeng ADOPTED_SOURCES_64188=lemeng \
//         pnpm exec tsx scripts/reconcile-tenant-sources.mjs [--json]
//       **声明的值从 openship 项目 env 取**（控制面 dashboard 里该项目的 `ADOPTED_SOURCES_<账套>`
//       ——与 compose 里那两个 console 服务注入的是同一个键）。
//       ⚠️ **不要**去 SSH 读 console 的 env（那是读**机器状态**，违反「唯一通道」铁律：
//       运维面一律经 openship，脚本只接受**运行方传进来的**声明）。
// 契约：干净 → exit 0（stdout 一行结论 + 每桶计数）；有差集 → exit 1，**逐条打印**；
//       无法对账（缺 env / 查询失败 / 一个 console 声明都没有）→ exit 2（「对不成账」与「对账发现
//       漂移」必须可区分 —— 前者是脚本/环境坏了，后者是被观测的系统漂移了，处置完全不同）。
//
// ── 为什么是一个 scripts/ 脚本，而不是模块的一个端点 ─────────────────────────────
// 它要读 `platform.tenant_source`——**模块结构性读不到**（B1：`modules/**` 只许碰自己的 schema；
// 见 `scripts/lint-architecture.mjs`）。这条对账与「谁接了哪个源」的登记同源（计划 5 Task 1 的表
// 之所以落 platform schema，就是这条约束推出来的），⇒ 对账只能落在模块之外。`scripts/` 不在 B1
// 的扫描根内，先例是 `scripts/reconcile-data-tenants.mjs`（同型对账）与 `check-tenant-isolation.mjs`
// （同样直连真库）。**模块侧不得加此端点。**
//
// ── 为什么要对账（「声明不是事实」）──────────────────────────────────────────────
// 平台侧登记（`platform.tenant_source`）是**裁决用的事实**：词表按租户已接入源裁剪、未接入源的
// 写入闸 403，都在**请求路径**上读它。而 console 侧只有一句**声明**（`ADOPTED_SOURCES_<账套>`），
// 它说「这个账套在采这些源」。两侧一旦分叉，症状是**静默**的：平台以为没人采（或反之），
// 而你从任何一条请求的返回里都看不出来 ⇒ 故必须有一处**显式**把差集打出来、并用退出码让
// openship job 变红（不靠人去读日志）。
//
// ── 四桶各是什么（口径写死在这里，别在别处复述）────────────────────────────────
// 声明侧 = console env `ADOPTED_SOURCES_<账套>`（**一账套一 console**，ADR-0014）；键在而值为空
// = 「该 console 一个源都没声明」（合法）。平台侧 = `platform.tenant_source` 的 (租户, 源, enabled)。
//   · `missingInConsole`    —— 平台**有该源的启用行**，但没有任何 console 声明它。
//                              处置：补 console env，或在平台停用。
//   · `missingInPlatform`   —— console **声明**了该源，而平台**一行都没有**。
//                              处置：补登记（开通流程 / `PUT /sources`）——「有人接了源没登记」。
//   · `disabledButDeclared` —— 平台该源**有停用行**（`enabled=false`），而该源**被 console 声明**。
//                              处置：要么恢复启用、要么确认这次停用是有意的（逐行给）。
//   · `declaredButDisabled` —— console 声明了该源，而平台侧**没有任何租户启用它**（整源停用）。
//                              处置：同上，但这是「平台整体不认这个源」的更强信号（逐条声明给）。
// ③④ 是**同一族漂移的两侧视图**（与 ①② 是集合差的两个方向同理）：③ 按**平台行**出（哪几行停在
// `enabled=false`），④ 按 **console 声明**出（哪几条 env 打在平台侧整体不启用的源上）。两侧各报一次
// 不是重复：要动的动作分属两侧（平台侧恢复启用、console 侧摘声明），修复各自认自己那侧的行。
// 判据不许被放宽：④ 的条件是「**没有任何**启用行」（混合态 = 有租户启用、有租户停用 ⇒ 只进 ③，
// 不进 ④）；平台**一行都没有**归 ②，不归 ④。
//
// ── 为什么 console 声明由运行方传入（而不是脚本自己去取）────────────────────────
// console 的 env 只有两个来源：机器上的容器（要 SSH ⇒ 违反唯一通道）与 **openship 项目 env**
// （要控制面凭据，不在本脚本的凭据面内）。本脚本只管**对账算法**，声明值由调用方给 ——
// 与 `reconcile-data-tenants.mjs` 把两个连接串交给调用方是同一个边界。
//
// ── 读法口径 ────────────────────────────────────────────────────────────────────
// 本脚本自己**不建也不改任何东西**（只读 + 打印）⇒ 不需要幂等处理。

import { createRequire } from 'node:module'

/** console 声明键的**宿主侧**前缀：`<前缀><账套>` = 该账套的 console 声明的源（逗号分隔）。 */
export const ADOPTED_SOURCES_PREFIX = 'ADOPTED_SOURCES_'

/** 排序比较器：对账输出要能逐字 diff ⇒ **不用 localeCompare**（顺序不许随本机 locale 抖）。 */
const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 就地按 (左键, 右键) 逐级排序（与输入顺序无关 ⇒ 输出可逐字 diff）。
 * @template {{ [k: string]: any }} T
 * @param {T[]} items
 * @param {string} left 一级键名（①③ 是 `org`，②④ 是 `console`）
 * @param {string} right 二级键名（一律 `source`）
 * @returns {T[]}
 */
function sortEntries(items, left, right) {
  return items.sort((a, b) => cmp(a[left], b[left]) || cmp(a[right], b[right]))
}

/**
 * console env → 声明清单（**纯函数**，便于不起进程钉住解析语义）。
 *
 * 认的键：`ADOPTED_SOURCES_<账套>`（值 = 逗号分隔的源；trim、去空、去重）。
 * 不认的两种形态**响亮失败**（fail-closed）——它们都会让「哪条声明属于谁/对不成账」变成猜：
 *   · 裸 `ADOPTED_SOURCES`（没有账套后缀）：那是**容器内**看到的键名，宿主侧必须带账套号
 *     （账套号是输出的身份，缺了就只能打一句「某个 console 声明了它」）。
 *   · 空账套号（`ADOPTED_SOURCES_` / `ADOPTED_SOURCES_   `）。
 *
 * 返回值把「键在场但值为空」（该 console 一个源都没声明，**合法**）与「一个前缀键都没有」
 * （调用方据此判 exit 2）分开：前者 `consoles` 非空而 `decls` 为空。
 *
 * `consoles` 与 `decls` 都**排序后**返回（`env` 的键顺序 = 进程环境/对象字面量的插入顺序，
 * 不许让它渗进对账输出：同一份声明换个人导出 env，打印与 `--json` 必须逐字一致）。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ consoles: string[], decls: Array<{ console: string, source: string }> }}
 */
export function parseConsoleDecls(env) {
  if (Object.prototype.hasOwnProperty.call(env, 'ADOPTED_SOURCES')) {
    throw new Error(
      'env 里有裸 `ADOPTED_SOURCES`：那是**容器内**的键名。宿主侧请用带账套号的形态'
      + `（如 \`${ADOPTED_SOURCES_PREFIX}3120=lemeng\`）——账套号是对账输出的身份，不能省。`,
    )
  }
  /** @type {Array<{ console: string, source: string }>} */
  const decls = []
  /** @type {string[]} */
  const consoles = []
  for (const name of Object.keys(env).filter((k) => k.startsWith(ADOPTED_SOURCES_PREFIX))) {
    const consoleId = name.slice(ADOPTED_SOURCES_PREFIX.length).trim()
    if (consoleId === '') throw new Error(`env 键 \`${name}\` 的账套号是空的：认不出这是哪个 console，不静默拼一个匿名 console`)
    consoles.push(consoleId)
    const value = env[name] ?? ''
    const sources = new Set(value.split(',').map((s) => s.trim()).filter((s) => s !== ''))
    for (const source of [...sources].sort(cmp)) decls.push({ console: consoleId, source })
  }
  return { consoles: consoles.sort(cmp), decls: sortEntries(decls, 'console', 'source') }
}

/**
 * 四桶双向差集（**纯核**；元素形状刻意**字段恒在** —— `scripts/` 是 checkJs，JSDoc 字面量类型
 * 会被加宽 ⇒ 可辨识联合在这里会静默失效，桶内元素一律「字段恒在」，取值里表达差异不表达在类型里）。
 *
 * 桶的判据（谁进谁不进）见文件头注，**别在这里放宽**：④ 必须是「平台侧没有任何租户启用」，
 * 不是「存在停用行」；② 必须是「平台一行都没有」。
 *
 * 行/声明重复喂进来不会让桶里出现两遍（幂等：重复数据不该被读成两条漂移）。
 *
 * @param {ReadonlyArray<{ org: string, source: string, enabled: boolean }>} platformRows
 * @param {ReadonlyArray<{ console: string, source: string }>} consoleDecls
 * @returns {{
 *   missingInConsole: Array<{ org: string, source: string }>,
 *   missingInPlatform: Array<{ console: string, source: string }>,
 *   disabledButDeclared: Array<{ org: string, source: string, consoles: string[] }>,
 *   declaredButDisabled: Array<{ console: string, source: string, orgs: string[] }>,
 *   clean: boolean,
 * }}
 */
export function diffSources(platformRows, consoleDecls) {
  // 行去重（键含 enabled：同一 (租户,源) 不会两态并存，但输入重复不该变成两条漂移）
  const rows = new Map()
  for (const r of platformRows) rows.set(`${r.org}\u0000${r.source}\u0000${r.enabled}`, r)
  // 声明去重（同 console 同源只算一条）
  const decls = new Map()
  for (const d of consoleDecls) decls.set(`${d.console}\u0000${d.source}`, d)

  /** @type {Map<string, string[]>} 源 → 声明它的 console（排序后） */
  const declaredBy = new Map()
  for (const d of decls.values()) {
    const list = declaredBy.get(d.source) ?? []
    list.push(d.console)
    declaredBy.set(d.source, list)
  }
  for (const [source, list] of declaredBy) declaredBy.set(source, [...new Set(list)].sort(cmp))

  /** @type {Map<string, string[]>} 源 → 启用它的租户（有序：插入序后统一排序） */
  const enabledBy = new Map()
  /** @type {Map<string, string[]>} 源 → 停用它的租户 */
  const disabledBy = new Map()
  /** 平台侧**有行**的源（判 ②/④ 的分界：一行都没有归 ②） */
  const sourcesWithRows = new Set()
  for (const r of rows.values()) {
    sourcesWithRows.add(r.source)
    const bucket = r.enabled ? enabledBy : disabledBy
    const list = bucket.get(r.source) ?? []
    list.push(r.org)
    bucket.set(r.source, list)
  }
  const orgsOf = (/** @type {Map<string, string[]>} */ m, /** @type {string} */ source) =>
    [...new Set(m.get(source) ?? [])].sort(cmp)

  /** @type {Array<{ org: string, source: string }>} */
  const missingInConsole = []
  /** @type {Array<{ org: string, source: string, consoles: string[] }>} */
  const disabledButDeclared = []
  for (const r of rows.values()) {
    if (r.enabled) {
      // ①：平台启用、没人声明（逐**平台行**出：哪几个租户的哪条登记没人认领）
      if (declaredBy.has(r.source)) continue
      missingInConsole.push({ org: r.org, source: r.source })
      continue
    }
    // ③：平台停用行、该源被声明（逐**平台行**出：哪几行停在 enabled=false）
    const consoles = declaredBy.get(r.source)
    if (!consoles) continue
    disabledButDeclared.push({ org: r.org, source: r.source, consoles })
  }

  /** @type {Array<{ console: string, source: string }>} */
  const missingInPlatform = []
  /** @type {Array<{ console: string, source: string, orgs: string[] }>} */
  const declaredButDisabled = []
  for (const d of decls.values()) {
    if (!sourcesWithRows.has(d.source)) {
      // ②：平台一行都没有（逐 **console 声明**出）
      missingInPlatform.push({ console: d.console, source: d.source })
      continue
    }
    // ④：平台有行但**没有任何启用行**（逐 **console 声明**出）
    if ((enabledBy.get(d.source) ?? []).length > 0) continue
    declaredButDisabled.push({ console: d.console, source: d.source, orgs: orgsOf(disabledBy, d.source) })
  }

  return {
    missingInConsole: sortEntries(missingInConsole, 'org', 'source'),
    missingInPlatform: sortEntries(missingInPlatform, 'console', 'source'),
    disabledButDeclared: sortEntries(disabledButDeclared, 'org', 'source'),
    declaredButDisabled: sortEntries(declaredButDisabled, 'console', 'source'),
    clean: missingInConsole.length === 0
      && missingInPlatform.length === 0
      && disabledButDeclared.length === 0
      && declaredButDisabled.length === 0,
  }
}

/** 平台库读形状：`platform.tenant_source` join `platform.tenant`（键 = casdoor org，与登记侧同源）。 */
const PLATFORM_SOURCES_SQL = `select t.casdoor_org as org, ts.source, ts.enabled
   from platform.tenant_source ts
   join platform.tenant t on t.id = ts.tenant_id
  order by t.casdoor_org, ts.source`

/** 桶内条数 → 打印用词（空 = ✓）。**逐桶**判，不用全局 `clean`（否则空桶也带 ✗，把注意力引偏）。 */
const mark = (/** @type {number} */ n) => (n === 0 ? '✓' : '✗')

async function main() {
  const asJson = process.argv.includes('--json')
  const platformUrl = process.env.DATABASE_URL
  if (!platformUrl) throw new Error('需要 DATABASE_URL（平台库）—— 口令只经 env 传，不进 argv')

  const { consoles, decls } = parseConsoleDecls(process.env)
  if (consoles.length === 0) {
    throw new Error(
      `env 里找不到任何 \`${ADOPTED_SOURCES_PREFIX}<账套>\` ⇒ **对不成账**（不是「漂移为空」）：`
      + '空声明侧会把平台侧每一行都报成①，读数全是假的。值从 openship 项目 env 取（见文件头用法）。',
    )
  }

  // pg 解析锚到 apps/server（pnpm workspace：pg 是 apps/server 的依赖；scripts/ 不属于任何包，
  // 裸 import 'pg' 在仓库根/容器里都解析不到 —— 与 reconcile-data-tenants.mjs 同坑同修）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')

  const platform = new Pool({ connectionString: platformUrl })
  try {
    const { rows } = await platform.query(PLATFORM_SOURCES_SQL)
    const diff = diffSources(rows, decls)
    const sources = new Set(rows.map((/** @type {{ source: string }} */ r) => r.source))
    const orgs = new Set(rows.map((/** @type {{ org: string }} */ r) => r.org))

    if (asJson) {
      console.log(JSON.stringify({ consoles, decls, platformRows: rows, ...diff }, null, 2))
    } else {
      console.log(`[reconcile-sources] 平台侧：platform.tenant_source ${rows.length} 行（租户 ${orgs.size} 个 / 源 ${sources.size} 个）`)
      console.log(`[reconcile-sources] console 声明：${consoles.length} 个 console（${consoles.join(', ')}）共 ${decls.length} 条`)
      console.log(`[reconcile-sources] ${mark(diff.missingInConsole.length)} 平台已启用、无 console 声明：${diff.missingInConsole.length} 条`)
      for (const m of diff.missingInConsole) {
        console.log(`  - org=${m.org} source=${m.source}（平台侧启用了这个源，但没有任何 console 声明在采它）`)
      }
      console.log(`[reconcile-sources] ${mark(diff.missingInPlatform.length)} console 声明、平台无登记：${diff.missingInPlatform.length} 条`)
      for (const m of diff.missingInPlatform) {
        console.log(`  - console=${m.console} source=${m.source}（platform.tenant_source 里一行都没有 ⇒ 补登记或摘声明）`)
      }
      console.log(`[reconcile-sources] ${mark(diff.disabledButDeclared.length)} 平台已停用、仍被声明：${diff.disabledButDeclared.length} 条`)
      for (const m of diff.disabledButDeclared) {
        console.log(`  - org=${m.org} source=${m.source} consoles=[${m.consoles.join(', ')}]（平台这一行 enabled=false，却有 console 声明在采）`)
      }
      console.log(`[reconcile-sources] ${mark(diff.declaredButDisabled.length)} console 声明、平台侧无启用：${diff.declaredButDisabled.length} 条`)
      for (const m of diff.declaredButDisabled) {
        console.log(`  - console=${m.console} source=${m.source} orgs=[${m.orgs.join(', ')}]（平台侧没有任何租户启用这个源）`)
      }
      if (diff.clean) {
        console.log('[reconcile-sources] OK：平台登记与 console 声明一致（四桶全空）')
      } else {
        console.log('[reconcile-sources] 差集非空 ⇒ exit 1（对账失败必须显式可见：openship job 靠退出码变红，不靠人读日志）')
      }
    }
    // 出口码就是 job 的信号面（干净 0 / 漂移 1）；连接池在 finally 里关
    process.exitCode = diff.clean ? 0 : 1
  } finally {
    await platform.end().catch(() => {})
  }
}

if (process.argv[1]?.endsWith('reconcile-tenant-sources.mjs')) {
  main().catch((e) => {
    console.error(`[reconcile-sources] 无法对账（exit 2）：${/** @type {Error} */ (e).message}`)
    process.exit(2)
  })
}
