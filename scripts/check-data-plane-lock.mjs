// scripts/check-data-plane-lock.mjs — 数据面投递机制的门禁（SOP §E.3）。
//
// ## 它防的是哪三个窟窿
//
// 1. **lock 自身被截断**。首行是「其余部分」的 sha256 ⇒ 少一行、多一行、改一行，首行都对不上。
// 2. **改了工件忘了重新生成 lock**。lock 说 sha256=A、仓里实际是 B ⇒ 投递上去的会是旧内容，
//    而机器侧一切正常（它只校验「取到的字节 == lock 说的字节」）。这类静默漂移是本机制要根治的
//    头号故障：S1 之前 `dbt/` 有 5 个文件停在 `d2de3b1`、`deploy/data-compose.yml` **从未投递过**。
// 3. **脚本引用了新路径、清单忘了登记**。静态提取 `$REPO/<路径>` 形态，要求每个都落在清单的
//    落地路径集合里 —— 这条才是「今天这个窟窿不再复发」的机制（原先 SOP 自述「唯一一例是
//    run-retail-day.sh」，实测消费面是 7 个路径）。
//
// ## 为什么判据 3 只扫 `$REPO/` 形态、而不是「扫全部路径引用」
//
// `$REPO/<路径>` 是脚本里**唯一**表达「我要读检出里那个文件」的形态（相对路径都锚在别处：容器内
// 路径由 compose bind 喂，其**源**已被 `duckle/`/`dbt/` 条目覆盖）。宽口径扫描会把 `/pipelines/`、
// `/workspace/` 这类**容器内**路径全部误报，那些不是投递物。
//
// 用法：`pnpm exec tsx scripts/check-data-plane-lock.mjs [rootDir]`（rootDir 默认仓根，测试用）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  LOCK_PATH,
  MANIFEST_PATH,
  REPO_PLACEHOLDER,
  buildLockText,
  lockRest,
  parseLock,
  parseManifest,
  sha256Of,
} from './lemeng/data-plane-lock.mjs'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-data-plane-lock'
/** 重新生成 lock 的命令——失败信息里必须复述它，否则「有意的摩擦」会变成「无解的摩擦」。 */
export const REGEN_COMMAND = 'pnpm exec tsx scripts/lemeng/data-plane-lock.mjs'
/** `$REPO` 在比对时替换成的哨兵串（清单里的落地路径写的是占位符，机器上才是真路径）。 */
const REPO_SENTINEL = '<REPO>'

/**
 * 允许出现在脚本里、但**不该**进清单的 `$REPO/` 引用。
 * 每条都必须给得出理由——加条目等于缩小守卫的覆盖面，是个该被看见的决定。
 *
 * ⚠️ `ref` 是**从脚本正文里逐字剥出来的原文**，不是解析后的路径：提取器是纯文本的（不解析变量
 * 赋值），所以引用写成 `$REPO/$FOO` 时，`ref` 就是字符串 `'$FOO'`。写「真路径」在这里匹配不上
 * ——守卫失败信息里打印的那个串，就是要原样抄进这里的那个串。
 * @type {ReadonlyArray<{ ref: string, reason: string }>}
 */
export const REPO_REF_EXCLUSIONS = [
  {
    ref: 'deploy/.env',
    reason: '运行时**写入**目标（DUCKLE_TOKEN 落这里，mode 600）——是机器本地物，不是被投递物；投递永不触及它',
  },
  {
    ref: '$REVISION_REL',
    reason:
      '同步程序在机器上**自己写出**的版本标记（`<检出>/.data-plane-revision`，落地路径写死成 ' +
      '`$REPO/$REVISION_REL`）——是投递的**产物**，不是投递物。它的语义恰恰是「这套文件是全的」，' +
      '仓里没有、也不该有对应文件；登记进清单会让生成器去读一个不存在的仓内路径',
  },
  {
    ref: '.$REVISION_REL.tmp.$$',
    reason: '上一条的同目录临时文件（`mv -f` 前的落点，原子换名用）——同上，机器本地、写后即消失，不进清单',
  },
]

/**
 * 从脚本正文里提取 `$REPO/<路径>` 形态的引用（`${REPO}` 与 `$REPO` 两种写法都算）。
 * @param {string} text 脚本正文
 * @returns {string[]} 去重后的仓内相对路径（不含前导 `/`）
 */
