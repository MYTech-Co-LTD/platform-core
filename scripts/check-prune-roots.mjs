// scripts/check-prune-roots.mjs — #683 清点/清理**作用域**与清单的一致性门禁。
//
// ## 它防的是什么
//
// `scripts/lemeng/sync-data-plane.sh` 的 `--prune` 只删「落在作用域内」的孤儿，作用域写死成
// 脚本里那行 `PRUNE_ROOTS='…'`，取值 = `deploy/data-plane-manifest.txt` 里**目录型条目**
// （源路径以 `/` 结尾）在检出内的落地前缀。**两处漂移就是本机制要治的病本身**：
//
//   - manifest 新增一条目录条目（比如将来多一个 `warehouse/`），脚本那行没跟 ⇒ 该目录树里的
//     孤儿**静默漏清**，正是 #683 实证的那个形态（`x01_branch_region.csv` 退役后在检出里永生、
//     被 dbt 每天当僵尸 seed 加载）；
//   - 反过来，脚本里多写一个 manifest 已不覆盖的根 ⇒ 作用域**超出**清单授权，prune 可能删掉
//     清单根本没登记的东西。
//
// 两个方向都不会自己叫——没有这条守卫时，唯一的发现途径是几个月后再被僵尸文件咬一次。所以
// 这里做**机械比对**，不靠人记。
//
// ## 为什么作用域要「收窄到目录型条目」而不是整个检出
//
// 见 `sync-data-plane.sh` 头注「清点/清理的作用域」节与设计文档 ①：真机 `--check` 实测，全检出
// 作用域报 394 个多余件，其中只有 10 个是本设计要治的孤儿，另 384 个是「整仓 tarball 引导残留」
// （数据面机的检出按设计就是「整仓解包 + manifest 覆盖」）。整仓判死 = 拿 384 个设计外文件赌命。
//
// 用法：`pnpm exec tsx scripts/check-prune-roots.mjs [rootDir]`（rootDir 默认仓根，测试用）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MANIFEST_PATH, REPO_PLACEHOLDER, parseManifest } from './lemeng/data-plane-lock.mjs'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-prune-roots'
/** 声明 `PRUNE_ROOTS` 的那个脚本（相对仓根）。 */
export const SYNC_SCRIPT_PATH = 'scripts/lemeng/sync-data-plane.sh'
/** 变量名——失败信息里要复述它，人才能一眼找到要改的那一行。 */
export const PRUNE_ROOTS_VAR = 'PRUNE_ROOTS'
/**
 * 声明行的形状。**锚定行首行尾**：脚本里还有注释与 `for _r in $PRUNE_ROOTS` 提到这个名字，
 * 只有赋值行能匹配；匹配不到即「声明行不见了」——那是改名/重写，必须叫（见 `declaredPruneRoots`）。
 */
const PRUNE_ROOTS_RE = /^PRUNE_ROOTS='([^']*)'\s*$/

/**
 * 清单授权的清点作用域根（相对检出，形如 `duckle/`）。
 *
 * 取**目录型条目**（`isDir`）且**落地在检出内**（落地路径以 `${REPO}/` 开头）的那些，剥掉
 * `${REPO}/` 前缀。落地在检出外的目录条目（如将来的 `/opt/…`）不进作用域——prune 从不越出
 * 检出，把它算进来会要求脚本声明一个它永远不会遍历的根。
 * @param {import('./lemeng/data-plane-lock.mjs').ManifestEntry[]} entries 清单条目
 * @returns {string[]} 作用域根（字典序，去重）
 */
export function manifestPruneRoots(entries) {
  const out = new Set()
  for (const e of entries) {
    if (!e.isDir) continue
    if (!e.landing.startsWith(`${REPO_PLACEHOLDER}/`)) continue
    out.add(e.landing.slice(REPO_PLACEHOLDER.length + 1))
  }
  return [...out].sort()
}

/**
 * 从脚本正文里剥出声明的 `PRUNE_ROOTS`。
 *
 * `found: false`（找不到声明行）与 `roots: []`（声明了空表）是**两件事**，调用方要分开报：
 * 前者多半是变量被改名/那行被重写，后者是「作用域被清空」——两种都得叫，但给人的下一步不同。
 * @param {string} text 脚本正文
 * @returns {{ found: boolean, roots: string[] }} 声明情况
 */
