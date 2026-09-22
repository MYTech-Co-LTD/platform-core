#!/usr/bin/env node
// check-data-models.mjs — dbt 工件静态门禁（issue #150 / 计划 Task 4；正典 docs/architecture.md §5.1）。
//
// 用法：tsx scripts/check-data-models.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-data-models: OK（<检查面计数>）`；
//       有违规 → exit 1，stderr 每条一行 `相对路径:行号: [data-models] 说明`（无行号则为 `相对路径: …`）。
//
// ── 本门禁的**范围**（多一句都不做，别在这里扩面） ───────────────────────────────
// 只做 **静态** 门禁，九项：七项 dbt 工件（计划 L649–650 逐条）+ T9 追加的两项：
//   ① staging 模型必含 `r['列名']` 取列模式（坑 #5 的结构性防御）
//   ② 禁 `::double` 与 `CAST(... AS double)`（同一坑 #4：裸 `double` 去查类型名 ⇒ shell 类型，
//      报 `type "double" is only a shell`；两种写法同一条路，故同拦）
//   ③ 禁 `union_by_name`（漂移必须显式处理，不许引擎替我们猜列集）
//   ④ staging 一对一（staging 模型 ↔ sources.yml 的源，**双向**）
//   ⑤ 语义声明必填字段齐全（owner / tier / grain / definition + name / expression）
//   ⑥ 指标名 `<域>:<指标名>` 命名空间前缀 + 同名唯一（跨文件）
//   ⑦ 每个声明指标有对应 `dbt/tests/audit_<指标>.sql` + 该文件名映射无碰撞
//   ⑧ **L2 声明静态面**（T9 / 拍板 #5 的「门禁③机检范围覆盖用户产生的声明」）：
//      `modules/data/domain/semantic-compiler.ts` 里**写时校验**（zod schema）与**唯一编译点**
//      必须同源 —— 词表（op.kind / 过滤算子）两侧逐字一致、字段面两侧集合相等。
//      ⚠️ **强度如实披露**：这是**标记级文本比对，不是行为断言**（假绿面与兜底防线见下面
//      「⑧ 的**强度**」一节）——别把它读成「同源即行为等价」。
//   ⑨ **`sync-data-semantics.mjs --check` 契约**（T9 / 对账机制④ 的 L1 侧）：把 dry-run 的
//      四条性质（--check 存在 / 用法错响亮 / 漂移非 0 / 无漂移 0）与出口码三分法接进机检面。
//
// ── ⑧⑨ 为什么值得占用「静态」门禁的位置（两条边界，别当扩面看） ─────────────────────
// ⑧ **只读** `modules/**`（`existsSync` + `readFileSync`，一个字都不写）：拍板 #5 明确要求门禁
//   覆盖「用户/agent 产生的声明」，而 L2 声明的入参正是**租户提供的数据** ⇒ 它的唯一防线是
//   「schema 与编译器说同一套话」。这条断言**只能**在模块源码上做（要真库就不是静态门禁了）。
//   ⚠️ 本门禁对 `modules/**` 是**只读消费者**，不构成第二处事实源：词表的事实源仍在模块里。
//
//   **⑧ 的强度（如实披露，别高估 —— T9 评审 I-1）**：⑧ 是**标记级 / 结构级**的相等断言，
//   **不是行为断言**。它读的是源码文本里的**字面量集合、键名集合与正则存在性**（见
//   `checkL2DeclarationSameSource` 的三条子判定），断言的是「两处**说的词表与字段名**一致」，
//   **不**断言「编译器真的执行了那套话」。⇒ 它有一个**已实测的假绿面**：
//   **构造「编译器行为变了、而比对标记没变」的改动 ⇒ 本门禁仍绿（exit 0）**。实测两例：
//     · 守卫体掏空（`if (decl.op?.kind !== 'refine') { /* 空 */ }`）⇒ 编译器实际**接受任意**
//       `op.kind`，而标记 `!== 'refine'` 原样还在 ⇒ 读成「两处一致」；
//     · `const filters = decl.filters ?? []` 改成 `const filters = []` ⇒ 租户的 `filters` 被
//       **静默丢弃**（编译出的 `select_sql` 不再带切片 = 静默错数），而 schema / 接口 / 死代码里的
//       算子标记都还在 ⇒ 同样读成「两处一致」。
//   这个缺口**当前由** `modules/data/domain/semantic-compiler.test.ts`（CI 的 `unit` job）兜住
//   （上面两例在该测试里分别红 1 条 / 4 条）⇒ 不是「无防守」，而是**这道门禁在这一层是盲的**。
//   计划 L896 原本要的是**行为** fixtures（原话「schema 拒的编译器也拒」；纯函数对纯函数、
//   不需要真库），且仓内已有 import 模块源码的先例（`scripts/sync-data-semantics.test.ts`）
//   ⇒ 补它是**后续加固**，本轮**只披露、不改比对机制**（改机制会动 `modules/**`，须另开笔）。
// ⑨ **不连库**。它断言的是「openship 定时 job 依赖的那份契约还在」——真跑 `--check` 要部署库，
//   那是 job 的事（runbook 见 dbt/README「治理四机制」节）。这里只 import 它的**纯函数出口**
//   （`parseArgs` / `usageError` / `exitCodeFor` / 出口码常量），**不执行 main**（该脚本的
//   main 有 `process.argv[1]` 守卫）。为什么进口依赖链是安全的：它 import 的 `metric-store.ts`
//   **只有 type import**（`import type { Pool } from 'pg'` 等，运行期被擦除）⇒ 不拖 pg、不读 env。
//   ⚠️ 这条 import 是**有意的**：T8 第一版的真实缺陷正是「未知 flag 被静默忽略 ⇒ 打了 `--check`
//   实际写库」（评审在真库复现）。把契约进口来断言，才能让**那次回归在原地变红**。
//
// **不含**（docs/architecture.md 明写，属架构先行越权，别顺手加）：
//   · `duckle/`（T5）与 `contracts/` 不在任何扫描面内 —— 它们的 env 键等约束当前没有静态门禁；
//   · env 键齐全（B9 = scripts/check-env-example.mjs，扫描根只有 apps/ packages/ modules/，**不扫 dbt/**）
//     ⇒ `.env.example` 里那段 dbt 键是**键面事实源的文档化，不是被本门禁守住的约定**；
//   · 跨系统血缘、指标与物化结果的真值对账（那要真库：spec §10 机制④ 的对账是 singular test 的事，
//     本门禁只查「那条 test **在不在**」，不查它跑不跑得绿）；
//   · **真跑 `sync-data-semantics.mjs --check`**（规则 ⑨ 只断言它的**契约**，不连库）：对已部署库
//     的漂移检出是 openship 定时 job 的活（runbook 见 dbt/README「治理四机制」节）；
//   · `dbt docs generate` 的产物与血缘（要 dbt 环境，本机没有 —— 归 T6 的 job）。
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
//    ⇒ ⑧⑨ 的**纯核**（`checkL2DeclarationSameSource` / `checkSyncCheckContract`）也守这条：返回
//    `{ line, message }`（`line: 0` = 无行号），file 由调用方补。
// ④ **⑧ 只在「切出来的块」上判，不在整份文件上判**：`z.object({…})` 与 `interface X {…}` 的
//    **顶层键**只在 depth 1 上取。为什么不整份扫：`compileL2` 的**返回类型注解**里就有一对
//    `{ selectSql: … }`，它在 depth 上是一对配平的括号 —— 整份文件做行首 depth 追踪会把它算成
//    「depth 1 的键」，把 `selectSql` 当成声明的字段（假阳性）。故先按**括号配平**切块
//    （`sliceBalancedBlock`，注释已掩），再在块内追踪行首 depth。
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
// 规则 ⑨：把 sync 脚本的**纯函数出口**进口来断言 dry-run 契约（理由与依赖链分析见头注
// 「⑧⑨ 为什么值得占用静态门禁的位置」）。值 import（不是 type）——契约面全是运行期
// 函数与常量，断言要真调它们；该脚本的 main 有 `process.argv[1]` 守卫，import 不会执行它。
import * as syncContract from './sync-data-semantics.mjs'

