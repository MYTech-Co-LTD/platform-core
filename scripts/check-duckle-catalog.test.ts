// scripts/check-duckle-catalog.test.ts — 观测面命名门禁（issue #337）的 fixtures 测试。
//
// **黑盒**：spawn 守卫 CLI、断言退出码与输出行（与 check-data-plane-lock.test.ts 同形）。
//
// ── 为什么要有一个「引擎替身」而不是直接跑真 duckle ──────────────────────────────
// 单元测试**不能**假设 CI 里那步 `pip install duckle` 已经发生（unit job 里没有 Python 依赖；
// 而且把 100MB 引擎装进 unit job 只为跑这个测试，代价与收益不成比例）。
// 但「守卫会不会红」这件事又必须被钉住 —— **不能红的守卫等于没有**，而它最容易被无声破坏的
// 地方正是**输出解析**（文案判据串被人改松、缩进行摘取失效 ⇒ 守卫恒绿、谁都不知道）。
//
// ⇒ 用**契约替身**：替身只认守卫真正会用的 argv 形状，吐出的每一行都是
// **真机逐字拷贝**，退出码也与真机一致。真机的抓取方式（duckle==0.7.4，2026-09-29）：
//
//   cd /tmp && python3.12 -m venv v && ./v/bin/pip install "duckle==0.7.4"
//   # 工作区 = deploy/duckle/console 的 pipelines/ + owners.<源系统>.json 合并进临时目录
//   ./v/bin/duckle catalog build --workspace <ws>   # 纯绿：exit 0 / 有缺陷：stderr 点名节点、**exit 仍 0**
//   ./v/bin/duckle catalog lint  --workspace <ws>   # 纯绿：exit 0 / 有缺陷：stdout 列 findings、exit 1
//
// 替身按「工作区里有没有缺 `bucket` 的管线文件」选吐哪一套 —— 与真机的因果链同向
// （sink 缺 `bucket` ⇒ 命名不了 ⇒ 规则匹配不到资产），但**不假装是引擎**：它不解析管线 JSON 的
// 语义，只是把「缺陷 → 真机输出」这段映射搬过来。**真机的判定仍由 CI 那步真跑负责**，
// 本测试锁的是「守卫拿到这套输出后，红/绿与文案对不对」。
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const GUARD = join(repoRoot, 'scripts/check-duckle-catalog.mjs')
const CONSOLE_DIR = join(repoRoot, 'deploy/duckle/console')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

/** @param {string} prefix */
function tmpdirFor(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(root)
  return root
}

