#!/usr/bin/env node
// B12 开源边界门禁（公开仓不得依赖私有件）—— 正典 docs/architecture.md §4.1 B12。
//
// 用法：tsx scripts/check-no-private-deps.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-no-private-deps: OK`；
//       有违规 → exit 1，stderr 每条一行 `相对路径: [B12] 说明`。
//
// 为什么需要它：本仓（platform-core）是**公开仓**（GitHub visibility=public），闭源引擎在**私有仓**
// case-engine。公开仓的核心不变量是「**外部 clone 即可独立构建与运行**」——一旦依赖任何私有件，
// 外部构建必然失败，开源承诺就不成立。这条边界靠人守不住：加一行 dependency、加一个 submodule
// 都是**全绿通过、CI 一声不响**，故机械锁死。
//
// 四条判据（各自独立报违规；每条报错都说清「违反了哪条 + 怎么修」）：
//   ① 仓内不存在 `.gitmodules` —— submodule 是拉私有仓最直接的形态，且它**不经过包管理器**，
//      依赖扫描（判据 ③）结构性看不见它。
//   ② 任何 `package.json` 的 `publishConfig.registry`、以及仓内任何 `.npmrc` 的 `registry` /
//      `@scope:registry` 行，都不得指向**非公开** registry（公开主机白名单见 PUBLIC_REGISTRY_HOSTS）。
//      判不出公开性的写法（不是合法 URL / 协议不是 http(s)）一律按违规处理（fail-closed）——
//      认不出就不放行，别让它悄悄变成「外部取不到、我们本地有缓存所以全绿」。
//   ③ 任何 `package.json` 的依赖名不得命中**私有件名单**（PRIVATE_PACKAGE_PATTERNS）；
//      覆盖面 = dependencies / devDependencies / peerDependencies / optionalDependencies /
//      pnpm.overrides。
//   ④ 源码里不得出现私有包的 import / require（静态说明符）。
//
// ⚠️ 判据 ③④ 是**名单式**，不是自动判定：**新增私有件必须往 PRIVATE_PACKAGE_PATTERNS 加名字**，
//    否则本门禁**认不出**它。名单式是刻意的——「什么算私有」没有机械判据，硬编启发式（比如
//    「名字里有 internal 就算」）只会同时造出假阳性与假阴性，比名单更难维护。改名单＝改本脚本，走 PR。
//
// 两个实现判断：
//   ① 用 node 递归遍历而不是 spawn `find`/`grep`：跨平台（Windows 无 find），且能对 fixtures 目录树
//      直接跑（rootDir 形参）。
//   ② 除 node_modules 外跳过 .git：VCS 内部构造上不含依赖声明，扫它只是浪费。
//      **构建产物目录不额外跳过**（dist/out/coverage 是 .gitignore 里的，新鲜 clone 里不存在；
//      本机存在时扫到的是生成物，误报方向是 fail-closed，可接受）。
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCRIPT_NAME = 'check-no-private-deps'

/**
 * **私有件名单**（判据 ③④ 的判据源）。名单式——新增私有件**必须**在这里加名字，否则门禁认不出。
 *
 * 语义：逐字相等，或尾部 `*` 通配（`case-engine-*` ⇒ 前缀 `case-engine-`）。
 * 匹配时名字先原样比一次、再**剥掉 scope 前缀**比一次——私有件可能带任意 scope
 * （`@platform/case-engine-x` / `@mytech/case-engine`），而名单里写的是包名本体。
 * 初始三项 = 今天的全部已知私有件（闭源引擎 case-engine 的三种命名形态）。
 */
export const PRIVATE_PACKAGE_PATTERNS = ['case-engine', '@platform/case-engine', 'case-engine-*']

/**
 * 公开 registry 主机白名单（判据 ②）。**只有**这里的主机算「外部 clone 能取到」。
 * npmjs 官方 + 两个公开镜像；要用别的公开 registry 就往这里加（这是刻意的显式动作：
 * 一个陌生的主机名到底公开不公开，机械判不出来）。
 */
const PUBLIC_REGISTRY_HOSTS = new Set([
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'registry.yarnpkg.com',
])

/** 不进入的目录：依赖（见头注判断②）+ VCS 内部 */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** 判据 ③ 的依赖字段（package.json 里能声明依赖的地方） */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/** 判据 ④ 的「源码」扩展名（含 SFC 的 .vue：其 script 块同样是模块说明符） */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'])