export const SCRIPT_NAME = 'check-data-models'
/** 违规行前缀标签（与 lint-architecture 的 [B1]/[B7]、check-compose 的 [B7] 同形，便于 grep） */
const LABEL = 'data-models'

/**
 * 违规条目（单形状、字段恒在；见头注实现判断③）。
 * @typedef {{ file: string, line: number, message: string }} Violation
 */

/**
 * **纯核**返回的违规条目（`file` 由调用方补；`line: 0` = 无行号）。
 * 同样单形状、字段恒在 —— `scripts/` 是 checkJs，JSDoc 字面量联合会被加宽（同判断③）。
 * @typedef {{ line: number, message: string }} L2Violation
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

// ════════════════════════════════════════════════════════════════════════════════════════
// 规则 ⑧：L2 声明静态面（zod schema ↔ 唯一编译点**同源**）
//
// 拍板 #5 把门禁③的机检范围压到「**覆盖用户/agent 产生的声明**」——L2 声明的入参正是租户
// 提供的数据，它的唯一防线是「写时校验与编译点说同一套话」。两处一旦漂开，失败形态是
// **假绿**：schema 放行的声明落库，直到某个租户查它时才以 500 / SQL 错的面目暴露。
//
// ⚠️ **强度如实披露（T9 评审 I-1）：本规则是「标记级文本比对」，不是行为断言。**
//    下面的三条子判定读的全是**源码文本**（字面量集合 / 键名集合 / 正则存在性）⇒ 它守的是
//    「两处**说的词**一致」，**不守**「编译器真的**照做**」。构造「编译器行为变了而标记没变」
//    的改动时它会**假绿**（实测两例与兜底防线详见头注「⑧ 的**强度**」一节）。
//    **不许**把这条注释或它的对外表述写成「同源 ⇒ 行为等价」——那是本轮评审点名要披露的偏差。
// ════════════════════════════════════════════════════════════════════════════════════════

/** 规则 ⑧ 的扫描面（相对 rootDir）：L2 的**唯一编译点**（T8 产物，本门禁对它**只读**）。 */
export const L2_DECLARATION_REL = 'modules/data/domain/semantic-compiler.ts'

