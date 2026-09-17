#!/usr/bin/env node
// check-tenant-isolation.mjs — 租户隔离门禁（issue #77；正典 docs/module-protocol.md「租户数据隔离」）。
//
// 用法：DATABASE_URL=postgres://… pnpm exec tsx scripts/check-tenant-isolation.mjs [rootDir]
//   rootDir 默认 = 仓库根（fixture 测试用形参，与 check-compose / lint-architecture 同形）。
// 契约：干净 → exit 0，stdout 一行 `check-tenant-isolation: OK…`（带检查面计数，防空转）；
//       有违规 → exit 1，stderr 每条一行 `相对路径:行号: [租户隔离] 说明`。
//
// ── 判据：真库对账，不是 DDL 解析 ───────────────────────────────────────────────
// 把每个模块的 migrations 真跑一遍（跑进一个**一次性数据库**，见实现判断①），然后查
// information_schema 要「该模块的每张表都有 org 列」。为什么拿真库当真值（issue #77 决定）：
// 静态解析会被三种写法骗到——幂等写法（`create table if not exists`）、增量迁移、以及把 DDL
// 写到别处；而「表到底有没有 org」在库里只有一个答案，不用写 DDL 解析器。
//
// ★ 判据按「本模块全部 migrations 的**累积终态**」判，**不按文件判**。
//   反例（issue #77 实测）：modules/demo/001_note.sql 建 demo.note 时没有 org，
//   org 是 003_note_org.sql 后补的。朴素实现（正则「每个 create table 必须含 org」）会误报
//   demo——而 demo 正是每个新模块照抄的模板：**最该干净的文件被误报，门禁一上线就会被人关掉**。
//   真库对账天然只看终态，这个坑不存在（`scripts/check-tenant-isolation.test.ts` 有一组
//   专门钉住它的回归用例）。
//
// ★ 判据两条（都出自正典同一句话）：①「org 列存在」+ ②「该 org 列 not null」。
//   正典三条纪律里，①「带 `org text not null` 列」是本门禁的判据面——**措辞里就写着 not null，
//   故两条都查**；②（唯一约束含 org）与 ③（热路径索引以 org 为前缀列）**刻意不查**：正典自己
//   写了②③是**条件适用**的（「没有业务唯一键的表不适用，不强加」）——机器判不出「这张表该不该
//   有业务唯一键」，查它必然误报，故②③仍是评审守（正典里的措辞与此一致）。
//
//   ★ 为什么 not null 也在判据面里（2026-09-17 补 T2；本脚本一度明文写着「不查」）：
//   老实说，`not null` 管的是「行可不可见」，不是「租户会不会互见」——org **缺失**才有互见
//   风险；org 为空的最坏结果是该行对所有租户不可见（而这正是正典为存量回填选定的状态：
//   回填空串，「宁可不可见，不可错归属」）。**但正典要求它**（docs/module-protocol.md:181
//   逐字写着 `org text not null`），而本门禁的职责是**执行正典**，不是照自己的理解给正典打折：
//   门禁注释里引用一句正典、实现里只查半句，两者立刻会漂开——「引着正典、查着别的」正是门禁
//   腐化的起点。可空 org 也不是无害：`where org = $1` 会**静默漏掉**这些行（NULL 不等于任何值），
//   读不到与读错了同样难查。
//   代价侧实测为零（加 T2 时全仓 10 张模块表**全部已是 NOT NULL**：demo 的 003_note_org.sql
//   就是 `add column` 后紧跟回填 + `set not null`）⇒ 这条例只知道「将来有人写漏 not null 时
//   红一次」，正是它要防的。
//
// ── 判据之外的两条静态检查（门禁自身的健全性，fail-closed） ─────────────────────
// 下面两条**不看 org**，它们防的是「门禁空转 / 豁免权漂移」，不是租户互见：
//   ① 本模块迁移里的 `create table` 必须建在**本模块自己的 schema**（= manifest id，
//      「三同纪律」id = DB schema = API 前缀）。建到别处（含不限定 schema ⇒ 落 search_path
//      的 public）门禁就对它结构性地看不见——静默放行比报错危险得多，故判违规。
//   ② 豁免标记（见下）必须紧贴一条本模块的 `create table`，且理由非空。挂空标记 = 事后无从
//      核对「它到底豁免了谁」；空理由则是把豁免变成默认勾选。
//
// ── 边界（都写在这里，别当成漏检） ─────────────────────────────────────────────
// · 只扫**模块自己的 schema**（`modules/<dir>/` 的 manifest id）。`platform.*` 是宿主的地盘，
//   其中的表（tenant / schema_migrations…）**合法地**没有 org，不是本门禁的适用面。
// · 无 `migrations/`（或目录里没有 .sql）的模块**静默跳过**。理由与装载器/迁移执行器同一约定
//   （apps/server/src/migrate.ts 头注：「目录不存在静默跳过（装载器对无 migrations/ 的模块零
//   负担）」）：没有迁移 = 本模块不建表 = 本门禁的适用面为空；在这里报错等于把「模块可以不带
//   迁移」这条合法形态判成违规。跳过数**打印在 OK 行里**，不静默空转。
// · 取模块迁移目录的规则与装载器逐字一致（loader.ts 的 `manifest.migrations?.dir ?? 'migrations'`）。
// · 文本扫描（掩码后按行）认不出的写法（带引号的标识符 `"s"."t"`、`create temp(unlogged) table`、
//   `create table … as select` 一类）一律**看不见**；唯一的兜底是下面的「空转自检」：
//   本模块有建表迹象（宽松计数）却在库里一张表都没见到 ⇒ 判违规并要求人来扩守卫。
//   方向是安全的：宁可让人来改守卫，也不静默放过一个扫不到的建表语句。
//
// ── 豁免出口：`-- global-table: <理由>`（issue #77 决定，与 DDL 同址） ────────────
// 一行 SQL 注释，紧贴在它所豁免的 `create table` 上方（只允许注释/空行相隔）：
//     -- global-table: 省份字典，全租户共用，无租户归属
//     create table if not exists demo.province (…)
// 四条约束（防「随便声明就能绕过」）：理由**必填**（空理由即违规）；标记必须**紧贴**一条本模块
// schema 的 create table（挂空即违规）；它豁免的是**「租户数据表」整条判据**——org 存在（T1）与
// org not null（T2）**两条一起豁免，保持一致**：标记的语义是「这张表**不是**租户数据表」（全局
// 字典/配置表），既然它不是租户数据表，正典那句 `org text not null` 对它**整体不适用**，没有
// 「T1 算是 T2 不算」的中间态（②③纪律照旧由评审守）；标记长在 DDL 旁 ⇒ 必走 PR、评审一眼可见。
// 为什么不做成 manifest 字段（issue 已定，这里补上为什么）：理由应当长在表的定义旁边，放到另一个
// 文件里会走散；manifest 是**机器契约**（B4/B5 由 check-manifests 校验），把「为什么这张表没有
// org」塞进契约字段等于把契约当评审簿用，且新模块模板会多出一个空字段——空字段很容易变成默认勾选。
// 注：「本模块没有全局表」**不需要**任何标记（售后模块在 README 声明即可）：标记是「真有全局表」
// 时的出口，不是「声明我没有」的入口。
//
// ── 三个实现判断 ──────────────────────────────────────────────────────────────
// ① **一次性数据库**：脚本 `drop database if exists platform_tenant_isolation_check` +
//    `create database …`，在它里面跑迁移，查完 drop。**绝不碰 DATABASE_URL 指的那个库**——
//    在别人的库里跑 DDL，既不干净也不安全（本地脏库里的历史表会让门禁恒红，而那正是「被误报
//    一次就被关掉」的经典死法）。代价是需要 CREATEDB 权限（CI 的 postgres service 里
//    POSTGRES_USER=platform 是超级用户；本地 compose pg 同）：权限不足时**响亮失败**并说明，
//    不静默跳过。已知边界：库名固定 ⇒ 不可并发重入（两人同时跑会互相 drop）；CI 单实例、
//    本地偶发，不值得为它引入随机名 + 孤儿库的清理义务。
// ② **迁移跑生产的执行器**（apps/server/src/migrate.ts 的 runMigrations）：按文件名排序、
//    每文件一个事务、按模块记账。本门禁的全部说服力建立在「跑出来的终态 = 生产跑出来的终态」
//    上，自己再写一遍「怎么跑迁移」就等着与生产漂移（执行器改了排序/粒度，守卫还按老规矩判）。
//    这也是本脚本必须 tsx 跑（裸 node 解析不了 .ts）而其余四个守卫是纯 .mjs 的原因。
// ③ **org 的判据只来自真库**；文本扫描只做两件事——把违规定位到 `文件:行号`（便于修）、以及
//    上面那两条健全性检查与空转自检。判据不读文本 ⇒ 幂等写法与增量迁移骗不到它。
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { runMigrations } from '../apps/server/src/migrate.ts'

