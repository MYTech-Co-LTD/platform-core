#!/usr/bin/env node
// B7 compose 门禁（M0 计划 Task 20；R5 修复轮 S1 扩到「宿主端口绑定范围」）。
//
// 用法：tsx scripts/check-compose.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-compose: OK`；
//       有违规 → exit 1，stderr 每条一行 `相对路径: [B7] 说明`。
//
// 两条规则（同一脚本、同一 [B7] 标签——都是「compose 这个部署事实源」的约束）：
//   规则一（原）：全仓只放行 deploy/docker-compose.yml 本身。等价命令
//     `find . -name '*compose*.y*ml' -not -path './node_modules/*'`；
//     另有 `*compose*fragment*` 命中即违规（compose 片段是变相的多 compose 编排入口）。
//   规则二（R5 修复轮 S1 新增；R5-2 建议改 1/2/3 扩展）：deploy/docker-compose.yml 的
//     **宿主端口绑定**必须收在回环上。为什么需要它：R5 给这些端口加了回环绑定（免绕过 edge），
//     但**没有任何门禁守着**——把 `127.0.0.1:5432:5432` 改回 `5432:5432` 全绿通过（评审变异
//     实证）。原守卫只按文件名判唯一性、从不读内容。三条判据：
//       a) 文件里**所有** ports 条目都须以 `127.0.0.1:` 起头。**不再只看 postgres / server
//          两个字面服务名**：只覆盖这两个名字时，往文件里加第三个服务并暴露 `8080:8080`
//          会全绿，而本规则的目的正是「宿主端口不许留绕过 edge 的面」。要放行别的 host_ip
//          必须在这里**显式加白名单**，不要靠"那个服务不叫 postgres"蒙混过去。
//       b) postgres / server 两个受管服务**若出现在文件里**，各自至少要有一条 ports 条目。
//          **整份服务被删不报**——adopt 文档「生产差异」选项 2（不留 postgres、DATABASE_URL
//          指向托管库）是明列的生产路径，那不是绕过，而是把宿主暴露面整个去掉。
//          （R5-2 建议改 1：旧实现把"服务不存在"与"有服务但没端口"混成一条违规，于是选项 2
//          会让 CI 变红且**报错理由与事实相反**。）
//       c) 认不出的 ports 写法（flow 形式 `ports: ['1:2']` / `ports: []`…）一律判违规。判据 a
//          扩到「所有条目」之后，这类写法会**一条条目都解析不出来** ⇒ 不显式拦就等于静默放行，
//          所以这里 fail-closed：宁可让人来扩守卫，也不放行一个可能绑在 0.0.0.0 的映射。
//     **不在覆盖内**：`network_mode: host` 的服务——该模式下 compose **忽略 ports**，宿主的真实
//     绑定取决于进程自己的 listen 地址，本守卫读文本读不出来（本仓不用该模式；将来要用得单独扩
//     守卫，别以为本条规则替它兜了底）。
//     实现为**文本级**扫描（不引 YAML 解析器）：本脚本要在任意 fixtures 目录树上工作，
//     而端口映射的形态在本仓是固定的块序列（见下 parsePorts 的说明）。
//
// 三个实现判断：
//   ① 用 node 递归遍历而不是 spawn `find`：跨平台（Windows 无 find）、可对 fixtures 目录树直接跑。
//   ② 除 node_modules 外额外跳过 .git：VCS 内部构造上不含 compose 文件，扫描它只是浪费。
//      （.tmp 等本地目录【不】跳过——「全仓只有一个 compose」是字面要求，留在仓里的临时
//      compose 一样算多出来的编排事实源。）
//   ③ 规则二**只对被放行的那个文件**生效（别的 compose 文件已由规则一判违规，不必重复报），
//      且**文件不存在即跳过**——本门禁不要求该文件必须存在。
// 注：整文件级违规没有行号，故输出形如 `deploy/docker-compose.yml: [B7] …`（与
// scripts/check-manifests.mjs 的无行号报错一致），不伪造 `:1`。
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCRIPT_NAME = 'check-compose'

/** 唯一被放行的 compose 文件（相对 rootDir） */
const ALLOWED = 'deploy/docker-compose.yml'
/** 宿主端口映射必须用的 host_ip 前缀（规则二） */
const REQUIRED_HOST_IP = '127.0.0.1'
/**
 * 受管服务（规则二判据 b）：**服务还在**却没写 ports 就报——否则"删掉 ports 行"即可绕过本规则。
 * 整份服务被删**不报**（判定靠 parsePorts 的 `has()`，见 checkHostPortBindings 判据 b）。
 */