/** 规则 ⑨ 的扫描面（相对 rootDir，只用于违规行的 file 字段）：sync 脚本本体。 */
export const SYNC_SCRIPT_REL = 'scripts/sync-data-semantics.mjs'

/** L2 写时校验的 zod schema 的块开头（**不要求 export** —— 缺 export 由 ⑧-a 单独判，见下）。 */
const L2_SCHEMA_MARKER_RE = /const\s+L2DeclarationSchema\s*=\s*z\.object\(/
/** L2 声明接口的块开头。 */
const L2_IFACE_MARKER_RE = /export\s+interface\s+L2Declaration\s*\{/
/** 编译器比较 `op.kind` 的**接受集**推导：`decl.op?.kind !== '<字面量>'` ⇒ 接受集就是它。 */
const L2_KIND_COMPILER_RE = /\.kind\s*!==\s*'([^']+)'/g
/** 编译器比较过滤算子的接受集推导：`f.op !== '<字面量>'`。 */
const L2_FILTER_OP_COMPILER_RE = /\bf\.op\s*!==\s*'([^']+)'/g
/** schema 侧 `kind: z.literal('<字面量>')`。 */
const L2_KIND_SCHEMA_RE = /kind\s*:\s*z\.literal\(\s*'([^']+)'\s*\)/g
/** schema 侧 `op: z.enum([ … ])`（**只在 filters 那个键之后**取第一个，见 checkL2DeclarationSameSource）。 */
const L2_FILTER_OP_SCHEMA_RE = /op\s*:\s*z\.enum\(\s*\[([^\]]*)\]\s*\)/g

/**
 * 掩掉 TS/JS 注释（`//` 行注释与 `/* *​/` 块注释），**保持长度与行号一一对应**。
 *
 * 与 `maskSqlComments` 同旨、不同语言（那份认 SQL 的 `--`，这份认 TS 的 `//`）。**不掩字符串**：
 * 规则 ⑧ 要的恰恰是 `z.literal('refine')` 里的引号与内容（同头注判断①的取舍）。
 * 已知边界：本掩码不认字符串里的 `//`（如 `'https://…'`）—— 本仓该文件不含此类字面量；
 * 与 maskSqlComments 同一族边界，真撞上时改这里、别改调用方。
 *
 * @param {string} src @returns {string}
 */
