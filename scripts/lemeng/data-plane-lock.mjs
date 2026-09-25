// scripts/lemeng/data-plane-lock.mjs — 生成 `deploy/data-plane.lock`（SOP §E.3 ②）。
//
// ## 它解决什么
//
// `merge main` **不到达**数据面机（那边是 tarball 解包、没有 `.git`，SOP §E.1）⇒ 仓里的工件与
// 机器上那份是两份无自动同步的副本。投递时**唯一能拦住「半截文件」的东西是逐文件 sha256 断言**
// ——代理截断实测间歇复现（停在 9,324 / 11,341 B，SOP §E.4）。本脚本把「该有哪些文件、各是什么
// sha256、落到哪里、什么模式」在**控制面侧**算成一份可核验的清单，机器侧只消费它。
//
// ## 为什么锁「工作区」而不是某个 commit
//
// 用法是「改动清单覆盖的任一文件 → 重跑本脚本 → 提交」。若内容取自 `git show <commit>:<path>`，
// 改完文件后重跑取到的仍是**旧内容** ⇒ 守卫恒红、这条路永远追不上工作区。所以：
//   · 枚举：`git ls-files`（索引 + 未跟踪且未被 .gitignore 忽略的文件）——「即将提交的那份」；
//   · 内容：**工作区**读盘。
// 于是 `[全SHA]` 参数**没有存在意义**，不带；投递时才由同步程序接受全 SHA（那是另一件事：
// 按该 SHA 从远端取件）。
//
// ## lock 格式（T2 的 `sync-data-plane.sh` 逐字消费，改动即破坏契约）
//
//     sha256-of-rest <其余部分的 sha256>
//     <文件 sha256> <仓内路径> <落地路径> <模式>
//     ...
// 首行是**其余部分**的自校验：lock 自身被截断时首行必对不上 ⇒ fail loud，不必额外机制。
//
// 用法：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs [rootDir]`（rootDir 默认仓根，测试用）。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 脚本名（输出前缀 + 守卫复述命令时用）。 */
export const SCRIPT_NAME = 'data-plane-lock'
/** 清单在仓内的固定路径。 */
export const MANIFEST_PATH = 'deploy/data-plane-manifest.txt'
/** lock 在仓内的固定路径。 */
export const LOCK_PATH = 'deploy/data-plane.lock'
/** 清单里代表「检出根」的占位符——同步程序在机器上把它替换成真实路径。 */
export const REPO_PLACEHOLDER = '${REPO}'
/** lock 首行的键名（自校验行）。 */
export const LOCK_HEADER_KEY = 'sha256-of-rest'

/**
 * 一条清单条目。
 * @typedef {object} ManifestEntry
 * @property {string} repoPath 仓内路径（目录条目以 `/` 结尾）
 * @property {string} landing 落地路径模板（可含 `${REPO}`）
 * @property {string} mode 八进制模式串，如 `0644`
 * @property {boolean} isDir 是否目录条目（= 递归）
 */

/**
 * 一个被锁定的文件。
 * @typedef {object} LockedFile
 * @property {string} repoPath 仓内路径
 * @property {string} landing 落地路径模板
 * @property {string} mode 八进制模式串
 * @property {string} sha256 文件内容的 sha256（小写十六进制）
 */

const MODE_RE = /^0[0-7]{3}$/

/**
 * 算一段内容的 sha256（小写十六进制）。
 * @param {string | Buffer} data 内容
 * @returns {string} 十六进制摘要
 */
export function sha256Of(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 解析清单文本。空行与 `#` 注释行忽略；每行必须是三列。
 * 三条硬校验（越早失败越好——它们都会让 lock 无法被同步程序逐字解析）：
 * 路径不含空白、模式是 `0[0-7]{3}`、目录条目的落地路径也以 `/` 结尾。
 * @param {string} text 清单全文
 * @returns {ManifestEntry[]} 条目（保持清单顺序）
 */
export function parseManifest(text) {
  /** @type {ManifestEntry[]} */
  const entries = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw === undefined) continue
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const cols = line.split(/\s+/)
    if (cols.length !== 3) {
      throw new Error(
        `${MANIFEST_PATH}:${i + 1}: 期望三列（仓内路径 落地路径 模式），实得 ${cols.length} 列：${line}`,
      )
    }
    const [repoPath, landing, mode] = /** @type {[string, string, string]} */ (cols)
    const isDir = repoPath.endsWith('/')
    if (isDir !== landing.endsWith('/')) {
      throw new Error(
        `${MANIFEST_PATH}:${i + 1}: 目录条目的落地路径也必须以 / 结尾（仓内 ${repoPath} / 落地 ${landing}）`,
      )
    }
    if (!MODE_RE.test(mode)) {
      throw new Error(`${MANIFEST_PATH}:${i + 1}: 模式须形如 0644，实得 ${mode}`)
    }
    entries.push({ repoPath, landing, mode, isDir })
  }
  if (entries.length === 0) throw new Error(`${MANIFEST_PATH}: 清单为空`)
  return entries
}

/**
 * 枚举清单覆盖的仓内文件（相对路径，posix 分隔符，按字典序）。
 *
 * 用 `git ls-files --cached --others --exclude-standard` 而非遍历文件系统：**受版本控制 + 未被
 * .gitignore 忽略**才是「该被投递的那份」。遍历文件系统会把 `dbt/target/` 这类本地产物也卷进来
 * ——而它们正是机器上的本地状态，绝不能被登记（SOP §E.2 末）。
 * @param {string} rootDir 仓根绝对路径
 * @param {ManifestEntry[]} entries 清单条目
 * @returns {string[]} 仓内相对路径
 */
