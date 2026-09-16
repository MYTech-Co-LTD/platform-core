#!/usr/bin/env node
// B9 env 完整门禁（M0 计划 Task 20）。
//
// 用法：tsx scripts/check-env-example.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-env-example: OK`；
//       有违规 → exit 1，stderr 每条一行 `相对路径:行号: [B9] 说明`。
//
// 扫描 apps/ + packages/ + modules/ 下的 .ts/.tsx（跳过 node_modules/dist/.tmp），提取：
//   - `process.env.KEY`（点读）
//   - `process.env['KEY']` / `process.env["KEY"]`（下标读——与点读是同一构造的等价写法，
//     不检等于留一个一字符的绕过口）
//   - **宿主注入式访问器**（apps/server/src/config.ts 的形态，缺了这组则本门禁对真实约束
//     零覆盖）：`env.KEY`（Env 记录的属性读）、`requireValue('KEY')`（必填形参）、
//     `optional('KEY')`（可选形参）。宿主不写 process.env——env 记录是注入口，键名以字符串
//     形参传给 requireValue/optional，故三种形态都要认。
// **`import.meta.env.*` 不在扫描面内**（M3b-2 起是通则，见规则③）。
// 每个键必须出现在根 .env.example（豁免见下）。B9 的目的：防「部署缺 env → 运行时静默降级」，
// 声明的存在性是可机检的那一半（值的合法性由 apps/server 的 fail-fast 装配负责）。
//
// 两条判定规则（都写在这里，避免后来者当成漏检）：
//   ① `.env.example` 里 `KEY=` 与注释行 `# KEY=` 都算声明。理由：.env.example 的职责是
//      「枚举 env 契约」，注释行的 `# SEED_DEMO=1  # dev：…` 完整写明了键名、示例值与适用
//      场景——它恰恰是**不该**被无脑复制的可选开关（照抄成 SEED_DEMO=1 就会在生产种 demo
//      租户）。要求它必须取消注释，等于逼模板写一个「复制即生效」的有害默认值。
//      判定用 `^\s*(?:export\s+)?#?\s*([A-Z][A-Z0-9_]*)\s*=`——`#` 是**可选**的：正式声明行
//      （`PORT=13000`）与注释声明行（`# SEED_DEMO=1  # dev：…`）都算；键名必须紧跟 `=`，
//      散文字里提一句键名不算声明。
//   ② 跳过 *.test.*：测试里 set/读 env 是 fixture 装配（本仓 DATABASE_URL 就在 4 个测试
//      文件里被读），不是部署面。纳入只会逼测试改名或加豁免清单。
//
// ── **`import.meta.env.*` 不作 B9 管辖**（M3b-2 起；取代原先「apps/web 的 VITE_ 键豁免」那条）──
// 理由：**Node/Hono 侧根本没有 `import.meta.env`**。它只存在于「被打包器处理过」的代码里，
// 凡本仓服务端代码出现它，必是**构建期注入的常量**（前端包）⇒ 值在构建时就烘进产物了，
// 不存在「部署缺 env ⇒ 运行时静默降级」这一面，即 B9 要防的那类事故在此**不成立**。
// 原先的写法是按**目录**特判（只有 apps/web 下才豁免，非 web 文件引用 VITE_ 仍受检）——
// 那在只有 apps/web 一个前端包时够用；`modules/aftersales/mobile` 是第二个前端包，
// 特判从此不够用（同一个「构建期注入」的事实，只因目录不同就给两种结论）。
// 故本门禁改为**按构造判**：凡 `import.meta.env.` 前缀的读取整体豁免，与包在哪无关；
// 也不需要维护一份「Vite 内建键名表」（BASE_URL/MODE/DEV/PROD/SSR… 会随 Vite 版本增删）。
//
// ⚠️ 这条豁免**不是**「漏检」：在**未打包**的服务端代码里写 `import.meta.env.X` 确实是个 bug
//    （Node 不定义该对象 ⇒ 取属性当崩），但那是**响亮地崩**、启动即暴露，不是 B9 要防的
//    静默降级 ⇒ 仍不归本门禁。部署面真正要注入的值，仍以 `process.env.KEY` /
//    宿主 `env.KEY` 的形态出现（那三组检测器照旧全检，本豁免对它们零影响）。
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCRIPT_NAME = 'check-env-example'