export function maskJsComments(src) {
  let out = ''
  let state = 'code' // code | line | block
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') {
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
 * 从 marker 处切出**花括号配平**的块文本（含 marker 所在行）。
 *
 * 为什么必须切块（不能拿尾串）：`compileL2` 的返回类型注解里有一对 `{ … }`，整份文件做行首
 * depth 追踪会把它算成「depth 1 的键」⇒ `selectSql` 被当成声明字段（假阳性）。见头注判断④。
 *
 * @param {string} masked 已掩注释的文本 @param {RegExp} marker
 * @returns {string} 块文本；marker 未命中 / 找不到开括号 / 括号不配平 ⇒ 空串（调用方据此报缺失）
 */
function sliceBalancedBlock(masked, marker) {
  const m = marker.exec(masked)
  if (m === null) return ''
  const open = masked.indexOf('{', m.index)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return masked.slice(m.index, i + 1)
    }
  }
  return ''
}

/**
 * 取块文本里 **depth === 1** 的键名（`interface {…}` 与 `z.object({…})` 两种形态共用）。
 *
 * 行首 depth 判定即可覆盖本仓两种声明形态；块内多行嵌套（schema 的 `filters` 条目）因此被跳过。
 *
 * @param {string} block @returns {string[]}
 */
export function topLevelKeys(block) {
  /** @type {string[]} */
  const keys = []
  let depth = 0
  for (const line of block.split('\n')) {
    if (depth === 1) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/.exec(line)
      if (m !== null) keys.push(m[1])
    }
    for (const c of line) {
      if (c === '{') depth++
      else if (c === '}') depth--
    }
  }
  return keys
}

/**
 * 取文本里某正则**捕获组 1** 的取值集合（去重 + 排序 ⇒ 两侧可直接逐字比对）。
 * @param {string} src @param {RegExp} re @returns {string[]}
 */
function literalValueSet(src, re) {
  /** @type {Set<string>} */
  const out = new Set()
  for (const m of src.matchAll(re)) if (m[1] !== undefined) out.add(m[1])
  return [...out].sort()
}

/** 取某下标处的 1 起行号（用于把违规指到块首）。 @param {string} masked @param {number} idx @returns {number} */
function lineAt(masked, idx) {
  let line = 1
  for (let i = 0; i < idx && i < masked.length; i++) if (masked[i] === '\n') line++
  return line
}

/** 两个集合是否逐字相等（排序后比对，错误信息里给出两侧实际取值）。 */
const sameSet = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * 规则 ⑧ 的**纯核**：给定 `semantic-compiler.ts` 的源码文本，返回违规（不碰文件系统 ⇒
 * fixtures 可直接喂合成源做反面对照）。file 由调用方补。
 *
 * 三条子判定（都指向「两处漂移」的一种具体形态）：
 *  - ⑧-a **单点**：`L2DeclarationSchema` 与 `compileL2` 必须同在**这一份文件**里且都 export。
 *    写时校验一旦搬到别处，就出现了第二个「L2 声明是什么」的事实源。
 *  - ⑧-b **词表同源**：`op.kind` 与过滤算子的**接受集**两侧必须逐字相等 —— schema 放行而
 *    编译器拒绝（或反之）就是最有代表性的漂移：声明在 API 上「写成功了」，查询时才炸。
 *  - ⑧-c **字段面同源**：schema 顶层键集合与接口字段集合必须相等 —— schema 多收一个字段
 *    = 编译器永不读它（静默丢弃）；接口多一个字段 = 这个声明永远写不进来。
 *
 * ⚠️ **它是「标记级」的**：三条子判定读的都是**文本**（`literalValueSet` 的字面量、
 * `topLevelKeys` 的键名、正则的命中与否）⇒ 它能抓「两处**写的词**不一致」，
 * **抓不到**「词的约束没了 / 词还在但没被用」（守卫体掏空、`filters` 被静默丢弃）。
 * 假绿面与兜底防线见头注「⑧ 的**强度**」。**不要**据此把它当行为等价断言用。
 *
 * @param {string} src @returns {L2Violation[]}
 */
