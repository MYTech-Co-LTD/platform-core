// scripts/check-prune-roots.test.ts — #683 清点作用域门禁的 fixtures 测试。
//
// **全部黑盒**：spawn CLI、断言退出码与输出行（与 check-data-plane-lock.test.ts 同风格）。夹具落在
// 系统临时目录，与真实仓库完全隔离；最后一组反过来钉住「真实仓库必须干净」（exit 0）——防的是
// 「守卫落码了、`PRUNE_ROOTS` 那行却没跟上清单」，那正是本守卫要治的漂移。
//
// 夹具**不需要是 git 仓库**：本守卫只读清单文本与脚本文本（生成器 `data-plane-lock.mjs` 才要
// `git ls-files`），所以这里比 check-data-plane-lock.test.ts 的夹具轻。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const GUARD = join(repoRoot, 'scripts/check-prune-roots.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []

/** 建一个临时夹具（files: 相对路径 → 内容）；用完在 afterAll 统一删除。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-pruneroots-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** 跑守卫（纯 ESM，node 入口与 `tsx <x>.mjs` 同）。 */
function guard(root: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 清单文本：三列，空白分隔（形状与真清单一致）。 */
function manifest(lines: string[]): string {
  return ['# 夹具清单', ...lines, ''].join('\n')
}

/** 脚本文本：只放守卫要看的那一行（其余内容与它无关）。 */
function script(pruneRoots: string): string {
  return ['#!/bin/sh', `PRUNE_ROOTS='${pruneRoots}'`, 'echo hi', ''].join('\n')
}

const MANIFEST_PATH = 'deploy/data-plane-manifest.txt'
const SCRIPT_PATH = 'scripts/lemeng/sync-data-plane.sh'

/** 基线夹具：清单两条目录条目（一条在检出内、一条落在检出外）+ 一条文件条目。 */
function baseFixture(pruneRoots: string): string {
  return fixture({
    [MANIFEST_PATH]: manifest([
      'deploy/data-compose.yml   ${REPO}/deploy/data-compose.yml   0644',
      'duckle/                   ${REPO}/duckle/                    0644',
      'scripts/lemeng/diagnose.sh  /opt/lemeng-diagnose.sh          0755',
    ]),
    [SCRIPT_PATH]: script(pruneRoots),
  })
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

describe('check-prune-roots：基线', () => {
  it('声明与清单一致时干净（exit 0）', () => {
    const g = guard(baseFixture('duckle/'))
    expect(g.stderr).toBe('')
    expect(g.status).toBe(0)
    expect(g.stdout.trim()).toBe('check-prune-roots: OK')
  })

  it('落在检出**外**的目录条目不进作用域（不要求脚本声明它）', () => {
    // 夹具里没有落地在检出外的**目录**条目（只有文件条目），补一条：脚本不声明它也不该红。
    const root = fixture({
      [MANIFEST_PATH]: manifest([
        'duckle/        ${REPO}/duckle/        0644',
        'warehouse/     /opt/warehouse/        0644',
      ]),
      [SCRIPT_PATH]: script('duckle/'),
    })
    const g = guard(root)
    expect(g.status).toBe(0)
  })
})

describe('check-prune-roots：漂移两个方向', () => {
  it('清单授权的根、脚本没声明 ⇒ 报「静默漏清」（exit 1）', () => {
    const root = fixture({
      [MANIFEST_PATH]: manifest(['duckle/    ${REPO}/duckle/    0644', 'dbt/    ${REPO}/dbt/    0644']),
      [SCRIPT_PATH]: script('duckle/'),
    })
    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain("'dbt/'")
    expect(g.stderr).toContain('静默漏清')
    expect(g.stderr).toContain('PRUNE_ROOTS')
  })

  it('脚本声明的根、清单不授权 ⇒ 报「超出清单授权」（exit 1）', () => {
    const g = guard(baseFixture('duckle/ modules/'))
    expect(g.status).toBe(1)
    expect(g.stderr).toContain("'modules/'")
    expect(g.stderr).toContain('超出清单授权')
  })

  it('作用域被清空（PRUNE_ROOTS=）⇒ 每个授权根各报一条（exit 1）', () => {
    const g = guard(baseFixture(''))
    expect(g.status).toBe(1)
    expect(g.stderr).toContain("'duckle/'")
    expect(g.stderr).toContain('静默漏清')
  })
})

describe('check-prune-roots：声明行本身', () => {
  it('声明行被改名/重写 ⇒ 报「找不到 PRUNE_ROOTS=」（exit 1）', () => {
    const root = fixture({
      [MANIFEST_PATH]: manifest(['duckle/    ${REPO}/duckle/    0644']),
      [SCRIPT_PATH]: ['#!/bin/sh', "PRUNE_SCOPE='duckle/'", 'echo hi', ''].join('\n'),
    })
    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('找不到 PRUNE_ROOTS=')
  })

  it('注释/引用行不算声明（只有赋值行算）', () => {
    const root = fixture({
      [MANIFEST_PATH]: manifest(['duckle/    ${REPO}/duckle/    0644']),
      [SCRIPT_PATH]: [
        '#!/bin/sh',
        '# 作用域由 PRUNE_ROOTS 声明（这行只是注释，别被当成声明）',
        "PRUNE_ROOTS='duckle/'",
        'for _r in $PRUNE_ROOTS; do echo "$_r"; done',
        '',
      ].join('\n'),
    })
    const g = guard(root)
    expect(g.status).toBe(0)
  })

  it('脚本不存在 ⇒ 报错（exit 1）', () => {
    const root = fixture({ [MANIFEST_PATH]: manifest(['duckle/    ${REPO}/duckle/    0644']) })
    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('脚本不存在')
  })

  it('清单不存在 ⇒ 报错（exit 1）', () => {
    const root = fixture({ [SCRIPT_PATH]: script('duckle/') })
    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('清单不存在')
  })
})

describe('check-prune-roots：作用域退化成整个检出', () => {
  it('目录条目落在检出根（${REPO}/）⇒ 报「退化成整个检出」（exit 1）', () => {
    const root = fixture({
      [MANIFEST_PATH]: manifest(['./    ${REPO}/    0644', 'duckle/    ${REPO}/duckle/    0644']),
      [SCRIPT_PATH]: script('duckle/'),
    })
    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('退化成')
  })
})

describe('check-prune-roots：真实仓库', () => {
  it('真实仓库干净（exit 0）——PRUNE_ROOTS 与清单同步', () => {
    const g = guard(repoRoot)
    expect(g.stderr).toBe('')
    expect(g.status).toBe(0)
    expect(g.stdout.trim()).toBe('check-prune-roots: OK')
  })
})