/** 跑守卫（纯 ESM，node 入口与 `tsx <x>.mjs` 同）。 @returns {RunResult} */
function runGuard(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

// ── 真机输出逐字拷贝（只把「管线文件数」参数化了，其余一字未改）────────────────────
const N_GREEN_BUILD = "12 pipelines, 20 assets, 201 links.\nWritten to ${WS}/.duckle/catalog.json\n"
const N_GREEN_LINT = "17 asset(s) have no owner (not a failure; use --strict to make it one)\ncatalog lint: nothing to report.\n"

const N_RED_BUILD_STDERR =
  "\n2 source/sink node(s) could not be named, so the answers above may be incomplete:\n" +
  '  lemeng.retail_order_line.tick / sink (snk.minio)\n' +
  '  lemeng.retail_order_line.window / sink (snk.minio)\n'
const N_RED_BUILD_STDOUT = "12 pipelines, 19 assets, 199 links.\nWritten to ${WS}/.duckle/catalog.json\n"
const N_RED_LINT =
  "owners.json: asset rule 'minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet' (data-eng) matches nothing in this workspace\n" +
  '2 source/sink node(s) could not be named, so impact answers are incomplete\n' +
  '17 asset(s) have no owner (not a failure; use --strict to make it one)\n\n' +
  'catalog lint: 2 finding(s).\n'
// 第二类缺陷：**节点全都命名正常**，但 owners.json 里有一条规则拼错了（`bizdy` 少了个 a）
// ⇒ 只有「死规则」这一类 finding。真机逐字（同一台 lab，2026-09-29）。
const N_TYPO_LINT =
  "owners.json: asset rule 'minio://*/lemeng/retail_order_line/system_book=*/bizdy=*/hour=*/all.parquet' (data-eng) matches nothing in this workspace\n" +
  '17 asset(s) have no owner (not a failure; use --strict to make it one)\n\n' +
  'catalog lint: 1 finding(s).\n'

/**
 * 写一个 duckle 契约替身（可执行 node 脚本）并返回其路径。
 * 判据：工作区 pipelines/ 下**任一** *.json 不含 `"bucket"` ⇒ 吐「有缺陷」那套（对应真机形态）。
 */
let stubPath = ''
beforeAll(() => {
  const dir = tmpdirFor('duckle-guard-stub-')
  stubPath = join(dir, 'duckle')
  // 所有内嵌字面量一律过 JSON.stringify —— 转录文本里有 `${ENV:...}`、单引号与换行，
  // 手写转义迟早出错，而转义错误会**静默**产出另一个字符串。
  const q = JSON.stringify
  const src = [
    '#!/usr/bin/env node',
    '// duckle 契约替身（测试夹具，非引擎；真机输出逐字拷贝，见测试文件头注）',
    "import { readdirSync, readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const a = process.argv.slice(2)',
    "const die = (m) => { console.error('stub: ' + m); process.exit(90) }",
    "if (a.length !== 4) die('argv 形状不对: ' + JSON.stringify(a))",
    "if (a[0] !== 'catalog') die('第 1 个参数必须是 catalog: ' + JSON.stringify(a))",
    "if (a[1] !== 'build' && a[1] !== 'lint') die('不支持的子命令: ' + a[1])",
    "if (a[2] !== '--workspace') die('第 3 个参数必须是 --workspace: ' + JSON.stringify(a))",
    'const ws = a[3]',
    'let files = []',
    "try { files = readdirSync(join(ws, 'pipelines')).filter((f) => f.endsWith('.json')) } catch { die('工作区没有 pipelines/: ' + ws) }",
    "if (files.length === 0) die('工作区 pipelines/ 是空的: ' + ws)",
    // 替身**只建模这两条规则**（本门禁存在的理由就是这两条）：
    //   ① `snk.minio` 节点的 properties 少了 `bucket` ⇒ 命名不了；
    //   ② owners.json 里有一条 match 拼错了（判据串是那处真机的错拼 `bizdy`）⇒ 死规则。
    // ① 按**节点**判而不是按文件判 —— 一个文件里可能既有带 bucket 的 sink、也有不带的
    // （真机 `lemeng.dim.branch.l0.json` 就是 snk.minio 出现 2 次），按文件判会漏。
    'const unnamedDefect = files.some((f) => {',
    "  const doc = JSON.parse(readFileSync(join(ws, 'pipelines', f), 'utf8'))",
    '  return (doc.nodes || []).some((n) => {',
    '    const d = n.data || {}',
    "    return d.componentId === 'snk.minio' && (d.properties || {}).bucket === undefined",
    '  })',
    '})',
    `const TYPO_MARKER = ${q('bizdy')}`,
    "const deadRule = readFileSync(join(ws, 'owners.json'), 'utf8').includes(TYPO_MARKER)",
    `const GREEN_BUILD = ${q(N_GREEN_BUILD)}`,
    `const GREEN_LINT = ${q(N_GREEN_LINT)}`,
    `const RED_BUILD_STDERR = ${q(N_RED_BUILD_STDERR)}`,
    `const RED_BUILD_STDOUT = ${q(N_RED_BUILD_STDOUT)}`,
    `const RED_LINT = ${q(N_RED_LINT)}`,
    `const TYPO_LINT = ${q(N_TYPO_LINT)}`,
    "const sub = a[1]",
    "if (sub === 'build') {",
    `  const out = (unnamedDefect ? RED_BUILD_STDOUT : GREEN_BUILD).split(${q('${WS}')}).join(ws)`,
    '  process.stdout.write(out)',
    '  if (unnamedDefect) process.stderr.write(RED_BUILD_STDERR)   // 真机：警告走 stderr、**退出码仍是 0**',
    '  process.exit(0)',
    '}',
    'if (unnamedDefect) { process.stdout.write(RED_LINT); process.exit(1) }',
    'if (deadRule) { process.stdout.write(TYPO_LINT); process.exit(1) }',
    'process.stdout.write(GREEN_LINT)',
    'process.exit(0)',
  ].join('\n')
  writeFileSync(stubPath, src)
  chmodSync(stubPath, 0o755)
})

/** 建一个最小工作区夹具（只 pipelines/ + owners.<源系统>.json，与守卫合并前的源形状一致）。 */
function workspace(opts: { owners?: boolean; bucket: boolean }): string {
  const root = tmpdirFor('duckle-guard-ws-')
  mkdirSync(join(root, 'pipelines'), { recursive: true })
  const sink = opts.bucket
    ? '{"connectionRef":"zos","bucket":"${ENV:ZOS_BUCKET}","key":"lemeng/x/all.parquet"}'
    : '{"connectionRef":"zos","key":"lemeng/x/all.parquet"}'
  writeFileSync(
    join(root, 'pipelines/lemeng.a.json'),
    JSON.stringify({ name: 'lemeng.a', nodes: [{ id: 'sink', data: { componentId: 'snk.minio', properties: JSON.parse(sink) } }], edges: [] }),
  )
  if (opts.owners !== false) {
    writeFileSync(join(root, 'owners.lemeng.json'), JSON.stringify({ assets: [{ match: 'minio://*/lemeng/x/all.parquet', owner: 'data-eng' }] }))
  }
  return root
}

/** 同上，但 owners 规则是拼错的（真机那处 `bizdy`）——节点命名正常，只有「死规则」这一类。 */
function workspaceWithTypo(): string {
  const root = workspace({ bucket: true })
  writeFileSync(
    join(root, 'owners.lemeng.json'),
    JSON.stringify({ assets: [{ match: 'minio://*/lemeng/x/bizdy=*/all.parquet', owner: 'data-eng' }] }),
  )
  return root
}

describe('check-duckle-catalog', () => {
  // 真仓 + 健康引擎 ⇒ 必须绿。防的是「机制落码了，但真实仓一跑就红」（反之亦然：
  // 这条也顺带钉住「今天 main 上的 console 工作区是干净的」）。
  it('真实仓干净 → exit 0 且打印 OK', () => {
    const r = runGuard([CONSOLE_DIR, '--duckle', stubPath])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-duckle-catalog: OK')
  })

  // **本任务的核心验收面**：有缺陷就必须红，且点名到「哪个管线」，不能只给退出码。
  it('sink 缺 bucket → exit 1 且点名管线与死规则', () => {
    const r = runGuard([workspace({ bucket: false }), '--duckle', stubPath])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lemeng.retail_order_line.tick / sink (snk.minio)')
    expect(r.stderr).toContain('lemeng.retail_order_line.window / sink (snk.minio)')
    expect(r.stderr).toContain('matches nothing in this workspace')
    expect(r.stderr).toContain('怎么修')
  })

  it('绿工作区（sink 带 bucket）→ exit 0', () => {
    const r = runGuard([workspace({ bucket: true }), '--duckle', stubPath])
    expect(r.status).toBe(0)
  })

  // 第二类：**节点全都命名正常**，但 owners 规则拼错了。这类在 #334 里不是主角，
  // 却是最阴的一类 —— 一个字母之差 = 某个团队**永远收不到告警**，且节点侧毫无异常。
  // 断言里带上「怎么修指向 owners.json」：报错把人指向错的文件，等于没报错。
  it('owners 规则拼错（节点都正常）→ exit 1 且修法指向 owners.json', () => {
    const r = runGuard([workspaceWithTypo(), '--duckle', stubPath])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('bizdy')
    expect(r.stderr).toContain('改 owners.json')
    expect(r.stderr).not.toContain('给上面那些 sink 节点补')   // 不许给出指向管线的误导修法
  })

  // 前置不满足时**响亮失败**，绝不静默跳过：跳过的守卫与绿掉的守卫在 CI 里长得一模一样，
  // 「门禁跑了但什么都没判」正是 issue #337 要根治的那类不可见。
  it('引擎不在 → exit 2（不是通过）', () => {
    const r = runGuard([CONSOLE_DIR, '--duckle', join(tmpdir(), 'duckle-does-not-exist-337')])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('找不到 duckle')
  })

  it('源目录缺 owners.<源系统>.json → exit 2（不许静默降级成「只判命名」）', () => {
    const r = runGuard([workspace({ owners: false, bucket: true }), '--duckle', stubPath])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('owners.<源系统>.json')
  })
})

// 顺带钉住替身本身：万一有人把替身的 argv 断言改松，上面那组测试就会「绿在一个假替身上」。
it('契约替身：argv 形状不对时退出 90（守住上组测试的前提）', () => {
  let status = 0
  try {
    execFileSync(stubPath, ['catalog', 'build'], { stdio: 'ignore' })
  } catch (err) {
    status = (err as { status?: number }).status ?? -1
  }
  expect(status).toBe(90)
})
