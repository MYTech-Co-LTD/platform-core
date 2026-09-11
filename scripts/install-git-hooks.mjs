// scripts/install-git-hooks.mjs —— 让"同事 clone 之后也自动装上限流钩子"这件事真的发生。
//
// 背景：git 的 core.hooksPath **不随 clone 继承**（它是本地配置，不是版本化内容）。
// 所以光把钩子放进仓里的 .githooks/ 是白搭 —— 新 clone 的人不设 core.hooksPath，
// 钩子就永远不会跑。本脚本挂在根 package.json 的 `prepare` 生命周期上（pnpm/npm 在
// install 之后会执行根工程的 prepare），于是"clone + pnpm install"这一步就把钩子装上了，
// 不需要任何人记得额外做什么。
//
// 幂等：已经指向 .githooks 就静默退出，重复执行不会重复刷屏。
// 永不阻断安装：任何失败都只警告、不 exit 非 0 —— 装依赖不该因为钩子装不上而失败。
//
// 已知缺口：`pnpm install --ignore-scripts` 不会跑 prepare。这条由 CI 的 gates job
// 校验钩子文件存在且可执行来兜（见 .github/workflows/ci.yml）。改动本文件前先读
// deploy/branch-protection-runbook.md 的四层机制说明。

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件在 <repoRoot>/scripts/ 下，故往上一级即仓根。
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const hooksDir = path.join(repoRoot, '.githooks')

/**
 * 跑一条 git 命令；成功返回 trim 过的 stdout，失败返回 null（失败即静默降级）。
 * @param {string[]} args
 * @returns {string | null}
 */
function tryGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

// 不在 git 工作树里（例如本包被当成依赖装进了别人的 node_modules，或源码包被解到别处）：
// 什么都不做，也不出声。
if (tryGit(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  process.exit(0)
}

// 在工作树里、却找不到 .githooks —— 这不该发生（该目录是入库的）。这里**必须出声**：
// "脚本被挪了位置导致仓根算错"正是这种症状，静默会让整条机制无声无息地失效。
if (!existsSync(hooksDir)) {
  console.warn('[install-git-hooks] 在 git 工作树里，却找不到 .githooks/ —— 跳过。')
  console.warn('[install-git-hooks] 若本仓确实应当有钩子，请检查本脚本是否被移动过（它假定自己在 <仓根>/scripts/ 下）。')
  process.exit(0)
}

// 幂等：已经配好就静默退出。
const current = tryGit(['config', '--get', 'core.hooksPath'])
if (current === '.githooks') {
  process.exit(0)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repoRoot,
    stdio: 'ignore',
  })
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err)
  console.warn(`[install-git-hooks] 设置 core.hooksPath 失败：${detail}`)
  console.warn('[install-git-hooks] 可手动执行：git config core.hooksPath .githooks')
  process.exit(0)
}

// git 只在钩子文件带执行位时才运行它；clone / 解包 / 拷贝都可能丢掉执行位，
// 因此这里显式补齐（失败不致命，忽略）。
for (const name of readdirSync(hooksDir)) {
  try {
    chmodSync(path.join(hooksDir, name), 0o755)
  } catch {
    /* 忽略：补执行位失败不该让安装失败 */
  }
}

// 覆盖了别人已有的自定义 core.hooksPath 时，明确说出来 —— 静默改掉别人的本地配置很讨嫌。
if (current) {
  console.warn(`[install-git-hooks] 注意：原有的 core.hooksPath="${current}" 已被本仓的 .githooks 覆盖。`)
}

console.log('[install-git-hooks] 已启用仓库钩子（core.hooksPath=.githooks）—— 直推 main 会被拦下。')
