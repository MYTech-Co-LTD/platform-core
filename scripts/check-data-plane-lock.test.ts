// scripts/check-data-plane-lock.test.ts — 数据面投递门禁的 fixtures 测试。
//
// 覆盖两个脚本：生成器 `lemeng/data-plane-lock.mjs` 与守卫 `check-data-plane-lock.mjs`。
// **全部黑盒**：spawn CLI、断言退出码与输出行。理由与 lint-architecture.test.ts 同——门禁的对外
// 契约就是这两样；且夹具落在系统临时目录，与真实仓库完全隔离。最后一组反过来钉住
// 「真实仓库必须干净」（exit 0），防的是「机制落码了、lock 却是旧的」。
//
// ⚠️ 夹具必须是**真的 git 仓库**：生成器用 `git ls-files` 枚举「受版本控制 + 未被 .gitignore 忽略」
// 的文件，遍历文件系统会把 `dbt/target/` 这类本地产物也卷进来（而它们正是机器上的本地状态，
// 绝不能被登记）。所以每个夹具都 `git init` + 提交，不省这一步。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const GENERATOR = join(repoRoot, 'scripts/lemeng/data-plane-lock.mjs')
const GUARD = join(repoRoot, 'scripts/check-data-plane-lock.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []

/** 建一个临时夹具（files: 相对路径 → 内容）并 `git init` + 提交；用完在 afterAll 统一删除。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-datplane-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' })
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'pipe' })
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'fixture'],
    { stdio: 'pipe' },
  )
  return root
}

/** 跑一个脚本（纯 ESM，node 入口与 `tsx <x>.mjs` 同）。 */
function run(script: string, root: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const generate = (root: string): RunResult => run(GENERATOR, root)
const guard = (root: string): RunResult => run(GUARD, root)

const lockPath = (root: string): string => join(root, 'deploy/data-plane.lock')
const readLock = (root: string): string => readFileSync(lockPath(root), 'utf8')
const writeLock = (root: string, text: string): void => writeFileSync(lockPath(root), text)

/**
 * 重算 lock 首行的自校验值。
 * 只给「想验证**除自校验以外**的判据」的用例用——否则一改 lock 就同时触发自校验失败，
 * 两条违规混在一起，测不出该用例真正要钉的那条。
 */
function fixSelfChecksum(text: string): string {
  const rest = text.slice(text.indexOf('\n') + 1)
  return `sha256-of-rest ${createHash('sha256').update(rest).digest('hex')}\n${rest}`
}

/** 基线夹具：一条目录条目（dbt/）+ 一条改名文件条目（run.sh → /opt/lemeng-run.sh）。 */
const BASE_FILES: Record<string, string> = {
  'deploy/data-plane-manifest.txt': [
    '# 夹具清单',
    'dbt/                                 ${REPO}/dbt/                 0644',
    'scripts/lemeng/run.sh                /opt/lemeng-run.sh           0755',
    '',
  ].join('\n'),
  'dbt/a.sql': 'select 1\n',
  'dbt/b.sql': 'select 2\n',
  'scripts/lemeng/run.sh': [
    '#!/bin/sh',
    'REPO=${REPO:-/opt/platform-core-data/platform-core}',
    'cat "$REPO/dbt/a.sql"',
    '',
  ].join('\n'),
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

describe('生成器 + 守卫：基线', () => {
  it('夹具自洽时生成后守卫干净（exit 0）', () => {
    const root = fixture(BASE_FILES)
    const gen = generate(root)
    expect(gen.status).toBe(0)
    // 两条清单条目（1 目录 + 1 文件）展开成 3 个文件
    expect(gen.stdout).toContain('2 条清单条目 → 3 个文件')
    const g = guard(root)
    expect(g.stderr).toBe('')
    expect(g.status).toBe(0)
    expect(g.stdout.trim()).toBe('check-data-plane-lock: OK')
  })

  it('lock 首行自校验值与「其余部分」的 sha256 一致', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    const text = readLock(root)
    const rest = text.slice(text.indexOf('\n') + 1)
    expect(text.split('\n')[0]).toBe(`sha256-of-rest ${createHash('sha256').update(rest).digest('hex')}`)
  })

  it('同名文件按仓内路径排序，落地路径是模板（不是机器真路径）', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    const lines = readLock(root).trim().split('\n').slice(1)
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['dbt/a.sql', 'dbt/b.sql', 'scripts/lemeng/run.sh'])
    expect(lines[2]).toContain('/opt/lemeng-run.sh 0755')
    expect(lines[0]).toContain('${REPO}/dbt/a.sql 0644')
  })
})

