#!/usr/bin/env node
// check-data-models.mjs — dbt 工件静态门禁（issue #150 / 计划 Task 4；正典 docs/architecture.md §5.1）。
//
// 用法：tsx scripts/check-data-models.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-data-models: OK（<检查面计数>）`；
//       有违规 → exit 1，stderr 每条一行 `相对路径:行号: [data-models] 说明`（无行号则为 `相对路径: …`）。
//
// ── 本门禁的**范围**（多一句都不做，别在这里扩面） ───────────────────────────────
// 只做 **dbt 工件的静态门禁**，七项（计划 L649–650 逐条）：
//   ① staging 模型必含 `r['列名']` 取列模式（坑 #5 的结构性防御）
//   ② 禁 `::double` 与 `CAST(... AS double)`（同一坑 #4：裸 `double` 去查类型名 ⇒ shell 类型，
//      报 `type "double" is only a shell`；两种写法同一条路，故同拦）
//   ③ 禁 `union_by_name`（漂移必须显式处理，不许引擎替我们猜列集）
//   ④ staging 一对一（staging 模型 ↔ sources.yml 的源，**双向**）
//   ⑤ 语义声明必填字段齐全（owner / tier / grain / definition + name / expression）
//   ⑥ 指标名 `<域>:<指标名>` 命名空间前缀 + 同名唯一（跨文件）
//   ⑦ 每个声明指标有对应 `dbt/tests/audit_<指标>.sql` + 该文件名映射无碰撞
//
// **不含**（docs/architecture.md 明写，属架构先行越权，别顺手加）：
//   · `duckle/`（T5）与 `contracts/` 不在任何扫描面内 —— 它们的 env 键等约束当前没有静态门禁；
//   · env 键齐全（B9 = scripts/check-env-example.mjs，扫描根只有 apps/ packages/ modules/，**不扫 dbt/**）
//     ⇒ `.env.example` 里那段 dbt 键是**键面事实源的文档化，不是被本门禁守住的约定**；
//   · 跨系统血缘、指标与物化结果的真值对账（那要真库：spec §10 机制④ 的对账是 singular test 的事，
//     本门禁只查「那条 test **在不在**」，不查它跑不跑得绿）。
//
// ── 三个实现判断（都写在这里，免得后来者当成漏检） ───────────────────────────────
// ① **注释位不算代码位**（规则 ①②③ 先掩掉注释再判）。这不是宽容，是必须：真实仓的 staging 注释
//    正是**点名**这两个禁忌形态来提醒后来者的（`禁 ::double` / `禁 union_by_name` 写在注释里），
//    在原文上裸跑正则会把自己规范里的话判成违规 —— 门禁一上线就会被关掉。
//    **反过来说**：注释里出现 `r['…']` 也**不算**满足规则 ①（否则「写句注释就过关」），
//    所以 ① 也跑在掩码后的文本上：两种形态一致地只看代码位。
//    已知边界：本掩码只认 `--` 与 `/* */`，不认单引号字符串、双引号标识符、`$$…$$`
//    （本仓 dbt SQL 不用这些构造；与 check-tenant-isolation.mjs 的 maskSql 同一族边界）。
//    为什么**不**直接复用 maskSql：它把单引号串也掩成空格 —— 规则 ① 要的恰恰是 `r['amount']`
//    里的引号与内容，掩掉就判不了了；且它所在模块顶层 import 了 `apps/server/src/migrate.ts`，
//    会把 pg 那条依赖链拖进一个纯静态门禁。二者需求相反，故意不合并。
// ② **两种写法一起拦、`double precision` 放行**：被判违规的是 DuckDB 的 shell 类型 `double`（坑 #4 的死法）。
//    触发条件是「**拿裸 `double` 去查 `pg_type`**」，**不是 `::` 这个运算符** ⇒ `::double` 与
//    `CAST(x AS double)` 走**同一条路**、必须同红（评审 §RR1.8 探针 G 实测：修前 `CAST` 形态逃检；
//    而 `CAST` 是比 `::` 更常见的写法）。故正则收两个句法形态：`::\s*` 与 `\bas\s+`。
//    而 `double precision` 是 PG 原生类型（`float8` 的专用拼写，**不做类型名查找**）、不是同一个东西
//    —— 负向前瞻 `(?!\s+precision)` **两个分支共用**，故放行口径对两种写法一致。
//    `as` 分支写 `\s+`（不是 `\s*`）：SQL 里 `as` 与类型名之间必然有分隔，`\s*` 只会多认下
//    `asdouble` 这类标识符（真 SQL 里不存在），是纯粹的误伤面。
//    ⚠️ 诚实标注：`double precision` 是否同样受坑 #4 影响的**未实测** —— 本条放行是「不误伤 PG
//    合法写法」的取舍，不是「已证实安全」。真出事时改这里，别改调用方。
//    ⚠️ 已知漏检（评审 M-2，本轮有意不修）：带引号的类型名 `::"double"` 同属坑 #4 形态但**不拦**
//    —— 正则要求 `double` 紧随 `::`，引号挡住了。真实仓无此写法，概率远低于 `CAST`。
// ③ **违规行号字段恒在**（`scripts/` 是 checkJs，JSDoc 字面量类型会被加宽 ⇒ 可辨识联合收窄在这里
//    会静默失效）。故 `Violation` 是**单形状、字段恒在**：`{ file, line, message }`，无行号的
//    检查项写 `line: 0`（打印时不带 `:0`，**不伪造 `:1`** —— 与 check-compose 的无行号报错同旨）。
//
// ── 声明的**落点**（T9 消费面之一，改这里必须同步改 dbt/README.md） ───────────────
// 语义声明只认顶层 `metrics:` 数组，扫描面两处：
//   · `dbt/semantics/**/*.yml`  —— 本任务选定的**唯一事实源**落点（为什么不在 marts/schema.yml：
//     指标名带冒号，而 dbt 资源名不允许冒号 ⇒ 放进 dbt 会扫的 schema 文件有让 `dbt parse` 挂掉的风险，
//     详见 dbt/README.md「L1 语义声明的落点」）；
//   · `dbt/models/**/*.yml`     —— 计划原文指的 schema.yml 落点；**一并扫**，免得两种落点各守一半。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

