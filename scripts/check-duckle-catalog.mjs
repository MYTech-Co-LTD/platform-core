#!/usr/bin/env node
// 观测面命名门禁（issue #337；缺陷案例 #334）。
//
// 用法：pnpm exec tsx scripts/check-duckle-catalog.mjs [源目录] [--duckle <bin>] [--keep]
//   源目录默认 = <仓库根>/deploy/duckle/console（观测面工作区：pipelines/ 与 owners.<源系统>.json 同址）。
//   --duckle 覆盖引擎路径（默认 `duckle`，即 PATH 上的 PyPI 入口；CI 里由 pip 装出来）。
//   --keep 保留临时工作区（排障用；平时用完即删）。
//
// 契约：干净 → exit 0，stdout 一行 `check-duckle-catalog: OK（…）`；
//       发现观测面命名缺陷 → exit 1，stderr 说明「哪个管线/哪条规则」；
//       **跑不起来**（duckle 不在 / 工作区缺文件）→ exit 2 响亮失败，绝不静默跳过。
//
// ── 为什么要有这条门禁（issue #337 的成因）─────────────────────────────────────
// #334 的缺陷形态：两条 retail 子管线的 `snk.minio` 少了 `bucket`（该字段 schema 里
// `required: true`）⇒ **采集照写不误**（`connectionRef` 里带 bucket，引擎合并连接字段后
// 照常落湖），但 **catalog 无法给这两个 sink 节点命名** ⇒ `owners.json` 的零售新鲜度锚
// （36h 陈旧告警）**匹配不到任何资产 = 死规则，且不报错**。
//
// 该缺陷在当时的 CI 里**完全不可见**：六条静态守卫全绿、`pnpm test` 全绿，两个已合并的 PR
// （#325 / #331）带着它过关 —— 它是 Wave C 的 worker 做**无关任务**时手工跑 `catalog lint`
// 才发现的。本门禁就是把那次手工动作机检化：**「能写 ≠ 能被观测面命名」，这一层必须有人守**。
//
// ── 判据（两条，各自独立）─────────────────────────────────────────────────────
//   ① `catalog build` 的 **stderr 不得**出现 `could not be named`
//      —— 引擎对「命名不了」只警告、**exit 仍是 0**（实测 0.7.4），所以只判退出码会漏；
//      且 stderr 里**点名了**哪个管线哪个节点，是排障的第一手材料。
//   ② `catalog lint` **exit 0**
//      —— lint 把两类问题都算 finding：命不了的节点，以及 owners.json 里**匹配不到任何
//      资产的规则**（`matches nothing in this workspace`，正是 #334 的死规则本体）。
//      ⇒ ①是更早、更具体的信号，②是**退出码层面的兜底**：即使哪天引擎改了 ① 的文案，
//      ② 仍会红。两条都判，缺一不可。
//
// **不加 `--strict`**：`--strict` 会把「无主资产」也算失败，而本工作区里 17/20 个资产是
// 运行记录 csv（`/workspace/logs/*.csv`）与外部 API URL，本就无主 —— 加了等于无条件红。
// #334 那一类（**声明了规则却匹配不到资产**）在**不加 strict 时就已经是失败**，无需 strict。
//
// ── 工作区怎么来：最小构造，**不需要任何凭据** ─────────────────────────────────
// 只要 `pipelines/` + `owners.<源系统>.json` 两样，**不要** connections/、keys/、secrets.env。
// 这一点是实测的（2026-09-29，duckle==0.7.4）：
//   · 同一份 pipelines 下，加/不加 `connections/zos.json`（带 bucket + 假凭据），
//     `catalog build` 的资产数、命名结果、`catalog lint` 的退出码**逐字相同** ⇒
//     **catalog 命名只读节点自身的属性（如 sink 的 `bucket`），不读连接值**。
//   · 所以「桶里那点真凭据」在本门禁里既不需要、也不该进来（凭据不进仓）。
//
// ⚠️ **覆盖边界（照实记，别读宽）**：
//   · 扫的是 `deploy/duckle/console/`（**观测面工作区**：管线 + owners.<源系统>.json 同址的那个）。
//     2026-10-05 起 owners 按源系统分文件（#419）：工作区里仍合并成一份 `owners.json`（引擎只认这个名）。
//     仓根 `duckle/common/*.json` 是**另一处**管线定义（不叫 `pipelines/`、也没有 owners 规则文件）
//     ⇒ **不在本门禁扫描面内**。
//   · `alerts.json` **不参与** `catalog lint`（实测：把它放进工作区，lint 输出与退出码**不变**）
//     ⇒ 告警规则的「匹配不到任何东西」这类死规则**本门禁看不见**，属已知空缺。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 引擎 stderr 里「命名不了」的判据串（0.7.4 实测：`N source/sink node(s) could not be named…`）。 */
const UNNAMED_RE = /could not be named/
/** lint 里「owners 规则匹配不到资产」的判据串（#334 的死规则本体）。 */
const DEAD_RULE_RE = /matches nothing in this workspace/