export const SCRIPT_NAME = 'check-tenant-isolation'
/** 违规行前缀标签（与 lint-architecture 的 [B1]/[B7] 同形，便于 grep） */
const LABEL = '租户隔离'
/** 一次性数据库名（实现判断①；固定名 ⇒ 不可并发重入，见该判断） */
const SCRATCH_DB = 'platform_tenant_isolation_check'
/** 模块迁移目录的缺省名（与 loader.ts 的 `manifest.migrations?.dir ?? 'migrations'` 一致） */
const DEFAULT_MIGRATIONS_DIR = 'migrations'
/** 豁免标记（必须独占一行——行内追在 DDL 后面的注释不算，免得误伤 `-- 参见 …` 这类散文） */
const MARKER_RE = /^\s*--\s*global-table\s*:\s*(.*)$/
/** 宽松的「建表迹象」计数（含 temp/unlogged 与引号写法）——只用于空转自检，不参与判据 */
const CREATE_TABLE_HINT_RE = /\bcreate\s+(?:unlogged\s+|temp(?:orary)?\s+|global\s+|local\s+)*table\b/gi
/** 裸标识符（schema/表名必须长这样才认） */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/
/**
 * 一行代码的建表解析结果（parseCreateTableLine 的三段式）。
 *
 * 刻意做成**单一形状、字段恒在**（空串代替 null）而不是三段式可辨识联合：JS 里的可辨识联合
 * 要靠 JSDoc 的字面量类型收窄，而 JSDoc 对象类型里的 `'none'` 会被**加宽成 string**
 * （开发期实测：`@returns {{kind:'none'} | {kind:'table',...}}` 收窄失败，报
 * 「Property 'table' does not exist on type '{ kind: string }'」）。字段恒在就不需要收窄。
 * @typedef {{ kind: 'table' | 'unrecognized' | 'none', schema: string, table: string, target: string }} CreateTableLine
 *   kind='table'：`schema` 空串 = 未限定 schema（落 search_path 的 public）；`table` = 表名。
 *   kind='unrecognized'：是建表语句但目标形态认不出，`target` = 目标原文。
 *   kind='none'：这行不是建表语句。
 */