export function declaredPruneRoots(text) {
  for (const line of text.split('\n')) {
    const m = PRUNE_ROOTS_RE.exec(line)
    if (m === null) continue
    const value = m[1] ?? ''
    return { found: true, roots: value.split(/\s+/).filter((s) => s !== '').sort() }
  }
  return { found: false, roots: [] }
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
    return [{ file: MANIFEST_PATH, message: '清单不存在——作用域的唯一事实源就是它' }]
  }
  /** @type {import('./lemeng/data-plane-lock.mjs').ManifestEntry[]} */
  let entries
  try {
    entries = parseManifest(readFileSync(manifestAbs, 'utf8'))
  } catch (err) {
    return [{ file: MANIFEST_PATH, message: err instanceof Error ? err.message : String(err) }]
  }

  const scriptAbs = join(rootDir, SYNC_SCRIPT_PATH)
  if (!existsSync(scriptAbs)) {
    return [{ file: SYNC_SCRIPT_PATH, message: '清点/清理脚本不存在——它声明了清点作用域' }]
  }
  const declared = declaredPruneRoots(readFileSync(scriptAbs, 'utf8'))
  if (!declared.found) {
    return [
      {
        file: SYNC_SCRIPT_PATH,
        message:
          `找不到 ${PRUNE_ROOTS_VAR}='…' 声明行（形状：行首 ${PRUNE_ROOTS_VAR}='<根> <根> …'）` +
          ' ⇒ 变量被改名或那行被重写；本守卫比的就是它，找不到就没法判。',
      },
    ]
  }

  const want = manifestPruneRoots(entries)
  const got = declared.roots
  const gotSet = new Set(got)
  const wantSet = new Set(want)

  // 方向一：清单授权了、脚本没声明 ⇒ 该目录树里的孤儿静默漏清（#683 的病本身）
  for (const root of want) {
    if (gotSet.has(root)) continue
    violations.push({
      file: SYNC_SCRIPT_PATH,
      message:
        `${MANIFEST_PATH} 的目录型条目授权了作用域根 '${root}'，但 ${PRUNE_ROOTS_VAR} 里没有` +
        ` ⇒ 该目录树里的孤儿**静默漏清**（正是 #683 要治的病）。把它加进 ${PRUNE_ROOTS_VAR}。`,
    })
  }

  // 方向二：脚本声明了、清单不授权 ⇒ 作用域超出清单，prune 可能删掉清单没登记的东西
  for (const root of got) {
    if (wantSet.has(root)) continue
    violations.push({
      file: SYNC_SCRIPT_PATH,
      message:
        `${PRUNE_ROOTS_VAR} 里的 '${root}' 不对应 ${MANIFEST_PATH} 的任何目录型条目` +
        ' ⇒ 清点作用域**超出清单授权**（prune 会删清单没登记的件）。删掉它，或先让清单登记那个目录。',
    })
  }

  // 方向三：目录条目正好落在检出根（`${REPO}/`）⇒ 作用域退化成「全检出」，与 #683 的收窄决定冲突。
  // 真出现时多半是清单写歪了（比如把某个目录条目的落地路径写成 `${REPO}/`），必须叫——它会让
  // prune 回到「拿 384 个设计外文件赌命」的初版形态。
  for (const e of entries) {
    if (!e.isDir) continue
    if (e.landing !== `${REPO_PLACEHOLDER}/`) continue
    violations.push({
      file: MANIFEST_PATH,
      message:
        `目录条目 '${e.repoPath}' 的落地路径是检出根本身（${REPO_PLACEHOLDER}/）` +
        ' ⇒ 清点作用域退化成「整个检出」，与 #683 收窄到目录型条目的决定冲突（真机 384 个引导残留会被删）。' +
        ' 核对这条落地路径是不是写歪了。',
    })
  }

  return violations.sort((a, b) => (a.file === b.file ? a.message.localeCompare(b.message) : a.file.localeCompare(b.file)))
}

/** CLI 入口。 @returns {void} */
function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
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