/**
 * 模块说明符提取（判据 ④）。一条正则覆盖四种形态：
 * `from 'x'` / `export … from 'x'` / `import 'x'`（副作用 import）/ `import('x')` / `require('x')`。
 * 不做 AST 解析（本脚本要在任意 fixtures 目录树上跑，且不引 TS 依赖）：注释里的同形文本会误报，
 * 而误报方向是 fail-closed，且它**只对命中私有件名单的说明符**才报，噪声面极窄。
 */
const IMPORT_SPECIFIER_RE = /\b(?:from|import|require)\s*\(?\s*(['"])([^'"]+)\1/g

/** `.npmrc` 的 registry 声明行（含 `@scope:registry=`） */
const NPMRC_REGISTRY_RE = /^\s*(?:@[^:=\s]+:)?registry\s*=\s*(.+?)\s*$/

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/')

/**
 * 名单匹配（判据 ③④ 的核心）。**不做大小写归一**——npm 包名本身必须小写，出现大写名是另一个问题。
 * @param {string} pattern 名单项（可带尾部 `*`）
 * @param {string} name 包名（不含子路径）
 * @returns {boolean}
 */
function matchesPattern(pattern, name) {
  const candidates = [name, name.replace(/^@[^/]+\//, '')]
  return candidates.some((c) =>
    pattern.endsWith('*') ? c.startsWith(pattern.slice(0, -1)) : c === pattern,
  )
}

/**
 * 从模块说明符取**包名**：`@scope/a/b` → `@scope/a`；`a/b` → `a`（子路径不是包名的一部分）。
 * 先剥子路径再比名单，否则 `case-engine/dist/x` 会被当成一个陌生名字而漏判。
 * @param {string} spec
 * @returns {string}
 */
function packageNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * 该模块说明符是否指向私有件（判据 ④）。导出的原因是让将来可能加的 fixture 单测能直接钉住判据。
 * @param {string} spec 模块说明符（可含子路径）
 * @returns {boolean}
 */
export function isPrivateSpecifier(spec) {
  const pkg = packageNameOf(spec)
  return PRIVATE_PACKAGE_PATTERNS.some((pattern) => matchesPattern(pattern, pkg))
}

/**
 * registry 值的公开性判定（判据 ②）。三条：能解析成 URL、协议是 http(s)、主机在白名单里。
 * 任一不满足 ⇒ 违规（含「认不出」的情形，fail-closed）。
 * @param {string} value
 * @returns {{ ok: boolean, reason: string }} 单形状、字段恒在（`reason` 在 ok 时为空串）
 */
function checkRegistryValue(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return {
      ok: false,
      reason: `registry 值 \`${value}\` 不是合法 URL，门禁判不出它是否公开 ⇒ 按违规处理（fail-closed）。请写成公开 registry 的完整 URL（如 https://registry.npmjs.org/）`,
    }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      reason: `registry 值 \`${value}\` 的协议是 \`${url.protocol}\`，只放行 http(s) 形态的公开 registry`,
    }
  }
  if (!PUBLIC_REGISTRY_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason: `registry 指向非公开主机 \`${url.hostname}\`——外部 clone 的人取不到它，**构建必失败**，开源承诺不成立。改用公开 registry（${[...PUBLIC_REGISTRY_HOSTS].join(' / ')}），或把这条声明从仓里去掉`,
    }
  }
  return { ok: true, reason: '' }
}

/**
 * 判据 ③：package.json 里的依赖名。
 * @param {string} rel
 * @param {string} abs
 * @param {Array<{ file: string, message: string }>} violations
 */
async function checkPackageJson(rel, abs, violations) {
  const pkg = JSON.parse(await readFile(abs, 'utf8'))

  // 判据 ②：publishConfig.registry 必须指向公开 registry
  const registry = pkg?.publishConfig?.registry
  if (typeof registry === 'string') {
    const verdict = checkRegistryValue(registry)
    if (!verdict.ok) {
      violations.push({ file: rel, message: `publishConfig.registry：${verdict.reason}` })
    }
  }

  // 判据 ③：依赖名（四个标准字段 + pnpm.overrides——override 能把一个私有件钉进整棵依赖树）
  const declarations = []
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(pkg?.[field] ?? {})) declarations.push(`${field} 的 \`${name}\``)
  }
  for (const name of Object.keys(pkg?.pnpm?.overrides ?? {})) declarations.push(`pnpm.overrides 的 \`${name}\``)
  for (const decl of declarations) {
    const name = /`([^`]+)`/.exec(decl)?.[1] ?? ''
    if (isPrivateSpecifier(name)) {
      violations.push({
        file: rel,
        message: `${decl} 命中**私有件名单**（${PRIVATE_PACKAGE_PATTERNS.join(' / ')}）——公开仓依赖私有件 ⇒ 外部 clone 装不上依赖、构建必失败。解法二选一：① 把该依赖从本仓去掉（契约/扩展点留在公开仓，实现留在私有仓）；② 它其实不是私有件 ⇒ 往 scripts/check-no-private-deps.mjs 的 PRIVATE_PACKAGE_PATTERNS 里订正名单（走 PR）`,
      })
    }
  }
}

/**
 * 判据 ②：`.npmrc` 的 registry 声明。
 * @param {string} rel
 * @param {string} abs
 * @param {Array<{ file: string, message: string }>} violations
 */
async function checkNpmrc(rel, abs, violations) {
  const text = await readFile(abs, 'utf8')
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('#') || line.trimStart().startsWith(';')) return
    const m = NPMRC_REGISTRY_RE.exec(line)
    if (!m) return
    const value = m[1].replace(/^(['"])(.*)\1$/, '$2')
    const verdict = checkRegistryValue(value)
    if (!verdict.ok) {
      violations.push({
        file: rel,
        message: `第 ${i + 1} 行的 registry 声明：${verdict.reason}。公开仓里的 .npmrc 只许声明公开 registry；私有 registry 的凭据/地址属于构建期私有依赖，会连同它一起破坏外部构建`,
      })
    }
  })
}

/**
 * 判据 ④：源码里的私有包 import / require。
 * @param {string} rel
 * @param {string} abs
 * @param {Array<{ file: string, message: string }>} violations
 */
async function checkImports(rel, abs, violations) {
  const text = await readFile(abs, 'utf8')
  IMPORT_SPECIFIER_RE.lastIndex = 0
  for (const m of text.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = m[2]
    if (!isPrivateSpecifier(spec)) continue
    const line = text.slice(0, m.index).split('\n').length
    violations.push({
      file: rel,
      message: `第 ${line} 行 import 了私有包 \`${spec}\`（包名 \`${packageNameOf(spec)}\` 命中私有件名单）——源码级依赖私有件与依赖声明级同罪：外部 clone 拿到的是一个**编译不过**的树。解法：改成对公开仓里契约/扩展点的引用（薄模块 + 契约留公开仓，引擎实现留私有仓），或订正名单（走 PR）`,
    })
  }
}