describe('守卫：三个必报的窟窿', () => {
  it('lock 缺行 → 报「缺行」并点名文件', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    // 删掉 dbt/b.sql 那行，重算自校验 ⇒ 只剩「缺行」这一条违规
    const kept = readLock(root)
      .split('\n')
      .filter((l) => !l.includes(' dbt/b.sql '))
      .join('\n')
    writeLock(root, fixSelfChecksum(kept))

    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('1 处违规')
    expect(g.stderr).toContain('缺行：dbt/b.sql')
  })

  it('lock 多行 → 报「多行」', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    const bogus = `0${'0'.repeat(63)} dbt/gone.sql \${REPO}/dbt/gone.sql 0644\n`
    writeLock(root, fixSelfChecksum(readLock(root) + bogus))

    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('多行：dbt/gone.sql')
  })

  it('仓内文件改了而 lock 没重新生成 → 报「sha256 不符」并给出重生成命令', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    writeFileSync(join(root, 'dbt/a.sql'), 'select 999\n')

    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('sha256 不符：dbt/a.sql')
    expect(g.stderr).toContain('pnpm exec tsx scripts/lemeng/data-plane-lock.mjs')
  })

  it('lock 正文被改过（仍可解析）→ 报「首行自校验不符」', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    // 只在正文里改一个 hex 字符、**不重算首行**：这正是自校验存在的理由——改动落在锁内时，
    // 首行是唯一会喊出来的东西。（本条同时触发判据 2 的 sha256 不符，故不断言违规条数。）
    const lines = readLock(root).trimEnd().split('\n')
    const target = lines[1]
    lines[1] = `${target.slice(0, 1) === '0' ? '1' : '0'}${target.slice(1)}`
    writeLock(root, `${lines.join('\n')}\n`)

    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('首行自校验不符')
  })

  it('lock 被字节截断（不可解析）→ 显式失败，不静默通过', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    // 砍在行中间 ⇒ 末行凑不满四列。这条走的是 parseLock 的显式失败，与上一条（可解析但被改）
    // 是两种不同的截断形态，都要 loud。
    writeLock(root, readLock(root).slice(0, 120))

    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('data-plane.lock')
    expect(g.stderr).toContain('期望四列')
  })

  it('脚本引用了任何落地路径之外的 $REPO 路径 → 报未覆盖（lock 已重生成时只剩这一条）', () => {
    const root = fixture(BASE_FILES)
    const scriptAbs = join(root, 'scripts/lemeng/run.sh')
    writeFileSync(scriptAbs, `${readFileSync(scriptAbs, 'utf8')}cat "$REPO/contracts/common/x.json"\n`)
    expect(generate(root).status).toBe(0)

    const g = guard(root)
    expect(g.status).toBe(1)
    expect(g.stderr).toContain('1 处违规')
    expect(g.stderr).toContain('scripts/lemeng/run.sh')
    expect(g.stderr).toContain('引用了 $REPO/contracts/common/x.json')
  })

  it('目录条目覆盖到子路径 ⇒ 前缀命中，不报未覆盖（即便该文件并不存在）', () => {
    // ⚠️ 这是**有意的边界**，不是漏判：判据 3 问的是「这个引用有没有被清单覆盖」，不是「这个文件在不在」。
    // 加存在性检查反而会误报——`dbt/target/`、`dbt/logs/` 这些**机器本地状态**正住在被 `dbt/` 覆盖的
    // 目录里，脚本合法引用它们是本机制要保住的行为。
    const root = fixture(BASE_FILES)
    const scriptAbs = join(root, 'scripts/lemeng/run.sh')
    writeFileSync(scriptAbs, `${readFileSync(scriptAbs, 'utf8')}ls "$REPO/dbt/target"\n`)
    expect(generate(root).status).toBe(0)
    expect(guard(root).status).toBe(0)
  })

  it('清单里登记的落地路径不在任何 $REPO/ 引用里也不报（清单允许比引用面宽）', () => {
    const root = fixture({
      ...BASE_FILES,
      'duckle/common/x.json': '{}\n',
      'deploy/data-plane-manifest.txt': [
        'dbt/                 ${REPO}/dbt/       0644',
        'duckle/              ${REPO}/duckle/    0644',
        'scripts/lemeng/run.sh  /opt/lemeng-run.sh  0755',
        '',
      ].join('\n'),
    })
    expect(generate(root).status).toBe(0)
    expect(guard(root).status).toBe(0)
  })
})