/**
 * @typedef {{ file: string, line: number | null, message: string }} Violation
 *   line 为 null = 整目录/整表级违规（与 check-compose 的整文件级报错同形，不伪造 `:1`）。
 * @typedef {{ rel: string, text: string }} SqlFile
 * @typedef {{
 *   id: string, dirRel: string, migrationsDir: string, migrationsDirRel: string,
 *   files: SqlFile[],
 * }} Module
 * @typedef {{
 *   creates: Map<string, { file: string, line: number }>,
 *   markers: Map<string, { reason: string, file: string, line: number }>,
 *   violations: Violation[],
 *   createHints: number,
 * }} ModuleSql
 */

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join('/')

/** 相对 rootDir 的 posix 路径（报错里的路径一律这个形状） */
/** @param {string} rootDir @param {string} abs */
const relOf = (rootDir, abs) => toPosix(path.relative(rootDir, abs))

/**
 * SQL 注释掩码（等长 ⇒ 行号与列位都不变）。
 *
 * 为什么要两种形态：本脚本对**同一段文本**有两个互相冲突的需求——
 *   · 认 `create table` 需要**代码位**（注释里那句「见 001 的 create table…」不能算数）；
 *   · 认豁免标记需要**行注释位**（标记本身就是一行注释，掩掉就没了）。
 * 故同一台状态机跑两遍：`keepLineComments=false` 给代码用（行注释也掩成空格，于是「注释行」在
 * 代码文本里就是一行空白——下面「跳过注释/空行」的判定因此只需判空白），`true` 给标记用
 * （行注释原文保留，字符串与块注释仍掩掉）。两串等长 ⇒ 行号一一对应。
 *
 * 已知边界：只认单引号字符串（含 `''` 转义）与 `--` / 块注释；带双引号的标识符、`$$…$$`
 * dollar-quoted 串、`E''` 里的反斜杠转义不识别。本仓模块迁移不用这些写法；真要用，这里
 * 与头注「边界」节要一起改。
 *
 * @param {string} src @param {boolean} keepLineComments @returns {string}
 */
