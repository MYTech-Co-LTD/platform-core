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
//   规则二（R5 修复轮 S1 新增）：deploy/docker-compose.yml 里 **postgres 与 server 两条
//     ports 映射都必须显式绑回环**（`127.0.0.1:<宿主>:<容器>`）。为什么需要它：R5 给这两个
//     端口加了回环绑定（免绕过 edge），但**没有任何门禁守着**——把 `127.0.0.1:5432:5432`
//     改回 `5432:5432` 全绿通过（评审变异实证）。原守卫只按文件名判唯一性、从不读内容。
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
/** 必须各自声明至少一条宿主端口映射的服务（规则二）。缺映射同样报——否则"删掉 ports 行"即可绕过本规则 */
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
 * 与引号内换行识别不了 —— 前者会被判成"缺少端口映射"而报违规。报错方向是安全的
 * （宁可让人来改守卫，也不静默放行一个绑在 0.0.0.0 的映射）；若将来真要用 flow 形式，
 * 这里必须一起改。
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
 * 规则二：对唯一放行的 compose 做宿主端口绑定检查。
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
  for (const service of REQUIRED_PORT_SERVICES) {
    const entries = byService.get(service)
    if (!entries || entries.length === 0) {
      violations.push({
        file: ALLOWED,
        message: `${service} 服务缺少宿主端口映射——本地冒烟/排障经它直连；更紧要的是：删掉 ports 即可绕过「宿主端口必须绑回环」`,
      })
      continue
    }
    for (const entry of entries) {
      // 去掉 YAML 的包裹引号再做前缀判定（本仓写成 `- '127.0.0.1:5432:5432'`）
      const value = entry.replace(/^(['"])(.*)\1$/, '$2')
      if (!value.startsWith(`${REQUIRED_HOST_IP}:`)) {
        violations.push({
          file: ALLOWED,
          message: `${service} 的 ports 映射 \`${entry}\` 未绑回环——必须写成 \`${REQUIRED_HOST_IP}:<宿主端口>:<容器端口>\`：无 host_ip 前缀的映射落在 0.0.0.0（IPv4 与 IPv6 双栈），任何能访问宿主该端口的人可**绕过 edge**（丢掉证书、限速与访问控制）`,
        })
      }
    }
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
