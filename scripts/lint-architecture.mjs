#!/usr/bin/env node
// B1/B2/B8 架构门禁（M0 计划 Task 20）。
//
// 用法：tsx scripts/lint-architecture.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `lint-architecture: OK`；
//       有违规 → exit 1，stderr 每条一行 `相对路径:行号: [规则] 说明`（可直接 grep/path:line 命中）。
//
// 扫描根 = apps/ + packages/ + modules/：
//   - 全局硬编码约束（B8）的适用面就是「apps/ packages/ modules/ 源码」，B1/B2 同根扫描可以共用
//     一套遍历（packages/ 现在没有 SQL，且 packages/auth-core 正是认证代码的合法唯一归属地）。
//   - 跳过 node_modules/dist/build/coverage/.tmp/.git；跳过 *.test.* 与 *.gen.*——测试与生成物
//     不是模块边界纪律的适用对象（测试要故意引用别家 schema/别的域名来构造用例）。
//
// 规则：
//   B1 跨 schema 引用（正则 `(from|join|update|into)\s+([a-z_]+)\.` 提取 schema 名）：
//      apps/ + packages/（平台代码）只许 `platform`；modules/<dir>/ 只许该模块自身的 id
//      （读 modules/<dir>/manifest.yaml 的 id；manifest 缺失/不可读时退化为目录名——
//      三同纪律 id = DB schema = API 前缀，schema 白名单以 manifest 的 id 为准）。
//   B2 认证代码唯一：`jose` / `jsonwebtoken` / 任何 specifier 含 casdoor 的 import，只许
//      packages/auth-core/**（本仓唯一的认证代码归属地）；`@platform/auth-core` 只许
//      apps/server 引——宿主是唯一合法消费方，web 与 packages/platform-sdk 连 `import type`
//      都不许（brief 括注里「暂全禁」的落地读法）。
//   B8 硬编码禁令：出现 `hookflow.cn` 或点分 IPv4 字面量即违规，127.0.0.1 白名单。
//
// 两个实现判断（都写在这里，避免后来者以为是漏检）：
//   ① 先做「注释掩码」再扫描：注释里提到 hookflow.cn（例如本仓 packages/auth-core/src/wecom.ts
//      第 13 行的 B8 白名单说明注释）不是硬编码字面量，属误报。掩码只把注释字符换成空格，
//      代码位与字符串字面量内容都原样保留，所以**字符串里的 URL/IP 一定还在掩码结果里**：
//      掩码不会变成绕过口。前提是掩码自身不失步——正则字面量是唯一的失步源，两种方向都
//      真实可达（修复前各有探针）：
//        · 代码位 `//`：`/^https?:\/\//` 结尾的两个字符会被当注释起点，吃掉整行 →
//          同一行 `//` 之后的真实字面量一条也查不出（假阴性）；
//        · 正则里的引号：`/['"]/` 会把状态机带进字符串态且再也闭合不了，此后真注释不再被
//          遮罩 → 只含注释提及 hookflow.cn 的文件反而 fail（假阳性）。
//      故 maskComments 显式识别正则字面量并整体消费（见其函数注释）。
//      （已知边界：模板字符串 `${...}` 内部按字符串处理，其内的注释不遮罩。）
//   ② B1 的正则用 `\s+` 而非 brief 字面写的 `[ t]+`：后者是字符类（空格或字母 t），
//      `from platform.` 只有靠空格命中，换行/制表符会漏——语义显然是「空白」。
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

export const SCRIPT_NAME = 'lint-architecture'

/** 扫描根（相对 rootDir）——与全局约束 B8 的「apps/ packages/ modules/ 源码」一致 */
const SCAN_ROOTS = ['apps', 'packages', 'modules']
/** 不进入的目录：依赖/产物/本地临时物/VCS 内部 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.tmp', '.git'])
const CODE_EXT_RE = /\.(ts|tsx)$/
/** 测试与生成物：文件名（非路径）里出现 .test. / .gen. 即跳过 */
const SKIP_FILE_RE = /\.(test|gen)\./

const B1_RE = /\b(?:from|join|update|into)\s+([a-z_]+)\./g
const B2_SPEC_RE = /\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g
const B8_DOMAIN_RE = /hookflow\.cn/gi
const B8_IPV4_RE = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g
/** B8 白名单：本机回环（dev/探活日志里的 http://127.0.0.1:PORT 属正常） */
const B8_IP_ALLOW = new Set(['127.0.0.1'])