export function maskSql(src, keepLineComments) {
  let out = ''
  let state = 'code' // code | line | block | sq
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '-' && n === '-') {
        state = 'line'
        out += keepLineComments ? '--' : '  '
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i++
      } else {
        if (c === "'") state = 'sq'
        out += c
      }
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += keepLineComments ? c : ' '
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code'
        out += '  '
        i++
      } else out += c === '\n' ? '\n' : ' '
      continue
    }
    // 单引号字符串：内容掩成空格（`''` 是转义引号，仍在串内），未闭合则在行尾兜底
    if (c === "'") {
      if (n === "'") {
        out += '  '
        i++
        continue
      }
      state = 'code'
      out += c
      continue
    }
    if (c === '\n') {
      state = 'code'
      out += c
      continue
    }
    out += ' '
  }
  return out
}

/**
 * 从**掩码后**的一行代码里抽建表目标。
 *
 * 为什么不用一条正则搞定：`(?:if\s+not\s+exists\s+)?` 是可选的，遇到它认不出的目标
 * （`create table "public"."dict"` —— 带引号的标识符）正则**回溯**把 `if` 当成首个标识符，
 * 于是「未限定 schema：写成 `if`」这种与事实相反的误报就出来了（开发期实测踩到，故这里改成
 * 逐段取词）。认不出的形态返回 `unrecognized`：**不判违规**，交给真库 + 空转自检兜底
 * （见文件头「边界」：认不出的写法一律看不见，宁可让人来扩守卫）。
 *
 * @param {string} line @returns {CreateTableLine}
 */