describe('守卫：排除项与契约', () => {
  it('机器本地物的写入目标（$REPO/deploy/.env）被排除，不报未覆盖', () => {
    const root = fixture({
      ...BASE_FILES,
      'scripts/lemeng/run.sh': [
        '#!/bin/sh',
        'REPO=${REPO:-/opt/platform-core-data/platform-core}',
        'cat "$REPO/dbt/a.sql"',
        'printf "K=%s\\n" "$V" > "$REPO/deploy/.env"',
        'chmod 600 "$REPO/deploy/.env"',
        '',
      ].join('\n'),
    })
    expect(generate(root).status).toBe(0)
    const g = guard(root)
    expect(g.stderr).toBe('')
    expect(g.status).toBe(0)
  })

  it('同步程序自己写出的版本标记（$REPO/$REVISION_REL 与它的临时文件）被排除，不报未覆盖', () => {
    // 这两条排除项与 `deploy/.env` 同类：都是**脚本在机器上写出的**目标，不是被投递物。
    // ⚠️ 本用例同时钉住「排除项匹配的是**字面原文**」——夹具里写的是变量引用形态而非解析后的
    // 路径，删掉那两条排除项本例必红（`$REVISION_REL` 不在清单落地路径集合里）。
    const root = fixture({
      ...BASE_FILES,
      'scripts/lemeng/run.sh': [
        '#!/bin/sh',
        'REPO=${REPO:-/opt/platform-core-data/platform-core}',
        'REVISION_REL=".data-plane-revision"',
        'cat "$REPO/dbt/a.sql"',
        'printf "sha %s\\n" "$SHA" > "$REPO/.$REVISION_REL.tmp.$$"',
        'mv -f "$REPO/.$REVISION_REL.tmp.$$" "$REPO/$REVISION_REL"',
        '',
      ].join('\n'),
    })
    expect(generate(root).status).toBe(0)
    const g = guard(root)
    expect(g.stderr).toBe('')
    expect(g.status).toBe(0)
  })

  it('清单缺失 / lock 缺失都报（不是静默通过）', () => {
    const noManifest = fixture({ 'dbt/a.sql': 'select 1\n' })
    const g1 = guard(noManifest)
    expect(g1.status).toBe(1)
    expect(g1.stderr).toContain('清单不存在')

    const noLock = fixture(BASE_FILES)
    const g2 = guard(noLock)
    expect(g2.status).toBe(1)
    expect(g2.stderr).toContain('lock 不存在')
  })

  it('清单列数不是三列 → 显式失败并给出行号', () => {
    const root = fixture({ ...BASE_FILES, 'deploy/data-plane-manifest.txt': 'dbt/ ${REPO}/dbt/\n' })
    const g = generate(root)
    expect(g.status).not.toBe(0)
    expect(g.stderr).toContain('期望三列')
  })

  it('仓库不是 git 仓 → exit 2（判据依赖 git 枚举，宁可显式失败也不静默跳过）', () => {
    const root = fixture(BASE_FILES)
    rmSync(join(root, '.git'), { recursive: true, force: true })
    const g = guard(root)
    expect(g.status).toBe(2)
    expect(g.stderr).toContain('不是 git 仓库')
  })
})

describe('真实仓库', () => {
  it('生成器幂等：连跑两次输出逐字节相同', () => {
    const root = fixture(BASE_FILES)
    expect(generate(root).status).toBe(0)
    const first = readLock(root)
    expect(generate(root).status).toBe(0)
    expect(readLock(root)).toBe(first)
  })

  it('本仓库的 lock 与工作区一致（守卫 exit 0）', () => {
    const g = guard(repoRoot)
    expect(g.stderr).toBe('')
    expect(g.status).toBe(0)
    expect(g.stdout.trim()).toBe('check-data-plane-lock: OK')
  })
})
