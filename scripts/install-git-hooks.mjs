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
// 已知缺口：`pnpm install --ignore-scripts` 不会跑 prepare；且依赖已装好的老 checkout
// 再跑 `pnpm install` 走 no-op 路径也不会重跑它（要手动 `pnpm run prepare`）。这两条由
// CI 的 gates job 校验钩子文件存在且可执行来兜（见 .github/workflows/ci.yml）。
// 改动本文件前先读 deploy/branch-protection-runbook.md 的四层机制说明。

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件所在目录（<仓根>/scripts/）。用它当 cwd，避免依赖调用方的当前目录。 */
const scriptDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * 跑一条 git 命令；成功返回 trim 过的 stdout，失败返回 null（失败即静默降级）。
 * @param {string[]} args
 * @returns {string | null}
 */
function tryGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: scriptDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

// 仓库根取 git 自己认定的那个（--show-toplevel），**不是**从本脚本位置倒推的目录。
// 理由：git 把 core.hooksPath 当"仓库根下的相对路径"解析，所以该检查 .githooks 是否
// 存在的目录、以及该写哪份 .git/config，都必须是 git 眼里的仓根。两者不一致只有两种
// 可能，而两种情况都**绝不能**去写配置：
//   (a) 本包被当依赖装进了别人的仓库（cwd 在 <consumer>/node_modules/... 下，
//       toplevel 却是 consumer 仓库根）——写了就把 consumer 的钩子全指向一个它那里
//       不存在的 .githooks，**该仓所有钩子静默失效**；
//   (b) 本文件被挪到了仓外。
const topLevel = tryGit(['rev-parse', '--show-toplevel'])

// 不在任何 git 工作树里：什么都不做，也不出声。
if (!topLevel) {
  process.exit(0)
}

const hooksDir = path.join(topLevel, '.githooks')

// 在这个仓库里却找不到 .githooks —— 这不该发生（该目录是入库的）。这里**必须出声**：
// 静默会让整条机制无声无息地失效，或更糟——去指向一个不存在的目录。
if (!existsSync(hooksDir)) {
  console.warn(`[install-git-hooks] 在 git 工作树 ${topLevel} 里，却找不到 .githooks/ —— 跳过。`)
  console.warn('[install-git-hooks] 若本仓确实应当有钩子，请检查 .githooks/ 是否还在（它是入库的）。')
  process.exit(0)
}

// 幂等：已经配好就静默退出。
const current = tryGit(['config', '--get', 'core.hooksPath'])
if (current === '.githooks') {
  process.exit(0)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: scriptDir,
    stdio: 'ignore',
  })
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err)
  console.warn(`[install-git-hooks] 设置 core.hooksPath 失败：${detail}`)
  console.warn('[install-git-hooks] 可手动执行：git config core.hooksPath .githooks')
  process.exit(0)
}

// git 只在钩子文件带执行位时才运行它；clone / 解包 / 拷贝都可能丢掉执行位，
// 因此这里显式补齐。整段包在 try 里：**"永不阻断安装"是绝对承诺**——连 readdirSync
// 失败（.githooks 是个普通文件 = ENOTDIR、或目录不可读 = EACCES）也不许让 install 挂掉。
try {
  for (const name of readdirSync(hooksDir)) {
    try {
      chmodSync(path.join(hooksDir, name), 0o755)
    } catch {
      /* 忽略：单个文件补执行位失败不该让安装失败 */
    }
  }
} catch {
  /* 忽略：列目录都失败了也不该让安装失败（此时上面的告警已足以提示异常） */
}

// 覆盖了别人已有的自定义 core.hooksPath 时，明确说出来 —— 静默改掉别人的本地配置很讨嫌。
if (current) {
  console.warn(`[install-git-hooks] 注意：原有的 core.hooksPath="${current}" 已被本仓的 .githooks 覆盖。`)
}

console.log('[install-git-hooks] 已启用仓库钩子（core.hooksPath=.githooks）—— 直推 main 会被拦下。')