const REQUIRED_PORT_SERVICES = ['postgres', 'server']
/** 不进入的目录：依赖（brief 明示）+ VCS 内部（见头注判断②） */
const SKIP_DIRS = new Set(['node_modules', '.git'])
/** find -name '*compose*.y*ml' 的等价判定（对文件名大小写不敏感） */
const COMPOSE_NAME_RE = /compose.*\.ya?ml$/i
/** find -name '*compose*fragment*' 的等价判定（对相对路径） */
const FRAGMENT_RE = /compose.*fragment/i

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/')

/**
 * 文本级抽出「服务名 → ports 条目原文」（规则二）。
 *
 * 只认本仓实际使用的块序列（缩进 2 = 服务名，缩进 4 = `ports:`，缩进 6 = `- 条目`），
 * 且**只在 ports 块内**收条目 —— 否则 postgres 的 `volumes:` 下的 `- pgdata:/…`
 * 会被当成端口映射。任何缩进 ≤ 4 的新行都终止 ports 块。
 *
 * **已知边界（有意为之，fail-closed）**：flow 形式（`ports: ['1:2']` / `ports: []`）
 * 与引号内换行识别不了 —— 这类行会被 collectUnparsedPortsDeclarations 单独挑出来报违规
 * （判据 c）。报错方向是安全的（宁可让人来改守卫，也不静默放行一个绑在 0.0.0.0 的映射）；
 * 若将来真要用 flow 形式，这里与那条判据必须一起改。
 *
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function parsePorts(text) {
  /** @type {Map<string, string[]>} */
  const byService = new Map()
  /** @type {string | null} */
  let service = null
  let inPorts = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('#')) continue // 注释行（含 ports 块内的说明）
    if (line === '') continue
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (svc) {
      service = svc[1]
      inPorts = false
      if (!byService.has(service)) byService.set(service, [])
      continue
    }
    if (/^ {4}ports:\s*$/.test(line)) {
      inPorts = true
      continue
    }
    const entry = /^ {6}-\s*(.+)$/.exec(line)
    if (inPorts && entry) {
      byService.get(service ?? '')?.push(entry[1].trim())
      continue
    }
    if (/^ {0,4}\S/.test(line)) inPorts = false // 回到服务级/顶层键 ⇒ ports 块结束
  }
  return byService
}

/**
 * 归一化一条 ports 条目 → 用于前缀判定的值：剥掉 YAML 的包裹引号与行内注释。
 *
 * 为什么不能只做「去引号」：`- '127.0.0.1:5432:5432'  # 本地冒烟` 是**完全合法**的 compose
 * 写法，但「整条都裹在引号里」的写法锚在行尾（`^(['"])(.*)\1$`）⇒ 遇到尾注释整条失配 ⇒
 * 判定值带着引号与注释 ⇒ 被判「未绑回环」。方向是 fail-closed，但**理由与事实相反**
 * （R5-2 建议改 2）。
 *
 * 顺序：**先认引号、再认注释**。理由是 `#` 落在引号内是合法 YAML（`'#x'` 的内容就是 `#x`），
 * 先剥注释会把引号内的 `#` 误当注释起点。实现取「**第一个引号对** + 其后只许空白与注释」，
 * 而不是"整条被引号包裹"；裸值形态则取到第一个空白或 `#` 为止。
 * 两条形态都认不出来时**原样返回** ⇒ 前缀判定必失败 ⇒ 报违规（fail-closed）。
 *
 * @param {string} entry
 * @returns {string}
 */
export function normalizePortEntry(entry) {
  const s = entry.trim()
  const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(s)
  if (quoted) return quoted[2]
  const bare = /^([^\s#]+)\s*(?:#.*)?$/.exec(s)
  return bare ? bare[1] : s
}

/**
 * 找出**本守卫认不出**的 ports 声明（规则二判据 c）。
 *
 * 判据：该行含 `ports` 键，但**不是**本守卫认的块序列形态（缩进 4 的裸 `ports:`）。
 * 注释行跳过——文件头与块内的散文里出现 `ports:` 是常态，不该被当成声明。
 * 只返回有问题的行（原文 + 行号），供报错指位。
 *
 * @param {string} text
 * @returns {Array<{ line: number, text: string }>}
 */
export function collectUnparsedPortsDeclarations(text) {
  /** @type {Array<{ line: number, text: string }>} */
  const out = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('#')) return
    if (!/^\s*ports\s*:/.test(line)) return
    if (/^ {4}ports:\s*$/.test(line)) return // 本守卫认的形态（与 parsePorts 同一判据）
    out.push({ line: i + 1, text: line.trim() })
  })
  return out
}