export function checkL2DeclarationSameSource(src) {
  /** @type {L2Violation[]} */
  const violations = []
  const push = (/** @type {number} */ line, /** @type {string} */ message) => violations.push({ line, message })

  const masked = maskJsComments(src)
  const schemaBlock = sliceBalancedBlock(masked, L2_SCHEMA_MARKER_RE)
  const ifaceBlock = sliceBalancedBlock(masked, L2_IFACE_MARKER_RE)
  const schemaFound = /\bL2DeclarationSchema\b/.test(masked)

  // ── ⑧-a 单点 ────────────────────────────────────────────────────────────────
  if (!schemaFound) {
    push(0, 'L2 的**写时校验**（`L2DeclarationSchema`）在这份文件里找不到 —— 它是唯一编译点的组成'
      + '部分，必须与 `compileL2` 同址（搬家 = 第二处「L2 声明是什么」的事实源 ⇒ 两处漂移面）')
  } else if (schemaBlock === '' || !/export\s+const\s+L2DeclarationSchema\b/.test(masked)) {
    push(0, '`L2DeclarationSchema` 没有从 `modules/data/domain/semantic-compiler.ts` **导出**'
      + '（或它的 `z.object({` 块不配平）—— 写时校验必须与编译点同址同源、可被门禁与 fixtures 取到')
  }
  if (!/export\s+function\s+compileL2\b/.test(masked)) {
    push(0, '`compileL2` 没有从 `modules/data/domain/semantic-compiler.ts` 导出 —— 它是**唯一编译点**'
      + '（L2 的入参是租户数据，任何第二处拼 SQL 都是注入面且审计只能靠人记全位置）')
  }
  // 块切不出来 ⇒ 词表/字段面无可判，只留上面 ⑧-a 的违规（避免噪声）
  if (schemaBlock === '' || ifaceBlock === '') return violations

  const schemaLine = lineAt(masked, L2_SCHEMA_MARKER_RE.exec(masked)?.index ?? 0)
  const ifaceLine = lineAt(masked, L2_IFACE_MARKER_RE.exec(masked)?.index ?? 0)

  // ── ⑧-b 词表同源（op.kind）─────────────────────────────────────────────────
  const kindSchema = literalValueSet(schemaBlock, L2_KIND_SCHEMA_RE)
  const kindCompiler = literalValueSet(masked, L2_KIND_COMPILER_RE)
  if (!sameSet(kindSchema, kindCompiler)) {
    push(schemaLine, `op.kind 的接受集**两侧不一致** —— schema ${JSON.stringify(kindSchema)}`
      + ` vs 编译器 ${JSON.stringify(kindCompiler)}：schema 放行的声明会在编译时被拒（或反之），`
      + '而失败面要到「某个租户查这个指标」时才暴露（拍板 #5：门禁③要覆盖用户产生的声明）')
  }

  // ── ⑧-b 词表同源（过滤算子）────────────────────────────────────────────────
  // ★ 只在 `filters` 那个键**之后**取第一个 `z.enum([…])`：schema 块里 `op: z.object({…})`
  //   也是 `op:`，从头扫会抓错条目。
  const filtersAt = schemaBlock.indexOf('filters')
  L2_FILTER_OP_SCHEMA_RE.lastIndex = filtersAt < 0 ? 0 : filtersAt
  const opEnumMatch = L2_FILTER_OP_SCHEMA_RE.exec(schemaBlock)
  const opSchema = opEnumMatch === null
    ? []
    : literalValueSet(opEnumMatch[1] ?? '', /'([^']*)'/g)
  const opCompiler = literalValueSet(masked, L2_FILTER_OP_COMPILER_RE)
  if (opSchema.length === 0) {
    push(schemaLine, '过滤算子在 schema 里取不到（`filters[].op` 应为 `z.enum([…])`）—— 取不到就无法'
      + '断言与编译器同源，而它正是「L2 能产生什么 SQL」的词表之一')
  } else if (!sameSet(opSchema, opCompiler)) {
    push(schemaLine, `过滤算子的接受集**两侧不一致** —— schema ${JSON.stringify(opSchema)}`
      + ` vs 编译器 ${JSON.stringify(opCompiler)}：多收/少收的算子会让声明「写得进、跑不动」`)
  }

  // ── ⑧-c 字段面同源 ─────────────────────────────────────────────────────────
  const schemaKeys = topLevelKeys(schemaBlock).sort()
  const ifaceKeys = topLevelKeys(ifaceBlock).sort()
  if (!sameSet(schemaKeys, ifaceKeys)) {
    const onlySchema = schemaKeys.filter((k) => !ifaceKeys.includes(k))
    const onlyIface = ifaceKeys.filter((k) => !schemaKeys.includes(k))
    push(ifaceLine, 'L2 声明的**字段面两侧不一致** —— '
      + (onlySchema.length > 0 ? `schema 多收 ${JSON.stringify(onlySchema)}（编译器永不读 ⇒ 静默丢弃）；` : '')
      + (onlyIface.length > 0 ? `接口多出 ${JSON.stringify(onlyIface)}（该字段永远写不进来）；` : '')
      + `schema ${JSON.stringify(schemaKeys)} vs 接口 ${JSON.stringify(ifaceKeys)}`)
  }

  return violations
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 规则 ⑨：`sync-data-semantics.mjs --check` 契约（对账机制④ 的 L1 侧）
//
// **不连库**：真跑 `--check` 要部署库（openship 定时 job 的活）。这里断言的是「那份契约还在」
// —— 因为 T9 把门禁③接到了它上面，契约一旦退化，门禁就会**读错**（把用法错读成漂移、或反过来）。
// T8 第一版的真实缺陷就是这条契约缺了「未知 flag 响亮」：打了 `--check` 实际写库、还 exit 0。
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * 规则 ⑨ 的**纯核**：给定 sync 契约面（真模块命名空间，或 fixtures 造的合成契约），返回违规。
 * 逐条真调函数、不读源码文本 —— 「契约」只能用**行为**断言，文本匹配拦不住语义退化。
 *
 * @param {any} c 契约面（`parseArgs` / `usageError` / `exitCodeFor` / 出口码与模式常量 / `FLAG_HELP`）
 * @returns {L2Violation[]}
 */
