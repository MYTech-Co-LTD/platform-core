#!/usr/bin/env node
// B7 compose 唯一门禁（M0 计划 Task 20）。
//
// 用法：tsx scripts/check-compose.mjs [rootDir]   # rootDir 默认 = 仓库根（fixtures 测试用形参）
// 契约：干净 → exit 0，stdout 一行 `check-compose: OK`；
//       有违规 → exit 1，stderr 每条一行 `相对路径: [B7] 说明`。
//
// 等价命令：`find . -name '*compose*.y*ml' -not -path './node_modules/*'`，只放行
// deploy/docker-compose.yml 本身；另有 `*compose*fragment*` 命中即违规（compose 片段是
// 变相的多 compose 编排入口，同样破坏「一个 compose 文件 = 一个部署事实源」）。
//
// 两个实现判断：
//   ① 用 node 递归遍历而不是 spawn `find`：跨平台（Windows 无 find）、可对 fixtures 目录树直接跑。
//   ② 除 node_modules 外额外跳过 .git：VCS 内部构造上不含 compose 文件，扫描它只是浪费。
//      （.tmp 等本地目录【不】跳过——「全仓只有一个 compose」是字面要求，留在仓里的临时
//      compose 一样算多出来的编排事实源。）
// 注：整文件级违规没有行号，故输出形如 `deploy/docker-compose.yml: [B7] …`（与
// scripts/check-manifests.mjs 的无行号报错一致），不伪造 `:1`。
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCRIPT_NAME = 'check-compose'

/** 唯一被放行的 compose 文件（相对 rootDir） */
const ALLOWED = 'deploy/docker-compose.yml'
/** 不进入的目录：依赖（brief 明示）+ VCS 内部（见头注判断②） */
const SKIP_DIRS = new Set(['node_modules', '.git'])
/** find -name '*compose*.y*ml' 的等价判定（对文件名大小写不敏感） */
const COMPOSE_NAME_RE = /compose.*\.ya?ml$/i
/** find -name '*compose*fragment*' 的等价判定（对相对路径） */
const FRAGMENT_RE = /compose.*fragment/i

/** @param {string} p */
const toPosix = (p) => p.split(sep).join('/')

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