export function listCoveredFiles(rootDir, entries) {
  const pathspecs = entries.map((e) => e.repoPath)
  const out = execFileSync(
    'git',
    ['-C', rootDir, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    { encoding: 'utf8' },
  )
  const files = out.split('\n').filter((l) => l !== '')
  for (const f of files) {
    if (/\s/.test(f)) {
      throw new Error(
        `仓内路径含空白，lock 的四列格式无法表达：${JSON.stringify(f)}（改名或改清单，别让 lock 有歧义）`,
      )
    }
  }
  return [...new Set(files)].sort()
}

/**
 * 一个仓内路径属于哪条清单条目（目录条目按前缀匹配）。
 * @param {ManifestEntry[]} entries 清单条目
 * @param {string} repoPath 仓内相对路径
 * @returns {ManifestEntry | undefined} 命中的条目
 */
function matchEntry(entries, repoPath) {
  return entries.find((e) => (e.isDir ? repoPath.startsWith(e.repoPath) : repoPath === e.repoPath))
}

/**
 * 展开清单 → 逐个文件的 {仓内路径, 落地路径, 模式}。
 * @param {string} rootDir 仓根绝对路径
 * @param {ManifestEntry[]} entries 清单条目
 * @returns {Array<{ repoPath: string, landing: string, mode: string }>} 展开结果（按仓内路径排序）
 */
export function expandManifest(rootDir, entries) {
  return listCoveredFiles(rootDir, entries).map((repoPath) => {
    const entry = matchEntry(entries, repoPath)
    if (entry === undefined) {
      // 不可能：listCoveredFiles 的 pathspec 就是这些条目。留成显式失败而不是静默跳过。
      throw new Error(`内部不一致：${repoPath} 不由任何清单条目覆盖`)
    }
    const landing = entry.isDir ? entry.landing + repoPath.slice(entry.repoPath.length) : entry.landing
    if (/\s/.test(landing)) {
      throw new Error(`落地路径含空白，lock 的四列格式无法表达：${JSON.stringify(landing)}`)
    }
    return { repoPath, landing, mode: entry.mode }
  })
}

/**
 * 按清单算出一份 **lock 全文**（含首行自校验）。纯函数式的最后一段：给定文件集合即给定 lock。
 * @param {string} rootDir 仓根绝对路径
 * @param {ManifestEntry[]} entries 清单条目
 * @returns {string} lock 全文（以换行结尾）
 */
export function buildLockText(rootDir, entries) {
  const files = expandManifest(rootDir, entries)
  const body = files
    .map((f) => `${sha256Of(readFileSync(join(rootDir, f.repoPath)))} ${f.repoPath} ${f.landing} ${f.mode}`)
    .join('\n')
  const rest = `${body}\n`
  return `${LOCK_HEADER_KEY} ${sha256Of(rest)}\n${rest}`
}

/**
 * 解析 lock 文本（守卫与同步程序共用的格式唯一事实源）。
 * 不校验 sha256 是否与仓内内容一致——那是守卫的判据，不是格式问题。
 * @param {string} text lock 全文
 * @returns {{ self: string, files: LockedFile[] }} 首行自校验值 + 逐文件行
 */
export function parseLock(text) {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const parts = first.trim().split(/\s+/)
  if (parts.length !== 2 || parts[0] !== LOCK_HEADER_KEY) {
    throw new Error(`${LOCK_PATH}:1: 首行须为 \`${LOCK_HEADER_KEY} <sha256>\`，实得 ${JSON.stringify(first)}`)
  }
  const self = parts[1] ?? ''
  /** @type {LockedFile[]} */
  const files = []
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw === undefined) continue
    const line = raw.trim()
    if (line === '') continue
    const cols = line.split(/\s+/)
    if (cols.length !== 4) {
      throw new Error(`${LOCK_PATH}:${i + 1}: 期望四列（sha256 仓内路径 落地路径 模式），实得 ${cols.length} 列`)
    }
    const [sha256, repoPath, landing, mode] = /** @type {[string, string, string, string]} */ (cols)
    files.push({ sha256, repoPath, landing, mode })
  }
  return { self, files }
}

/**
 * lock 首行自校验值应对应的字符串 = 首行之后的**全部字节**。
 * @param {string} text lock 全文
 * @returns {string} 应被 sha256 的那段
 */
export function lockRest(text) {
  const idx = text.indexOf('\n')
  return idx === -1 ? '' : text.slice(idx + 1)
}

/** @returns {string} 仓根绝对路径（由脚本自身位置推出：scripts/lemeng/ → ../../）。 */
function defaultRootDir() {
  return fileURLToPath(new URL('../../', import.meta.url))
}

/** 生成并写入 lock；打印一行摘要。 @returns {void} */
function main() {
  const rootDir = process.argv[2] ?? defaultRootDir()
  const entries = parseManifest(readFileSync(join(rootDir, MANIFEST_PATH), 'utf8'))
  const text = buildLockText(rootDir, entries)
  writeFileSync(join(rootDir, LOCK_PATH), text)
  const { files } = parseLock(text)
  console.log(`${SCRIPT_NAME}: 写入 ${LOCK_PATH}（${entries.length} 条清单条目 → ${files.length} 个文件）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