export function parseCreateTableLine(line) {
  /** @param {'table' | 'unrecognized' | 'none'} kind @param {string} schema @param {string} table @param {string} target */
  const make = (kind, schema, table, target) => ({ kind, schema, table, target })
  const m = /^\s*create\s+(?:unlogged\s+)?table\s+(.*)$/i.exec(line)
  if (!m) return make('none', '', '', '')
  let rest = m[1]
  const ine = /^if\s+not\s+exists\s+(.*)$/i.exec(rest)
  if (ine) rest = ine[1]
  const target = rest.split(/[(]|\s/)[0] // 目标到 `(` 或空白为止
  if (!target) return make('none', '', '', '')
  const parts = target.split('.')
  if (parts.length === 1 && IDENT_RE.test(parts[0])) return make('table', '', parts[0], target)
  if (parts.length === 2 && IDENT_RE.test(parts[0]) && IDENT_RE.test(parts[1])) {
    return make('table', parts[0], parts[1], target)
  }
  return make('unrecognized', '', '', target)
}

/**
 * 扫一个模块的全部迁移 SQL，产出：本模块 schema 里的建表位置、豁免标记、以及两条静态健全性
 * 违规（见文件头「判据之外的两条静态检查」）。**不看 org**——org 由真库说。
 * @param {Module} mod @returns {ModuleSql}
 */
export function parseModuleSql(mod) {
  /** @type {Map<string, { file: string, line: number }>} */
  const creates = new Map()
  /** @type {Map<string, { reason: string, file: string, line: number }>} */
  const markers = new Map()
  /** @type {Violation[]} */
  const violations = []
  let createHints = 0

  for (const f of mod.files) {
    const code = maskSql(f.text, false)
    const codeLines = code.split('\n')
    const markerLines = maskSql(f.text, true).split('\n') // 与 codeLines 逐行对齐（等长掩码）
    // 空转自检的宽松计数：在**掩码后**的代码上数（注释里那句「见 001 的 create table」不算）
    createHints += (code.match(CREATE_TABLE_HINT_RE) ?? []).length

    // ① 豁免标记：独占一行、理由非空、且紧贴一条本模块 schema 的 create table
    for (let i = 0; i < markerLines.length; i++) {
      const m = MARKER_RE.exec(markerLines[i])
      if (!m) continue
      const reason = m[1].trim()
      if (!reason) {
        violations.push({
          file: f.rel,
          line: i + 1,
          message: `豁免标记没写理由——\`-- global-table: <理由>\` 的理由是这条豁免被评审核对的唯一凭据（空理由 = 豁免变成默认勾选）`,
        })
        continue
      }
      let j = i + 1
      while (j < codeLines.length && codeLines[j].trim() === '') j++ // 注释/空行（掩码后皆空白）不算隔断
      const following = j < codeLines.length ? codeLines[j].trim() : null
      // 标记之后没有语句 ⇒ 喂空串（解析出 kind='none'，落到下面的「挂空」分支）
      const hit = parseCreateTableLine(following === null ? '' : codeLines[j])
      if (hit.kind === 'unrecognized') {
        violations.push({
          file: f.rel,
          line: i + 1,
          message: `豁免标记挂在本门禁认不出的建表写法上（\`${hit.target}\`）——标记只有在能对到本模块 schema "${mod.id}" 的 \`create table\` 时才生效。请写成不带引号的 \`create table ${mod.id}.<表名>\``,
        })
        continue
      }
      if (hit.kind !== 'table' || hit.schema !== mod.id) {
        violations.push({
          file: f.rel,
          line: i + 1,
          message: `豁免标记没挂到本模块的 create table 上${following === null ? '（标记之后没有下一条语句）' : `（其后第一条语句是 \`${following.slice(0, 60)}\`）`}——标记必须紧贴它所豁免的建表语句：挂空的标记会让「它豁免了谁」事后无从核对`,
        })
        continue
      }
      if (!markers.has(hit.table)) markers.set(hit.table, { reason, file: f.rel, line: i + 1 })
    }

    // ② create table 必须建在本模块 schema（建到别处 = 门禁看不见，fail-closed）
    for (let i = 0; i < codeLines.length; i++) {
      const hit = parseCreateTableLine(codeLines[i])
      if (hit.kind !== 'table') continue // 非建表语句 / 认不出的写法：不判违规（见 parseCreateTableLine 与头注「边界」）
      if (hit.schema === '') {
        violations.push({
          file: f.rel,
          line: i + 1,
          message: `create table 未限定 schema（写成 \`${hit.table}\`）——不限定即落 search_path 的 public，本门禁只查模块自己的 schema "${mod.id}"，建到别处等于门禁看不见。请写成 \`create table ${mod.id}.${hit.table}\``,
        })
        continue
      }
      if (hit.schema !== mod.id) {
        violations.push({
          file: f.rel,
          line: i + 1,
          message: `create table 建到了 "${hit.schema}.${hit.table}"——本模块的 schema 是 "${mod.id}"（manifest id，「三同纪律」id = DB schema = API 前缀），门禁只查它；跨 schema 建表要么是写错了 schema，要么是本门禁的视界要跟着扩`,
        })
        continue
      }
      if (!creates.has(hit.table)) creates.set(hit.table, { file: f.rel, line: i + 1 })
    }
  }

  return { creates, markers, violations, createHints }
}