export const SCRIPT_NAME = 'check-data-models'
/** 违规行前缀标签（与 lint-architecture 的 [B1]/[B7]、check-compose 的 [B7] 同形，便于 grep） */
const LABEL = 'data-models'

/**
 * 违规条目（单形状、字段恒在；见头注实现判断③）。
 * @typedef {{ file: string, line: number, message: string }} Violation
 */

/** dbt 工程目录名（相对 rootDir） */
const DBT_DIR = 'dbt'
/** 不进入的目录：依赖 + VCS + **dbt 构建产物**（`dbt parse` 会生成 target/ 与 logs/，
 *  logs/dbt.log 里带编译后的 SQL —— 扫进去等于把构建产物当源文件判，且本地的与 CI 的还不一样） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'logs', 'dbt_packages', 'dbt_modules', '.tmp'])
/** staging 模型：`dbt/models/**\/staging/stg_*.sql` */
const STAGING_RE = /^dbt\/models\/(?:.+\/)?staging\/stg_[A-Za-z0-9_]+\.sql$/
/** 规则 ①：`r['列名']`（单双引号都算；坑 #5 要的是「点名取列」这个构造，不是某一种引号） */
const R_COLUMN_RE = /r\s*\[\s*['"]/
/** 规则 ②：DuckDB shell 类型 `double`——**两种写法都拦**（`::double` 与 `CAST(x AS double)`，见头注判断②）；`double precision` 是 PG 原生类型 ⇒ 放行 */
const DOUBLE_CAST_RE = /(?:::\s*|\bas\s+)double\b(?!\s+precision)/gi
/** 规则 ③：`union_by_name` 兜列集漂移 */
const UNION_BY_NAME_RE = /union_by_name/gi
/** 规则 ⑥：指标名的命名空间形态 `<域>:<指标名>`（两段都小写蛇形） */
const METRIC_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/
/** 规则 ⑤：语义声明必填字段（owner/tier/grain/definition + name/expression；见计划 Step 4 的字段清单） */
const REQUIRED_METRIC_FIELDS = ['expression', 'grain', 'owner', 'tier', 'definition']

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/')

/**
 * 掩掉 SQL 注释（`--` 行注释与 `/* *​/` 块注释），**保持长度与行号一一对应**（与
 * check-tenant-isolation.mjs 的 maskSql 同一手法，但**不掩字符串** —— 见头注判断①）。
 *
 * @param {string} src
 * @returns {string}
 */
export function maskSqlComments(src) {
  let out = ''
  let state = 'code' // code | line | block
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '-' && n === '-') {
        state = 'line'
        out += '  '
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i++
      } else out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += ' '
      continue
    }
    // block
    if (c === '*' && n === '/') {
      state = 'code'
      out += '  '
      i++
    } else out += c === '\n' ? '\n' : ' '
  }
  return out
}

/**
 * 从掩码后的文本里找第一条命中，返回其 1 起的行号（找不到返回 0）。
 * @param {string} masked @param {RegExp} re @returns {number}
 */