/**
 * 规则二：对唯一放行的 compose 做宿主端口绑定检查（判据 a/b/c 见文件头）。
 * @param {string} rootDir
 * @param {Array<{ file: string, message: string }>} violations
 */
async function checkHostPortBindings(rootDir, violations) {
  let text
  try {
    text = await readFile(join(rootDir, ALLOWED), 'utf8')
  } catch {
    return // 文件不存在：本门禁不要求它必须存在（见头注判断③）
  }
  const byService = parsePorts(text)

  // 判据 a：**文件里所有** ports 条目一律须绑回环（R5-2 建议改 3 把覆盖面从两个字面
  // 服务名扩到全文——只覆盖服务名时，新增第三个服务暴露 `8080:8080` 会全绿）。
  for (const [service, entries] of byService) {
    for (const entry of entries) {
      const value = normalizePortEntry(entry)
      if (!value.startsWith(`${REQUIRED_HOST_IP}:`)) {
        violations.push({
          file: ALLOWED,
          message: `${service} 的 ports 映射 \`${entry}\` 未绑回环——必须写成 \`${REQUIRED_HOST_IP}:<宿主端口>:<容器端口>\`：无 host_ip 前缀的映射落在 0.0.0.0（IPv4 与 IPv6 双栈），任何能访问宿主该端口的人可**绕过 edge**（丢掉证书、限速与访问控制）`,
        })
      }
    }
  }

  // 判据 b：受管服务**还在**却一条 ports 条目都没有 ⇒ 报（"删掉 ports 行"不该是静默的绕过）。
  // 整份服务被删 ⇒ 跳过：adopt 文档「生产差异」选项 2 明列了这条路，报它等于报错理由与事实相反。
  for (const service of REQUIRED_PORT_SERVICES) {
    if (!byService.has(service)) continue
    const entries = byService.get(service) ?? []
    if (entries.length === 0) {
      violations.push({
        file: ALLOWED,
        message: `${service} 服务还在，却一条 ports 条目都没有——本地冒烟/排障经 \`${REQUIRED_HOST_IP}:<宿主端口>\` 直连它。要撤掉宿主暴露面请**整份删掉该服务**（adopt 文档「生产差异」选项 2），不要留一个空 ports 块：那会让"这里到底有没有宿主暴露面"变成看不出来的事`,
      })
    }
  }

  // 判据 c：认不出的 ports 写法 ⇒ fail-closed（见文件头说明）
  for (const decl of collectUnparsedPortsDeclarations(text)) {
    violations.push({
      file: ALLOWED,
      message: `第 ${decl.line} 行的 ports 写法 \`${decl.text}\` 本守卫认不出来——只支持块序列（缩进 4 的 \`ports:\` + 缩进 6 的 \`- '${REQUIRED_HOST_IP}:<宿主>:<容器>'\`）。flow 形式（如 \`ports: ['1:2']\`）解析不出条目，静默放行等于开着"绑 0.0.0.0 也全绿"的门，故判违规：请改成块序列，或扩本守卫`,
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
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const rel = toPosix(relative(rootDir, join(dir, entry.name)))
      if (FRAGMENT_RE.test(rel)) {
        violations.push({ file: rel, message: 'compose 片段（*compose*fragment*）——编排事实源只许 deploy/docker-compose.yml' })
        continue
      }
      if (!COMPOSE_NAME_RE.test(entry.name)) continue
      if (rel === ALLOWED) continue
      violations.push({ file: rel, message: `多出来的 compose 文件——全仓只许 ${ALLOWED}` })
    }
  }
  await walk(rootDir)
  await checkHostPortBindings(rootDir, violations)
  return violations.sort((a, b) => (a.file < b.file ? -1 : 1))
}

async function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = await findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}: [B7] ${v.message}`)
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