/**
 * 收集 `modules/*` 的模块与其迁移 SQL（目录/清单缺失都不在这里报错——manifest 合法性归
 * check-manifests，迁移目录缺省与装载器同一约定）。
 * @param {string} rootDir @returns {Promise<Module[]>}
 */
export async function collectModules(rootDir) {
  /** @type {Module[]} */
  const out = []
  let entries
  try {
    entries = await readdir(path.join(rootDir, 'modules'), { withFileTypes: true })
  } catch {
    return out // 根下没有 modules/（fixtures 常见）
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const dir = path.join(rootDir, 'modules', entry.name)
    let id = entry.name
    let migrationsDirName = DEFAULT_MIGRATIONS_DIR
    try {
      const doc = parseYaml(await readFile(path.join(dir, 'manifest.yaml'), 'utf8'))
      if (doc && typeof doc.id === 'string' && doc.id) id = doc.id
      const declared = doc?.migrations?.dir
      if (typeof declared === 'string' && declared) migrationsDirName = declared
    } catch {
      // manifest 缺失/不可读 → 目录名兜底（与 lint-architecture 的 moduleIdOf 同款）
    }
    const migrationsDir = path.join(dir, migrationsDirName)
    /** @type {string[]} */
    let names = []
    try {
      names = await readdir(migrationsDir)
    } catch (err) {
      // ENOENT/ENOTDIR = 无迁移目录（合法形态，**跳过但不丢**：模块仍进 all，只是 files 为空，
      // 这样 OK 行里的「跳过 N 个」才数得出来）；其余（权限等）照抛
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    }
    /** @type {SqlFile[]} */
    const files = []
    for (const name of names.filter((n) => n.endsWith('.sql')).sort()) {
      const abs = path.join(migrationsDir, name)
      files.push({ rel: relOf(rootDir, abs), text: await readFile(abs, 'utf8') })
    }
    out.push({
      id,
      dirRel: relOf(rootDir, dir),
      migrationsDir,
      migrationsDirRel: relOf(rootDir, migrationsDir),
      files,
    })
  }
  return out
}

/** 把 DATABASE_URL 指到的库换成同名连接串里的另一个库名 */
/** @param {string} dbUrl @param {string} dbName @returns {string} */
function withDatabaseName(dbUrl, dbName) {
  let u
  try {
    u = new URL(dbUrl)
  } catch {
    throw new Error(`DATABASE_URL 不是合法连接串：${dbUrl}`)
  }
  u.pathname = `/${dbName}`
  return u.toString()
}

/**
 * 在一次性数据库里跑完各模块迁移 → 查 information_schema。
 * **绝不碰 DATABASE_URL 指的那个库**（见实现判断①）；调用方负责 drop（本函数内 try/finally）。
 * @param {string} dbUrl @param {Module[]} modules
 * @returns {Promise<Map<string, { total: number, missingOrg: string[], nullableOrg: string[] }>>} schema → 表统计
 */