function firstMatchLine(masked, re) {
  re.lastIndex = 0
  const m = re.exec(masked)
  if (!m) return 0
  let line = 1
  for (let i = 0; i < m.index; i++) if (masked[i] === '\n') line++
  return line
}

/**
 * 指标名 → 对账 singular test 的**文件名**（不含目录）。**本映射只有这一处事实源**：
 * 计划 L645 要求 T9 的机检消费同一条规则、不许两个 worker 各造一套 —— 故它是导出函数，
 * 文档只引用、不复述（详细语义见 dbt/README.md「T9 接口」）。
 *
 * 语义三条（逐字）：① 入参 = 语义声明的 `name` 原值（`<域>:<指标名>` 命名空间形态）；
 * ② **每一个** `:` 都替换成 `__`（不是只换第一个；名字里若还有别的下划线一律不动）；
 * ③ 返回值 `audit_<替换后>.sql`，落点是 `dbt/tests/`。
 *
 * @param {string} metricName @returns {string}
 */
export function metricToAuditFileName(metricName) {
  return `audit_${metricName.replace(/:/g, '__')}.sql`
}

/**
 * 递归列出 rootDir 下的**文件**（相对 rootDir 的 posix 路径）。
 * @param {string} rootDir @param {string} startRel @returns {string[]}
 */
function listFiles(rootDir, startRel) {
  /** @type {string[]} */
  const out = []
  /** @param {string} rel */
  const walk = (rel) => {
    const abs = join(rootDir, rel)
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return // 目录不存在：本门禁的适用面为空（见头注：不要求 dbt/ 必须存在）
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(childRel)
        continue
      }
      if (entry.isFile()) out.push(childRel)
    }
  }
  walk(startRel)
  return out.sort()
}

/**
 * 读 YAML（顶层必须是个映射；解析失败 → 抛，由调用方转成违规 —— fail-closed：
 * 解析不动的声明文件不能当成「没有声明」）。
 * @param {string} absPath @returns {any}
 */
function readYaml(absPath) {
  const doc = parseYaml(readFileSync(absPath, 'utf8'))
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return {}
  return doc
}

/** @param {any} v @returns {string} */
const asText = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 主入口：对 rootDir 下的 `dbt/` 跑七项检查。
 * @param {string} rootDir @returns {Violation[]}
 */