/**
 * @param {string} rootDir
 * @returns {Promise<Array<{ file: string, message: string }>>}
 */
export async function findViolations(rootDir) {
  /** @type {Array<{ file: string, message: string }>} */
  const violations = []
  /** @param {string} dir */
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 根目录不存在：跳过
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = toPosix(relative(rootDir, abs))
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs)
        continue
      }
      if (!entry.isFile()) continue // 符号链接/设备文件：不跟（跟出去会扫到仓外）
      if (entry.name === '.gitmodules') {
        violations.push({
          file: rel,
          message:
            '仓内存在 `.gitmodules`——submodule 是拉私有仓最直接的形态，且它**不经过包管理器**，依赖扫描结构性看不见。公开仓里任何 submodule 都必须是**公开**仓；私有件请改成「公开仓只放契约/扩展点，实现在私有仓」的分仓形态，不要用 submodule 拉进来',
        })
        continue
      }
      if (entry.name === 'package.json') {
        await checkPackageJson(rel, abs, violations)
        continue
      }
      if (entry.name === '.npmrc') {
        await checkNpmrc(rel, abs, violations)
        continue
      }
      if (SOURCE_EXTENSIONS.has(extname(entry.name))) await checkImports(rel, abs, violations)
    }
  }
  await walk(rootDir)
  return violations.sort((a, b) => (a.file < b.file ? -1 : 1))
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = await findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}: [B12] ${v.message}`)
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