export async function inspectSchemas(dbUrl, modules) {
  // scripts/ 不属于任何 workspace 包，裸 import 'pg' 处处解析不到 ⇒ 锚到 apps/server 解析
  // （与 provision-tenant.mjs / migrate-tenant-module-to-subs.mjs 同坑同修，b346e8e）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')

  const admin = new Pool({ connectionString: dbUrl })
  try {
    try {
      await admin.query(`drop database if exists ${SCRATCH_DB}`)
      await admin.query(`create database ${SCRATCH_DB}`)
    } catch (err) {
      throw new Error(
        `无法在 DATABASE_URL 指向的 PG 上创建一次性库 ${SCRATCH_DB}（本门禁只在一次性库里跑 DDL，绝不碰你的库）：${/** @type {Error} */ (err).message}\n`
        + '  · CI / 本地 compose 的 POSTGRES_USER=platform 是超级用户，天然有 CREATEDB；\n'
        + '  · 托管/受管 PG 一般不给 CREATEDB——那就别把它指向这里（本门禁要真库，给一个能建库的测试实例）。',
      )
    }

    const pool = new Pool({ connectionString: withDatabaseName(dbUrl, SCRATCH_DB) })
    try {
      for (const mod of modules) {
        // 与装载器同一个执行器、同一个记账键（模块 id），跑法与生产逐字一致（实现判断②）
        await runMigrations(pool, mod.id, mod.migrationsDir)
      }

      const schemas = modules.map((m) => m.id)
      // 表清单以 information_schema.tables 为准（不是从 columns 分组出来的）：零列的表
      // （`create table fx.t()` 合法）在 columns 里一行都没有，从 columns 出发会连表都见不到
      // ⇒ 静默放行。故「有没有 org」与「org 可不可空」都做成对 tables 的两个 exists 探针，
      // 与既有的 has_org 同形（真值只有一个来源：库）。
      const { rows } = await pool.query(
        `select t.table_schema, t.table_name,
                exists (
                  select 1 from information_schema.columns c
                   where c.table_schema = t.table_schema
                     and c.table_name = t.table_name
                     and c.column_name = 'org'
                ) as has_org,
                exists (
                  select 1 from information_schema.columns c
                   where c.table_schema = t.table_schema
                     and c.table_name = t.table_name
                     and c.column_name = 'org'
                     and c.is_nullable = 'NO'
                ) as org_not_null
           from information_schema.tables t
          where t.table_schema = any($1::text[])
            and t.table_type = 'BASE TABLE'
          order by 1, 2`,
        [schemas],
      )
      /** @type {Map<string, { total: number, missingOrg: string[], nullableOrg: string[] }>} */
      const bySchema = new Map(schemas.map((s) => [s, { total: 0, missingOrg: [], nullableOrg: [] }]))
      for (const row of /** @type {Array<{ table_schema: string, table_name: string, has_org: boolean, org_not_null: boolean }>} */ (rows)) {
        const stat = bySchema.get(row.table_schema)
        if (!stat) continue
        stat.total++
        // 缺列归 T1、可空归 T2，**互斥**（有 not null 探针为真必然有列 ⇒ 两条不会同时命中），
        // 免得一张没有 org 的表被报两次（一次说缺列、一次说可空，第二条是噪声）。
        if (!row.has_org) stat.missingOrg.push(row.table_name)
        else if (!row.org_not_null) stat.nullableOrg.push(row.table_name)
      }
      return bySchema
    } finally {
      await pool.end().catch(() => {})
    }
  } finally {
    // 一次性库用完即弃（drop 在最后：此时池已关，没有别的连接挂在它上面）
    await admin.query(`drop database if exists ${SCRATCH_DB}`).catch(() => {})
    await admin.end().catch(() => {})
  }
}

/**
 * 门禁主逻辑（fixture 测试直接调它；CLI 只是它的壳）。
 *
 * DATABASE_URL 缺省时：**有待检模块就响亮失败**（本门禁的判据只能来自真库，静默跳过等于
 * 「门禁看着绿、一次都没跑」）；一个待检模块都没有（fixtures 常见）则不必连库，直接出结果。
 * @param {{ rootDir: string, dbUrl?: string | undefined }} opts
 * @returns {Promise<{ violations: Violation[], checked: number, skipped: number, tables: number }>}
 */