const SCAN_ROOTS = ['apps', 'packages', 'modules']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.tmp', '.git'])
const CODE_EXT_RE = /\.(ts|tsx)$/
/** 测试文件：文件名（非路径）里出现 .test. 即跳过（规则②） */
const SKIP_FILE_RE = /\.test\./

const ENV_DOT_RE = /process[.]env[.]([A-Z0-9_]+)/g
const ENV_INDEX_RE = /process[.]env\[['"]([A-Z0-9_]+)['"]\]/g
// 宿主注入式访问器（apps/server/src/config.ts）：负向后顾 `(?<![.\w])` 保证只认**独立**的
// `env` 绑定——`myenv.X`（标识符中段）与 `process.env.X` / `import.meta.env.X`（前缀带 `.`）
// 都不再被本条命中。前者的等价形态由 ENV_DOT_RE 负责（重复命中同键由下面的同文件同行同键去重兜底）；
// 后者整体不在扫描面内（见文件头规则③）。
// ⚠️ 曾用 `\benv[.]`：`\b` 在 `.` 之后**成立** ⇒ `import.meta.env.BASE_URL` 里的子串
//    `env.BASE_URL` 被当成宿主 env 记录读 ⇒ 假阳性（M3b-2 实测：mobile 包 router.ts 报 B9）。
// 键名形如 `env.TENANT_MODE` / `requireValue('PORT')` / `optional('PLATFORM_ORG')`。
const ENV_PROP_RE = /(?<![.\w])env[.]([A-Z][A-Z0-9_]*)/g
const ENV_REQUIRE_RE = /\brequireValue\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g
const ENV_OPTIONAL_RE = /\boptional\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/')

/**
 * 解析 .env.example：`KEY=` 与注释 `# KEY=` 都算声明（规则①），返回键集合。
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseEnvExample(text) {
  const keys = new Set()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)
    if (m) keys.add(m[1])
  }
  return keys
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
async function collectFiles(rootDir) {
  /** @type {string[]} */
  const found = []
  /** @param {string} dir */
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
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

/**
 * 扫描 rootDir，返回违规列表（file 为相对 rootDir 的 posix 路径）。
 * @param {string} rootDir
 * @returns {Promise<Array<{ file: string, line: number, key?: string, message?: string }>>}
 */
export async function findViolations(rootDir) {
  let declared
  try {
    declared = parseEnvExample(await readFile(join(rootDir, '.env.example'), 'utf8'))
  } catch (e) {
    // 没有基准文件 = B9 无法判定，按违规处理（不静默放行：静默放行正是 B9 要防的那种「缺了也不说」）
    const msg = e instanceof Error ? e.message : String(e)
    return [{ file: '.env.example', line: 0, key: '(基准文件缺失)', message: `无法读取根 .env.example：${msg}` }]
  }
  /** @type {Array<{ file: string, line: number, key?: string, message?: string }>} */
  const violations = []

  for (const abs of await collectFiles(rootDir)) {
    const rel = toPosix(relative(rootDir, abs))
    const src = await readFile(abs, 'utf8')
    const seen = new Set() // `${行号}:${键}`：多种形态命中同一处只报一次
    /** @param {string} key @param {number} line */
    const check = (key, line) => {
      const at = `${line}:${key}`
      if (seen.has(at)) return
      seen.add(at)
      if (declared.has(key)) return
      violations.push({ file: rel, line, key })
    }
    for (const m of src.matchAll(ENV_DOT_RE)) check(m[1], lineOf(src, m.index))
    for (const m of src.matchAll(ENV_INDEX_RE)) check(m[1], lineOf(src, m.index))
    for (const m of src.matchAll(ENV_PROP_RE)) check(m[1], lineOf(src, m.index)) // 反证②临时态
    for (const m of src.matchAll(ENV_REQUIRE_RE)) check(m[1], lineOf(src, m.index))
    for (const m of src.matchAll(ENV_OPTIONAL_RE)) check(m[1], lineOf(src, m.index))
  }

  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = await findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) {
      const at = v.line > 0 ? `${v.file}:${v.line}` : v.file
      const what = v.message ?? `env 键 "${v.key}" 未在根 .env.example 声明`
      console.error(`  ${at}: [B9] ${what}`)
    }
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