/** 这些字符之后的 `/` 是正则字面量起点（值/表达式不能以它们结尾）。
 *  故意**不含 `<`**（虽然表达式里 `a < /re/` 合法）：本仓 .tsx 全是 JSX，`</div>` 的 `/` 会被
 *  判成正则并一直吃到同行第一个 `/`，把紧随其后的 `// 注释` 的第一根斜杠吃掉、第二根斜杠
 *  因后随空格而不再是注释 → 注释里提到禁区字面量就误报（探针实测的回归，已由 fixture 钉住）。
 *  `<` 后的正则只可能出现在 `a < /re/.source` 这类荒谬写法里，漏掉它远好过 JSX 误报。 */
const REGEX_AFTER_CHAR = new Set(['(', '{', '[', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '>', '~', '^'])
/** 这些关键字之后的 `/` 也是正则起点（前一字符是标识符字符，靠关键字表区分于除号） */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case', 'throw',
])

/** 注释字符替换为空格（保留换行与长度 → 行号不变），代码位与字符串字面量内容原样保留。
 *
 * 为什么要额外识别正则字面量：JS 词法里「正则」是第四种字面量，`/` 既是除号也是正则起点，
 * 不区分就会在两个方向上失步（两者都真实可达，见文件头 ①）：
 *   - 把正则字面量内部的 `//`（/^https?:\/\// 结尾）当注释起点 → 吃掉整行，假阴性；
 *   - 把正则字面量内部的引号（/['"]/）当字符串起点 → 字符串态永不闭合，此后真注释不再被
 *     遮罩，假阳性。
 * 故见 `/` 时先判注释（`//`、`/*` 在 JS 里永远不可能是正则开头：空正则写作 /(?:)/，而 `*`
 * 不能作正则首字符，所以这两条判定不会被正则吃掉），再判是否处于「正则位置」，是则把整个
 * 正则字面量当作一个 token 消费掉（含字符类与转义），期间不做任何注释/字符串状态切换。
 *
 * 「正则位置」判定用「前一有效字符/关键字」启发式（与各类高亮器同款）：
 *   - 前一有效字符为空（文件/语句开头）或属于 REGEX_AFTER_CHAR → 正则；
 *   - 前一标识符是 REGEX_AFTER_KEYWORD（return / typeof / case …）→ 正则（它们后面必接表达式）；
 *   - 其余（标识符、`)`、`]`、`}`、字符串收尾引号）→ 视作除号，按普通代码字符处理。
 * 启发式必然有边界（如 `if (x) /re/.test(y)` 前是 `)` → 误判为除号），代价被限制在单行内：
 * 串/模板态的失步在行尾（未转义换行）兜底回 code，不会像修复前那样污染整个文件后续。
 * 模板字符串 `${...}` 仍按字符串整体处理（既有已知边界，见文件头 ①）。
 */
function maskComments(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl | regex
  let inClass = false // 正则内的字符类 [...]：其中的 `/` 不结束正则
  let prevSig = '' // 代码位最近一个非空白字符（判「正则位置」用）
  let word = '' // 代码位最近的标识符（return /re/ 这类靠关键字表兜）
  /** 代码位记账：空白不改变上下文；标识符字符续词，其他字符清词。 */
  const note = (c) => {
    if (/\s/.test(c)) return
    prevSig = c
    word = /[A-Za-z0-9_$]/.test(c) ? word + c : ''
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line'
        out += '  '
        i++
      } else if (c === '/' && next === '*') {
        state = 'block'
        out += '  '
        i++
      } else if (c === '/' && (prevSig === '' || REGEX_AFTER_CHAR.has(prevSig) || REGEX_AFTER_KEYWORD.has(word))) {
        state = 'regex'
        inClass = false
        out += c
        prevSig = ''
        word = ''
      } else {
        if (c === "'") state = 'sq'
        else if (c === '"') state = 'dq'
        else if (c === '`') state = 'tpl'
        out += c
        note(c)
      }
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
        prevSig = '' // 行首 = 正则位置
        word = ''
      } else out += ' '
      continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code'
        out += '  '
        i++
      } else out += c === '\n' ? '\n' : ' '
      continue
    }
    if (state === 'regex') {
      if (c === '\\') {
        out += c + (next ?? '') // 转义（含 \/ 与行尾续行）原样跳过
        i++
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        state = 'code'
        out += c
        prevSig = '/' // 正则结果是一个值
        word = ''
        continue
      } else if (c === '\n') {
        state = 'code' // 未闭合的正则（非法输入）：行尾兜底，不把状态泄漏到后续行
        out += c
        prevSig = ''
        word = ''
        continue
      }
      out += c
      continue
    }
    // 字符串/模板：转义跳过一个字符；闭合引号回到 code。内容原样保留（B8 要在字符串里查）。
    if (c === '\\') {
      out += c + (next ?? '')
      i++
      continue
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'
      out += c
      prevSig = c // 字符串收尾引号 = 一个值（其后的 / 是除号）
      word = ''
      continue
    }
    if (c === '\n' && state !== 'tpl') {
      // 单/双引号字符串不跨行（续行必须写 \，已由上面的转义分支吃掉）：行尾兜底防状态泄漏
      state = 'code'
      out += c
      prevSig = ''
      word = ''
      continue
    }
    out += c
  }
  return out
}