export async function checkTenantIsolation({ rootDir, dbUrl }) {
  const all = await collectModules(rootDir)
  /** @type {Violation[]} */
  const violations = []
  /** @type {Array<{ mod: Module, sql: ModuleSql }>} */
  const checked = []

  for (const mod of all) {
    const sql = parseModuleSql(mod)
    violations.push(...sql.violations)
    if (mod.files.length > 0) checked.push({ mod, sql })
  }

  let tables = 0
  if (checked.length > 0) {
    if (!dbUrl) {
      throw new Error('需要 DATABASE_URL：本门禁的判据是「真库里每张表都有 org 列」，没有库就无从判起（不静默跳过）')
    }
    const modules = checked.map((c) => c.mod)
    const bySchema = await inspectSchemas(dbUrl, modules)
    for (const { mod, sql } of checked) {
      const stat = bySchema.get(mod.id) ?? { total: 0, missingOrg: [], nullableOrg: [] }
      tables += stat.total

      // 空转自检：迁移里有建表迹象，库里却一张表都没见到 ⇒ 门禁对这个模块是瞎的，判违规
      if (sql.createHints > 0 && stat.total === 0) {
        violations.push({
          file: mod.migrationsDirRel,
          line: null,
          message: `schema "${mod.id}" 里一张表都没有，但迁移里有 ${sql.createHints} 处建表迹象——门禁对这个模块结构性地看不见（建表写在别的 schema / 认不出的写法 / 迁移没真的执行，三者之一）。请先确认迁移真在这条链上跑，再按需扩本守卫`,
        })
      }

      /**
       * 违规定位：认得出的建表写法 ⇒ 指到 `文件:行号`；认不出的 ⇒ 退回迁移目录（不伪造行号）
       * @param {string} table @returns {{ file: string, line: number | null }}
       */
      const at = (table) => {
        const site = sql.creates.get(table)
        return { file: site ? site.file : mod.migrationsDirRel, line: site ? site.line : null }
      }

      // 两条判据共用同一个豁免出口（标记的语义是「这张表不是租户数据表」，故 T1/T2 一起不适用；
      // 理由已由 parseModuleSql 校验非空）与同一段「全局表则加标记」的出口说明。
      const globalTableHint = `若它确为跨租户共享的全局表，请在它的 create table 上方加一行 \`-- global-table: <理由>\`（正典 docs/module-protocol.md「租户数据隔离」）`

      for (const table of stat.missingOrg) {
        if (sql.markers.get(table)) continue // 有豁免标记
        violations.push({
          ...at(table),
          message: `表 "${mod.id}.${table}" 跑完迁移后没有 org 列——租户数据表必须带 org（写法定典 \`org text not null\`，值 = identity.orgId），读写一律 \`where org = $1\`；${globalTableHint}`,
        })
      }

      for (const table of stat.nullableOrg) {
        if (sql.markers.get(table)) continue // 同一条豁免（标记说的是「它不是租户数据表」）
        violations.push({
          ...at(table),
          message: `表 "${mod.id}.${table}" 的 org 列可空——租户数据表**必须 not null**（正典 docs/module-protocol.md:181 逐字写着 \`org text not null\`）；可空 org 的行会从 \`where org = $1\` 里静默消失（NULL 不等于任何值），读不到与读错了同样难查。存量行先回填（无法归属的填空串——「宁可不可见，不可错归属」）再 \`alter table ${mod.id}.${table} alter column org set not null\`；${globalTableHint}`,
        })
      }
    }
  }

  return {
    violations: violations.sort((a, b) => (a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1)),
    checked: checked.length,
    skipped: all.length - checked.length,
    tables,
  }
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const result = await checkTenantIsolation({ rootDir, dbUrl: process.env.DATABASE_URL })
  if (result.violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${result.violations.length} 处违规`)
    for (const v of result.violations) {
      const at = v.line === null ? v.file : `${v.file}:${v.line}`
      console.error(`  ${at}: [${LABEL}] ${v.message}`)
    }
    process.exit(1)
  }
  // OK 行必须带计数：门禁「扫了 0 个模块」也是绿的，那种绿要靠人看得见（本仓 fetch-depth 教训）。
  // 措辞跟着判据走：查了两条（org 存在 + org not null）就说两条，别让 OK 行比实现少说一条。
  console.log(
    `${SCRIPT_NAME}: OK（${result.checked} 个模块 / ${result.tables} 张表全部带 org 且 not null；`
    + `跳过 ${result.skipped} 个无 migrations/ 的模块）`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