/** 退出码：1 = 发现缺陷（守卫判红）；2 = 环境/前置不满足（**跑不起来，不是通过**）。 */
const EXIT_FINDINGS = 1
const EXIT_PRECONDITION = 2

/** @param {string} msg */
function failPrecondition(msg) {
  console.error(`check-duckle-catalog: 跑不起来 —— ${msg}`)
  process.exit(EXIT_PRECONDITION)
}

/**
 * 解析 argv：[源目录] [--duckle <bin>] [--keep]
 * @param {string[]} argv
 * @returns {{ srcDir: string, duckleBin: string, keep: boolean }}
 */
function parseArgs(argv) {
  let srcDir = join(repoRoot, 'deploy/duckle/console')
  let duckleBin = process.env.DUCKLE_BIN || 'duckle'
  let keep = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--duckle') {
      i += 1
      if (!argv[i]) failPrecondition('--duckle 需要一个参数（引擎可执行文件路径）')
      duckleBin = argv[i]
    } else if (a === '--keep') {
      keep = true
    } else if (a.startsWith('--')) {
      failPrecondition(`不认识的参数 ${a}`)
    } else {
      srcDir = resolve(a)
    }
  }
  return { srcDir, duckleBin, keep }
}

/**
 * 跑一条 catalog 子命令。**stdout / stderr 分开留**：判据①读 stderr，判据②读退出码，
 * 排障既要 lint 的 stdout（findings 全在 stdout，实测）也要 build 的 stderr。
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string, missing: boolean }}
 */
function runDuckle(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  // ENOENT（引擎不在 PATH）不算「判红」——是**跑不起来**，由调用方转 exit 2 响亮失败
  const missing = /** @type {any} */ (r.error || {}).code === 'ENOENT'
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', missing }
}

/** @param {string} text @returns {string[]} 非空行 */
function lines(text) {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
}

/** @param {string} text @returns {string[]} stderr 里被点名的节点行（缩进那几行） */
function unnamedNodeLines(text) {
  return lines(text).filter((l) => /^\s+\S/.test(l) && l.includes('/'))
}

/** @param {string} text @returns {string[]} lint 里「匹配不到资产」的规则行 */
function deadRuleLines(text) {
  return lines(text).filter((l) => DEAD_RULE_RE.test(l))
}

const { srcDir, duckleBin, keep } = parseArgs(process.argv.slice(2))

// ── 前置①：源工作区形状（少了任何一个，本门禁都会**变成空转**——宁可响亮失败）────────
const srcPipelines = join(srcDir, 'pipelines')
if (!existsSync(srcPipelines) || !statSync(srcPipelines).isDirectory()) {
  failPrecondition(`源目录里没有 pipelines/ 目录：${srcPipelines}`)
}
// owners 按**源系统**分文件（`owners.<源系统>.json`）：规则里的路径前缀是源系统特有的。
// 一个都没有 ⇒ 响亮失败，**不许降级**成「只判命名」——那正是本门禁要防的空转。
const srcOwnersFiles = readdirSync(srcDir)
  .filter((f) => /^owners\.[^./]+\.json$/.test(f))
  .sort()
if (srcOwnersFiles.length === 0) {
  failPrecondition(
    `源目录里没有 owners.<源系统>.json：${srcDir}（没有它，owners 死规则这一类判据无从谈起；` +
      `owners 按源系统分文件，进工作区时合并为 owners.json）`,
  )
}
const pipelineFiles = readdirSync(srcPipelines).filter((f) => f.endsWith('.json'))
if (pipelineFiles.length === 0) {
  failPrecondition(`pipelines/ 里一个 *.json 都没有：${srcPipelines}（扫空集不算通过）`)
}

// ── 前置②：引擎在不在（缺引擎 = 跑不起来，不是通过）──────────────────────────────
const probe = runDuckle(duckleBin, ['catalog', '--help'])
if (probe.missing) {
  failPrecondition(
    `找不到 duckle（${duckleBin}）。本门禁要真引擎，装法与版本见 deploy/duckle/Dockerfile 的 DUCKLE_VERSION：\n` +
      `    pip install "duckle==<DUCKLE_VERSION>"        # 版本与运行镜像同源，别各写各的`,
  )
}