export function checkDataModels(rootDir) {
  /** @type {Violation[]} */
  const violations = []
  const push = (/** @type {string} */ file, /** @type {number} */ line, /** @type {string} */ message) =>
    violations.push({ file, line, message })

  const allFiles = listFiles(rootDir, DBT_DIR)
  /** .sql 源文件（含 macros/tests） */
  const sqlFiles = allFiles.filter((f) => f.endsWith('.sql'))
  /** yml 源文件（模型层与声明层；`dbt_project.yml` / `profiles.example.yml` 不在此列） */
  const ymlFiles = allFiles.filter((f) => /\.ya?ml$/.test(f) && (f.startsWith(`${DBT_DIR}/models/`) || f.startsWith(`${DBT_DIR}/semantics/`)))

  // ── 规则 ②③：全 dbt SQL 的禁忌构造（注释位不算，见头注判断①） ───────────────────
  for (const rel of sqlFiles) {
    const masked = maskSqlComments(readFileSync(join(rootDir, rel), 'utf8'))
    const doubleLine = firstMatchLine(masked, DOUBLE_CAST_RE)
    if (doubleLine > 0) {
      push(
        rel,
        doubleLine,
        '用了 `::double` / `CAST(... AS double)` —— pg_duckdb 里 DOUBLE 不是可用的 cast 目标（报 `type "double" is only a shell`，坑 #4）：金额用 `numeric`、浮点用 `float`/`real`。两种写法**同一条路**（都是拿裸 `double` 去查类型名），故一起拦；放行 `double precision`（PG 原生类型，与本条要拦的不是同一个东西）',
      )
    }
    const unionLine = firstMatchLine(masked, UNION_BY_NAME_RE)
    if (unionLine > 0) {
      push(
        rel,
        unionLine,
        '用了 `union_by_name` —— 列集漂移（同域不同日 46 vs 43 列，坑 #2）必须**显式处理**（按列集分组读 + 显式补缺失列为 NULL），不许让引擎替我们猜列集。理由与处置策略见 dbt/README.md「漂移策略」',
      )
    }
  }

  // ── 规则 ①：staging 的取列模式 ─────────────────────────────────────────────────
  const stagingFiles = sqlFiles.filter((f) => STAGING_RE.test(f))
  for (const rel of stagingFiles) {
    const masked = maskSqlComments(readFileSync(join(rootDir, rel), 'utf8'))
    if (!R_COLUMN_RE.test(masked)) {
      push(
        rel,
        0,
        "staging 模型里没有 `r['列名']` 取列模式 —— 读 parquet 的列必须在**别名 r 上点名取**（`with r as (select * from read_parquet(...))` 后 `r['列名']::type`）。`SELECT *` 能过、点名取列报 `column does not exist`，而 **`SELECT *` 的成功会掩盖它**（坑 #5）：新写 staging 的人必然踩这一步",
      )
    }
  }

  // ── 规则 ④：staging 一对一（双向）──────────────────────────────────────────────
  /** @type {Map<string, { source: string, table: string, file: string }>} */
  const declaredPairs = new Map()
  for (const rel of ymlFiles.filter((f) => f.startsWith(`${DBT_DIR}/models/`))) {
    let doc
    try {
      doc = readYaml(join(rootDir, rel))
    } catch (e) {
      push(rel, 0, `YAML 解析失败：${/** @type {Error} */ (e).message}`)
      continue
    }
    if (!Array.isArray(doc.sources)) continue
    for (const src of doc.sources) {
      const sourceName = asText(src?.name)
      if (!sourceName || !Array.isArray(src?.tables)) continue
      for (const tbl of src.tables) {
        const tableName = asText(tbl?.name)
        if (!tableName) continue
        const composite = `${sourceName}_${tableName}`
        if (declaredPairs.has(composite)) {
          push(
            rel,
            0,
            `source \`${sourceName}\` 的表 \`${tableName}\` 与另一处声明的 \`${declaredPairs.get(composite)?.source}.${declaredPairs.get(composite)?.table}\` **合成同一个 staging 模型名** \`stg_${composite}\` ⇒ 两个源共用一份 staging，一对一被破坏（合成名由 \`<source>_<table>\` 拼出，改名或拆目录才能消歧）`,
          )
          continue
        }
        declaredPairs.set(composite, { source: sourceName, table: tableName, file: rel })
      }
    }
  }
  const stagingModels = stagingFiles.map((f) => basename(f, '.sql'))
  for (const [composite, pair] of declaredPairs) {
    const expected = `${DBT_DIR}/models/common/staging/stg_${composite}.sql`
    const hits = stagingFiles.filter((f) => basename(f, '.sql') === `stg_${composite}`)
    if (hits.length === 0) {
      push(
        expected,
        0,
        `source \`${pair.source}.${pair.table}\`（声明于 ${pair.file}）没有对应的 staging 模型 —— ③ staging 是**唯一碰原始类型的地方**，不许跳过（layered §3/§5.1）：请加 \`${expected}\`（命名由 ④ 钉死，改名要连声明一起改）`,
      )
    } else if (hits.length > 1) {
      push(hits[1] ?? expected, 0, `stg_${composite} 在多个目录里各有一份（${hits.join(' / ')}）—— 一对一要求每个源恰好一个 staging 模型`)
    }
  }
  for (const rel of stagingFiles) {
    const model = basename(rel, '.sql')
    const composite = model.replace(/^stg_/, '')
    if (!declaredPairs.has(composite)) {
      push(
        rel,
        0,
        `staging 模型 \`${model}\` 在 sources.yml 里找不到对应的源 —— 要么补 \`${DBT_DIR}/models/common/staging/sources.yml\` 的声明，要么这个模型读的不是 declared 源（一对一要求双向都对上）`,
      )
    }
  }

  // ── 规则 ⑤⑥⑦：语义声明 ───────────────────────────────────────────────────────
  /** @type {Array<{ name: string, fields: any, file: string }>} */
  const metrics = []
  for (const rel of ymlFiles) {
    let doc
    try {
      doc = readYaml(join(rootDir, rel))
    } catch (e) {
      push(rel, 0, `YAML 解析失败：${/** @type {Error} */ (e).message}`)
      continue
    }
    if (!Array.isArray(doc.metrics)) continue
    for (const m of doc.metrics) metrics.push({ name: asText(m?.name), fields: m, file: rel })
  }

  /** @type {Map<string, string[]>} */
  const auditFileNameToMetrics = new Map()
  /** @type {Map<string, string>} */
  const nameToFile = new Map()
  for (const metric of metrics) {
    // ⑥-a 命名空间前缀（名字不合法 ⇒ 以名派生文件名的 ⑦ 对它不适用，只报这一条，免得报出一串噪声）
    if (!METRIC_NAME_RE.test(metric.name)) {
      push(
        metric.file,
        0,
        `指标名 \`${metric.name || '(空)'}\` 不合规 —— 必须是 \`<域>:<指标名>\` 命名空间形态（两段都小写蛇形，如 \`retail:net_sales\`）。命名空间是「同名唯一」能成立的前提（layered §6）`,
      )
      continue
    }
    // ⑥-b 同名唯一（**跨文件**：同名两处 = 口径分叉，正是本门禁要拦的）
    const seen = nameToFile.get(metric.name)
    if (seen) {
      push(
        metric.file,
        0,
        `指标 \`${metric.name}\` **同名两处**（另一处在 ${seen}）—— 同名唯一是 spec §10 机制④ 的硬要求：口径只能有单一定义，两处各写一份 SQL 就是口径分叉`,
      )
      continue
    }
    nameToFile.set(metric.name, metric.file)

    // ⑤ 必填字段齐全
    const missing = REQUIRED_METRIC_FIELDS.filter((f) => {
      const v = metric.fields?.[f]
      if (Array.isArray(v)) return v.length === 0
      return asText(v) === ''
    })
    if (missing.length > 0) {
      push(
        metric.file,
        0,
        `指标 \`${metric.name}\` 的语义声明缺必填字段：${missing.join(' / ')} —— owner/tier/grain/definition 是治理门禁的必填面（spec §10 机制① 的 dbt 原生对应物），expression 是口径本体；缺了它，指标就无法登记、无法溯源、无法按 tier 收敛`,
      )
    }

    // ⑦ 对账 test 存在性（文件名由导出的唯一映射函数算出）
    const auditFile = `${DBT_DIR}/tests/${metricToAuditFileName(metric.name)}`
    const owners = auditFileNameToMetrics.get(auditFile) ?? []
    owners.push(metric.name)
    auditFileNameToMetrics.set(auditFile, owners)
    if (!existsSync(join(rootDir, auditFile))) {
      push(
        auditFile,
        0,
        `指标 \`${metric.name}\` 声明了却没有对账查询 \`${auditFile}\` —— 每个声明指标必须有一条**独立复算**的 singular test（layered §7 硬约束 7：cast 错了静默，只有它能抓）。文件名映射只有一处事实源 = check-data-models.mjs 导出的 metricToAuditFileName()`,
      )
    }
  }
  // ⑦-b 映射无碰撞：两个不同名字映到同一文件 ⇒ 其中至少一个没有自己的对账（存在性检查对它俩都通过，
  //      单靠上面那条抓不到 —— 故必须显式判）
  for (const [auditFile, names] of auditFileNameToMetrics) {
    if (names.length > 1) {
      push(
        auditFile,
        0,
        `${names.join(' 与 ')} 映射到**同一个**对账文件名（${auditFile}）—— \`:\` → \`__\` 的映射在这些名字上碰撞，其中至少一个指标没有自己的独立复算。改指标名（避免 \`__\` 与 \`:\` 混淆），不要改映射函数`,
      )
    }
  }

  return violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/**
 * 检查面计数（打印在 OK 行里 **防空转**：本仓没有 dbt/ 与「真检查过」不该同色）。
 * @param {string} rootDir
 * @returns {{ staging: number, sources: number, metrics: number, audits: number }}
 */
function countSurfaces(rootDir) {
  const files = listFiles(rootDir, DBT_DIR)
  /** @type {{ staging: number, sources: number, metrics: number, audits: number }} */
  const counts = { staging: 0, sources: 0, metrics: 0, audits: 0 }
  for (const rel of files) {
    if (STAGING_RE.test(rel)) counts.staging++
    if (rel.startsWith(`${DBT_DIR}/tests/`) && /\/audit_[^/]*\.sql$/.test(rel)) counts.audits++
    if (!/\.ya?ml$/.test(rel)) continue
    let doc
    try {
      doc = readYaml(join(rootDir, rel))
    } catch {
      continue // 解析失败已由 checkDataModels 报违规，这里不再重复
    }
    if (Array.isArray(doc.metrics)) counts.metrics += doc.metrics.length
    if (rel.startsWith(`${DBT_DIR}/models/`) && Array.isArray(doc.sources)) {
      for (const s of doc.sources) if (Array.isArray(s?.tables)) counts.sources += s.tables.length
    }
  }
  return counts
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = checkDataModels(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) {
      console.error(`  ${v.line > 0 ? `${v.file}:${v.line}` : v.file}: [${LABEL}] ${v.message}`)
    }
    process.exit(1)
  }
  const c = countSurfaces(rootDir)
  console.log(`${SCRIPT_NAME}: OK（staging 模型 ${c.staging} / sources 表 ${c.sources} / 声明指标 ${c.metrics} / 对账测试 ${c.audits}）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