/** 1 基行号（index → 该位置所在行）。 */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

const toPosix = (p) => p.split(sep).join('/')

/** 递归收集待检文件（相对 rootDir 的 posix 路径 + 绝对路径）。 */
async function collectFiles(rootDir) {
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 根目录不存在（fixtures 常见）：跳过
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name))
      } else if (entry.isFile() && CODE_EXT_RE.test(entry.name) && !SKIP_FILE_RE.test(basename(entry.name))) {
        found.push(join(dir, entry.name))
      }
    }
  }
  for (const root of SCAN_ROOTS) await walk(join(rootDir, root))
  return found
}

/** 模块 schema 白名单：manifest.yaml 的 id 优先，缺失/不可读退化为目录名。 */
async function moduleIdOf(rootDir, dirName, cache) {
  if (cache.has(dirName)) return cache.get(dirName)
  let id = dirName
  try {
    const doc = parseYaml(await readFile(join(rootDir, 'modules', dirName, 'manifest.yaml'), 'utf8'))
    if (doc && typeof doc.id === 'string' && doc.id) id = doc.id
  } catch {
    // 无 manifest（或 YAML 挂了）→ 用目录名兜底；manifest 合法性由 B4/B5（check-manifests）负责
  }
  cache.set(dirName, id)
  return id
}

/** 该文件允许引用的 schema：modules/<id>/ 用自身 id，其余（平台代码）只许 platform。 */
async function allowedSchema(rootDir, relPath, cache) {
  const seg = relPath.split('/')
  if (seg[0] === 'modules' && seg.length > 2) return moduleIdOf(rootDir, seg[1], cache)
  return 'platform'
}

/** 扫描 rootDir，返回违规列表（file 为相对 rootDir 的 posix 路径）。 */
export async function findViolations(rootDir) {
  const violations = []
  const idCache = new Map()
  const report = (file, line, rule, message) => violations.push({ file, line, rule, message })

  for (const abs of await collectFiles(rootDir)) {
    const rel = toPosix(relative(rootDir, abs))
    const raw = await readFile(abs, 'utf8')
    const code = maskComments(raw) // 注释掩码：行号与字符串内容都不变

    // B1 跨 schema
    const allowed = await allowedSchema(rootDir, rel, idCache)
    for (const m of code.matchAll(B1_RE)) {
      const schema = m[1]
      if (schema === allowed) continue
      report(rel, lineOf(code, m.index), 'B1', `跨 schema 引用 "${schema}."（本文件只许 "${allowed}."）`)
    }

    // B2 认证代码唯一
    const inAuthCore = rel.startsWith('packages/auth-core/')
    const inServer = rel.startsWith('apps/server/')
    for (const m of code.matchAll(B2_SPEC_RE)) {
      const spec = m[1]
      const line = lineOf(code, m.index)
      if (spec === 'jose' || spec === 'jsonwebtoken' || /casdoor/i.test(spec)) {
        if (!inAuthCore) {
          report(rel, line, 'B2', `认证代码只许出现在 packages/auth-core/**：import "${spec}"`)
        }
      } else if (spec === '@platform/auth-core' || spec.startsWith('@platform/auth-core/')) {
        if (!inServer) {
          report(rel, line, 'B2', `@platform/auth-core 只许 apps/server 引（唯一合法消费方）：import "${spec}"`)
        }
      }
    }

    // B8 硬编码禁令
    for (const m of code.matchAll(B8_DOMAIN_RE)) {
      report(rel, lineOf(code, m.index), 'B8', `硬编码域名字面量 "${m[0]}"（禁止 hookflow.cn）`)
    }
    for (const m of code.matchAll(B8_IPV4_RE)) {
      const ip = m[0]
      if (B8_IP_ALLOW.has(ip)) continue
      if (ip.split('.').some((o) => Number(o) > 255)) continue // 不是合法 IPv4 字面量
      report(rel, lineOf(code, m.index), 'B8', `硬编码公网 IP 字面量 "${ip}"（127.0.0.1 除外）`)
    }
  }

  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = await findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}:${v.line}: [${v.rule}] ${v.message}`)
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