export function extractRepoRefs(text) {
  const normalized = text.replace(/\$\{REPO\}/g, '$REPO')
  const out = new Set()
  for (const m of normalized.matchAll(/\$REPO\/([^\s"'`;)]*)/g)) {
    const ref = (m[1] ?? '').replace(/\/+$/, '')
    if (ref !== '') out.add(ref)
  }
  return [...out].sort()
}

/**
 * 递归列出 `scripts/` 下的全部 `.sh`（仓内相对路径，posix 分隔符）。
 * @param {string} rootDir 仓根绝对路径
 * @returns {string[]} 相对路径
 */
export function listShellScripts(rootDir) {
  const root = join(rootDir, 'scripts')
  if (!existsSync(root)) return []
  /** @type {string[]} */
  const out = []
  /** @param {string} dir 绝对路径 */
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.isFile() && ent.name.endsWith('.sh')) out.push(relative(rootDir, abs).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 跑全部判据，返回违规表（空 = 干净）。
 * @param {string} rootDir 仓根绝对路径
 * @returns {Array<{ file: string, message: string }>} 违规
 */
export function findViolations(rootDir) {
  /** @type {Array<{ file: string, message: string }>} */
  const violations = []

  const manifestAbs = join(rootDir, MANIFEST_PATH)
  if (!existsSync(manifestAbs)) {
    return [{ file: MANIFEST_PATH, message: `清单不存在（SOP §E.3 ① 的正典落点就是它）` }]
  }
  const lockAbs = join(rootDir, LOCK_PATH)
  if (!existsSync(lockAbs)) {
    return [{ file: LOCK_PATH, message: `lock 不存在——跑 \`${REGEN_COMMAND}\` 生成` }]
  }

  /** @type {import('./lemeng/data-plane-lock.mjs').ManifestEntry[]} */
  let entries
  try {
    entries = parseManifest(readFileSync(manifestAbs, 'utf8'))
  } catch (err) {
    return [{ file: MANIFEST_PATH, message: (err instanceof Error ? err.message : String(err)) }]
  }

  const lockText = readFileSync(lockAbs, 'utf8')

  // 判据 1：lock 自校验（首行 = 其余部分的 sha256）
  /** @type {import('./lemeng/data-plane-lock.mjs').LockedFile[] | undefined} */
  let lockedFiles
  try {
    const parsed = parseLock(lockText)
    lockedFiles = parsed.files
    const actual = sha256Of(lockRest(lockText))
    if (parsed.self !== actual) {
      violations.push({
        file: LOCK_PATH,
        message:
          `首行自校验不符（写了 ${parsed.self}，实算 ${actual}）` +
          ` ⇒ lock 被截断或被改过；跑 \`${REGEN_COMMAND}\` 重新生成`,
      })
    }
    if (lockedFiles.length === 0) {
      violations.push({ file: LOCK_PATH, message: `lock 里一个文件都没有——跑 \`${REGEN_COMMAND}\` 重新生成` })
    }
  } catch (err) {
    violations.push({ file: LOCK_PATH, message: (err instanceof Error ? err.message : String(err)) })
  }

  // 判据 2：lock ↔ 工作区一致（缺行 / 多行 / 任一列不符）
  if (lockedFiles !== undefined && lockedFiles.length > 0) {
    const expected = buildLockText(rootDir, entries)
    const want = new Map(parseLock(expected).files.map((f) => [f.repoPath, f]))
    const got = new Map(lockedFiles.map((f) => [f.repoPath, f]))
    for (const [repoPath, w] of want) {
      const g = got.get(repoPath)
      if (g === undefined) {
        violations.push({
          file: LOCK_PATH,
          message: `缺行：${repoPath} 在清单展开里、却不在 lock 里（仓内新增文件后忘了重新生成？跑 \`${REGEN_COMMAND}\`）`,
        })
        continue
      }
      if (g.sha256 !== w.sha256) {
        violations.push({
          file: LOCK_PATH,
          message: `sha256 不符：${repoPath}（lock 写 ${g.sha256}，仓内实算 ${w.sha256}）——跑 \`${REGEN_COMMAND}\` 重新生成`,
        })
      } else if (g.landing !== w.landing || g.mode !== w.mode) {
        violations.push({
          file: LOCK_PATH,
          message: `落地路径/模式不符：${repoPath}（lock 写 ${g.landing} ${g.mode}，应为 ${w.landing} ${w.mode}）——跑 \`${REGEN_COMMAND}\` 重新生成`,
        })
      }
    }
    for (const repoPath of got.keys()) {
      if (!want.has(repoPath)) {
        violations.push({
          file: LOCK_PATH,
          message: `多行：${repoPath} 在 lock 里、却不在清单展开里（仓内删了文件？跑 \`${REGEN_COMMAND}\` 重新生成）`,
        })
      }
    }
  }

  // 判据 3：消费面覆盖 —— 脚本里的每个 `$REPO/<路径>` 都要被清单覆盖
  const landings = entries.map((e) => ({
    path: e.landing.replaceAll(REPO_PLACEHOLDER, REPO_SENTINEL),
    isDir: e.isDir,
  }))
  const excluded = new Set(REPO_REF_EXCLUSIONS.map((e) => e.ref))
  for (const script of listShellScripts(rootDir)) {
    for (const ref of extractRepoRefs(readFileSync(join(rootDir, script), 'utf8'))) {
      if (excluded.has(ref)) continue
      const want = `${REPO_SENTINEL}/${ref}`
      const covered = landings.some((l) => (l.isDir ? want.startsWith(l.path) : want === l.path))
      if (!covered) {
        violations.push({
          file: script,
          message:
            `引用了 $REPO/${ref}，但它不在 ${MANIFEST_PATH} 的落地路径集合里` +
            ` ⇒ 该文件永远不会被投递到机器上（这正是本机制要根治的漏法）；` +
            `把它登记进清单，或（若确属机器本地物）加进 ${SCRIPT_NAME} 的 REPO_REF_EXCLUSIONS 并写明理由`,
        })
      }
    }
  }

  return violations.sort((a, b) => (a.file === b.file ? a.message.localeCompare(b.message) : a.file.localeCompare(b.file)))
}

/** CLI 入口。 @returns {void} */
function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  // 判据 2 依赖 git 枚举（`git ls-files`）——不是 git 仓就跑不了，宁可显式失败也不静默跳过判据。
  try {
    execFileSync('git', ['-C', rootDir, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
  } catch {
    console.error(`${SCRIPT_NAME}: ${rootDir} 不是 git 仓库——本守卫需要 git 枚举受版本控制的文件`)
    process.exit(2)
  }
  const violations = findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}: ${v.message}`)
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