export function checkSyncCheckContract(c) {
  /** @type {L2Violation[]} */
  const violations = []
  const push = (/** @type {string} */ message) => violations.push({ line: 0, message })
  /** 把「探测函数自己抛了」也当成契约不成立（fail-closed；不让异常逃出把门禁变成 crash）。 */
  const probe = (/** @type {() => boolean} */ fn) => {
    try {
      return fn()
    } catch {
      return false
    }
  }

  // ⑨-a `--check` 存在且映射到 check 模式（门禁消费的就是它）
  if (!probe(() => c.parseArgs(['--check']).mode === c.MODE_CHECK)) {
    push('`sync-data-semantics.mjs` 的 `--check` 不再映射到 check 模式 —— 门禁③的 L1 侧就是靠它'
      + '读「库内 L1 行与仓内声明是否一致」；模式丢了，门禁读到的就不是 dry-run')
  }

  // ⑨-b 用法错必须**响亮**（未知 flag + 模式互斥）—— T8 的回归点
  if (!probe(() => c.usageError(c.parseArgs(['--chekc'])) !== null)) {
    push('未知 flag 被**静默忽略**（`--chekc` 不报错）—— 这正是把 `--check` 打成手误时**真写库**'
      + '的形态（T8 第一版的缺陷，评审在真库复现）：必须 exit 2 并列出支持项')
  }
  if (!probe(() => c.usageError(c.parseArgs(['--check', '--dry-run'])) !== null)) {
    push('模式互斥**不响亮**（`--check --dry-run` 不报错）—— 静默取第一个会让语义取决于参数顺序，'
      + '而门禁要求「打了哪个模式就跑哪个模式」是确定的')
  }

  // ⑨-c 出口码：漂移 ⇒ 非 0；无漂移 ⇒ 0（门禁把非 0 读成「检出漂移」）
  const driftDiff = { added: ['check-data-models-probe'], updated: [], removed: [], unchanged: [] }
  const cleanDiff = { added: [], updated: [], removed: [], unchanged: [] }
  if (!probe(() => c.exitCodeFor(c.MODE_CHECK, driftDiff) !== c.EXIT_OK)) {
    push('`--check` 在**有漂移**时仍返回 0 —— 门禁会把它读成「无漂移」，即一个恒绿的假门禁')
  }
  if (!probe(() => c.exitCodeFor(c.MODE_CHECK, cleanDiff) === c.EXIT_OK)) {
    push('`--check` 在**无漂移**时返回非 0 —— 门禁会恒红（狼来了，随后被人关掉）')
  }

  // ⑨-d 出口码三分法：**用法错不能被读成漂移**
  if (!probe(() => c.EXIT_USAGE !== c.EXIT_DRIFT)) {
    push('出口码的**用法错与漂移重合**（EXIT_USAGE === EXIT_DRIFT）—— 消费方分不清「打错字」与'
      + '「真有漂移」，而两者要的处置完全不同（改命令 vs 处置数据）')
  }

  // ⑨-e `--check` 必须在 FLAG_HELP 里被文档化（runbook / openship job 的文案事实源）
  // 回调形参显式标 `any`：`c` 是 any，`Array.isArray` 窄化后 `.some` 的回调形参在 checkJs 下
  // 收不到类型（TS7006 实测），不标就过不了 typecheck:scripts。
  if (!probe(() => Array.isArray(c.FLAG_HELP)
    && c.FLAG_HELP.some((/** @type {any} */ f) => String(f?.flag).includes('--check')))) {
    push('`FLAG_HELP` 里没有 `--check` —— 那份表是自己文档化「哪个模式不写库」的唯一事实源，'
      + 'runbook 与 job 都按它理解行为')
  }

  return violations
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

  // ── 规则 ⑧：L2 声明静态面（T9）────────────────────────────────────────────────
  // 适用面为空则**跳过**（同 `dbt/` 不存在的处置：本门禁的 fixtures 都是临时 root，没有模块目录）。
  // ⚠️ 这不是漏洞：真仓有该文件 ⇒ CI 上恒定执行；OK 行里另打「L2 声明面」计数防空转。
  const l2Path = join(rootDir, L2_DECLARATION_REL)
  if (existsSync(l2Path)) {
    for (const v of checkL2DeclarationSameSource(readFileSync(l2Path, 'utf8'))) {
      push(L2_DECLARATION_REL, v.line, v.message)
    }
  }

  // ── 规则 ⑨：sync `--check` 契约（T9）──────────────────────────────────────────
  // 与 rootDir 无关（契约面来自真仓的脚本本体）⇒ 每个 fixture 上都会跑到，恒定执行。
  for (const v of checkSyncCheckContract(syncContract)) {
    push(SYNC_SCRIPT_REL, v.line, v.message)
  }

  return violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/**
 * 检查面计数（打印在 OK 行里 **防空转**：本仓没有 dbt/ 与「真检查过」不该同色）。
 *
 * T9 追加两个计数：`l2` = L2 声明面（0/1，该文件在否）与 `syncContract` = ⑨ 的契约面（恒 1）。
 * 为什么 ⑨ 也要计数：它是**与 rootDir 无关**的检查 ⇒ 若不计数，读者无法从 OK 行区分
 * 「⑨ 跑过了」与「⑨ 被谁悄悄摘掉了」。
 *
 * @param {string} rootDir
 * @returns {{ staging: number, sources: number, metrics: number, audits: number, l2: number, syncContract: number }}
 */
function countSurfaces(rootDir) {
  const files = listFiles(rootDir, DBT_DIR)
  /** @type {{ staging: number, sources: number, metrics: number, audits: number, l2: number, syncContract: number }} */
  const counts = {
    staging: 0,
    sources: 0,
    metrics: 0,
    audits: 0,
    l2: existsSync(join(rootDir, L2_DECLARATION_REL)) ? 1 : 0,
    syncContract: 1,
  }
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
  console.log(
    `${SCRIPT_NAME}: OK（staging 模型 ${c.staging} / sources 表 ${c.sources} / 声明指标 ${c.metrics}`
    + ` / 对账测试 ${c.audits} / L2 声明面 ${c.l2} / sync 契约 ${c.syncContract}）`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