// ── 构造最小工作区（**在临时目录**：catalog build 会往工作区写 `.duckle/catalog.json`，
//    直接在仓里跑会留下未跟踪产物）────────────────────────────────────────────────
const ws = mkdtempSync(join(tmpdir(), 'duckle-catalog-guard-'))
const cleanup = () => {
  if (!keep) rmSync(ws, { recursive: true, force: true })
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

cpSync(srcPipelines, join(ws, 'pipelines'), { recursive: true })
// 合并各源系统的 owners：assets 取**并集**。同一 match 出现两条规则 ⇒ 响亮失败——
// 谁生效不该由文件名的排序决定，那会让死规则（或真规则）静默消失。
const mergedAssets = []
const matchOwner = new Map()
for (const f of srcOwnersFiles) {
  const doc = JSON.parse(readFileSync(join(srcDir, f), 'utf8'))
  for (const a of Array.isArray(doc.assets) ? doc.assets : []) {
    const key = typeof a?.match === 'string' ? a.match : JSON.stringify(a)
    if (matchOwner.has(key)) {
      failPrecondition(
        `owners 规则重复：${key}\n     同时出现在 ${matchOwner.get(key)} 与 ${f} —— 合并后谁生效不该由文件名决定`,
      )
    }
    matchOwner.set(key, f)
    mergedAssets.push(a)
  }
}
writeFileSync(
  join(ws, 'owners.json'),
  JSON.stringify({ _note: [`由 check-duckle-catalog 合并：${srcOwnersFiles.join('、')}`], assets: mergedAssets }, null, 2),
)

// ── 判据①：catalog build —— 退出码 0 + stderr 不得出现 "could not be named" ──────────
const build = runDuckle(duckleBin, ['catalog', 'build', '--workspace', ws])
const buildSummary = lines(build.stdout)[0] || '(build 没有输出摘要行)'

if (build.status !== 0) {
  console.error('check-duckle-catalog: catalog build 自己失败了（不是命名缺陷，是引擎/工作区出错）')
  console.error(`  退出码 ${build.status}`)
  for (const l of lines(build.stderr)) console.error(`  · ${l}`)
  for (const l of lines(build.stdout)) console.error(`  · ${l}`)
  process.exit(EXIT_PRECONDITION)
}

// 引擎对「命名不了」只警告、**退出码仍是 0** ⇒ 判据①的唯一落点是这条 stderr 文案。
// 节点清单**只在命中判据串时**才摘（否则会把引擎的其它缩进行误读成「命不了的节点」）。
const buildSaysUnnamed = UNNAMED_RE.test(build.stderr)
const unnamed = buildSaysUnnamed ? unnamedNodeLines(build.stderr) : []

// ── 判据②：catalog lint —— exit 0（findings 走 stdout，故失败时把 stdout 原样带出来）──
const lint = runDuckle(duckleBin, ['catalog', 'lint', '--workspace', ws])
const deadRules = deadRuleLines(lint.stdout)

if (!buildSaysUnnamed && lint.status === 0) {
  console.log(
    `check-duckle-catalog: OK（${buildSummary}；${pipelineFiles.length} 个管线文件；catalog lint 无 finding）`,
  )
  process.exit(0)
}

// ── 判红：把「哪个管线 / 哪条规则」直接摆出来，别让人再去翻引擎输出 ────────────────
// 两类 finding 的**修法不同**（一类改管线、一类改 owners.json）⇒ 提示必须分类给，
// 不然「怎么修」会把人指向错的文件（实测：owners 规则打错时，笼统的 bucket 提示是误导）。
console.error('check-duckle-catalog: 观测面缺陷（**写入/采集照常**，坏的是「观测面」这一层）')
console.error('')
if (buildSaysUnnamed) {
  console.error('① catalog 命不了这些节点（sink 的 `bucket` 是 required 却没写？）：')
  for (const l of unnamed) console.error(`     ${l.trim()}`)
  if (unnamed.length === 0) console.error('     （引擎报了 “could not be named”，但没点名节点）')
  console.error('')
}
if (deadRules.length > 0) {
  console.error('② owners.json 里这些规则**匹配不到任何资产**（= 死规则，告警永远不会响）：')
  for (const l of deadRules) console.error(`     ${l}`)
  console.error('')
}
if (lint.status !== 0) {
  console.error(`catalog lint 退出码 ${lint.status}，findings 如下：`)
  for (const l of lines(lint.stdout)) console.error(`     ${l}`)
  console.error('')
}
if (buildSaysUnnamed && deadRules.length === 0) {
  console.error('提示：命不了的节点如果本就没有 owners 规则覆盖，就不会出现第 ② 类 finding ——')
  console.error('     但那仍是缺陷（该资产在 catalog 里根本不存在，impact/新鲜度都算不到它）。')
  console.error('')
}
console.error('怎么修：')
if (buildSaysUnnamed) {
  console.error('  · ① 给上面那些 sink 节点补 `"bucket"`（schema 里 required；值用 `${ENV:ZOS_BUCKET}`')
  console.error('    这类模板 —— 占位符**不展开**、catalog 照原样命名，owners 规则里的 `*` 能吸收）。')
}
if (deadRules.length > 0) {
  console.error('  · ② 改 owners.json 里那条规则的 `match` 模式：要么是**拼错/写窄了**（对齐上面命名出来的')
  console.error('    资产 id 逐字改），要么是它该覆盖的资产**根本没被命名**（那就是 ①，先修 ① 再看）。')
}
if (!buildSaysUnnamed && deadRules.length === 0) {
  // 兜底：lint 红在这两类之外（例如 match 模式编译不了）。**不许留一个没有任何修法的报错**
  // —— 只报「红了」而不说怎么修，等于把排障成本原样丢回给读日志的人。
  console.error('  · 上面 lint 的 findings 原文即线索（未归入命名失败 / 死规则这两类，')
  console.error('    常见于 owners 规则的 match 模式本身编译不了）。')
}
process.exit(EXIT_FINDINGS)
