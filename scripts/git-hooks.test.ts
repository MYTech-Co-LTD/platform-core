// scripts/git-hooks.test.ts —— 提交纪律装置（.githooks/pre-push + scripts/install-git-hooks.mjs）的测试。
//
// 为什么要有这些测试：这两件东西是**私有仓 free 版没有服务端分支保护**之后唯一的本地防线
// （见 deploy/branch-protection-runbook.md）。它们的失效方式是静默的 —— 钩子被删、执行位丢了、
// 或安装脚本挪了位置导致仓根算错，都不会有任何报错，只会"从此拦不住直推"。所以这里既测行为，
// 也钉住"真实仓库里装置完好"。
//
// 分两档：
//   · 纯 spawn 钩子/脚本本身（快，验行为分支）；
//   · **经真 git 推送一遍**（慢一点，但锁住钩子赖以工作的那个契约：git 到底怎么调它、
//     stdin 的推送计划长什么样）。第二档是必要的——只对着自造 fixture 断言，等于用自己
//     的假设验证自己的假设；git 的 stdin 格式一变，第一档照样全绿。
//
// 注意：本机可能在全局配置里设了 core.hooksPath（dev-workflow 的 commit-msg 就这么装的），
// 那会让"安装脚本应当覆盖它"和"全新克隆应当没有它"这两种断言随开发机漂移。故所有 git
// 相关子进程都屏蔽全局/系统配置（GIT_CONFIG_GLOBAL=/dev/null），测试才是无菌的。
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const hookPath = join(repoRoot, '.githooks', 'pre-push')
const installerPath = join(repoRoot, 'scripts', 'install-git-hooks.mjs')

const tmpDirs: string[] = []

/** 无菌 git 环境：屏蔽开发机的全局/系统配置，避免测试随环境漂移。 */
const cleanGitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** 真跑 git 的环境：在 cleanGitEnv 之上补回被一并屏蔽掉的提交身份（否则 commit 直接失败）。 */
const realGitEnv = {
  ...cleanGitEnv,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function spawn(script: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): RunResult {
  const r = spawnSync(script, args, {
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...cleanGitEnv, ...opts.env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function git(cwd: string, args: string[]): RunResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: realGitEnv })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 把 pre-push 钩子当成 git 那样喂推送计划跑一遍。plan 每行 `<local_ref> <local_sha> <remote_ref> <remote_sha>`。 */
function runHook(plan: string, env: Record<string, string> = {}): RunResult {
  return spawn(hookPath, ['origin', 'https://example.invalid/repo.git'], { input: plan, env })
}

/** 建一个临时 git 仓库，并把安装脚本按真实布局放进 <repo>/scripts/ 下。 */
function makeRepo(withHooksDir: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-hooks-'))
  tmpDirs.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root, env: cleanGitEnv })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(installerPath, join(root, 'scripts', 'install-git-hooks.mjs'))
  if (withHooksDir) mkdirSync(join(root, '.githooks'), { recursive: true })
  return root
}

function gitConfig(root: string, key: string): string | null {
  const r = spawnSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8', env: cleanGitEnv })
  return r.status === 0 ? (r.stdout ?? '').trim() : null
}

/** 建一对「裸 origin + 工作仓」，工作仓已装好本仓的 pre-push 钩子并有一条提交。 */
function makePushFixture(): { work: string; bare: string } {
  const bare = mkdtempSync(join(tmpdir(), 'platform-origin-'))
  const work = mkdtempSync(join(tmpdir(), 'platform-work-'))
  tmpDirs.push(bare, work)
  git(bare, ['init', '-q', '--bare'])
  git(work, ['init', '-q', '-b', 'main'])
  mkdirSync(join(work, '.githooks'), { recursive: true })
  copyFileSync(hookPath, join(work, '.githooks', 'pre-push'))
  git(work, ['config', 'core.hooksPath', '.githooks'])
  git(work, ['remote', 'add', 'origin', bare])
  writeFileSync(join(work, 'a.txt'), 'x')
  git(work, ['add', '.'])
  git(work, ['commit', '-q', '-m', 'init'])
  return { work, bare }
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('pre-push 钩子：直推防线', () => {
  const FEATURE = 'refs/heads/feat abc123 refs/heads/feat def456\n'
  const PUSH_MAIN = 'refs/heads/main abc123 refs/heads/main def456\n'
  const PUSH_MASTER = 'refs/heads/master abc123 refs/heads/master def456\n'
  // 删除远端分支时 local_sha 为全 0 —— 同样是"动 main"
  const DELETE_MAIN = '(delete) 0000000000000000000000000000000000000000 refs/heads/main def456\n'

  it('放行特性分支（不误伤正常开发）', () => {
    const r = runHook(FEATURE)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('拦下直推 main', () => {
    const r = runHook(PUSH_MAIN)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('拒绝直推 main')
    // 报错要给出路，不能只说"不行"
    expect(r.stderr).toContain('gh pr create')
    expect(r.stderr).toContain('PLATFORM_ALLOW_DIRECT_PUSH=1')
  })

  it('拦下直推 master', () => {
    expect(runHook(PUSH_MASTER).status).toBe(1)
  })

  it('拦下删除 main', () => {
    expect(runHook(DELETE_MAIN).status).toBe(1)
  })

  it('一次推多条分支，只要含 main 就拦', () => {
    const r = runHook(FEATURE + PUSH_MAIN)
    expect(r.status).toBe(1)
  })

  it('空推送计划不误拦', () => {
    expect(runHook('').status).toBe(0)
  })

  it('放行口要显式：PLATFORM_ALLOW_DIRECT_PUSH=1 才生效', () => {
    const allowed = runHook(PUSH_MAIN, { PLATFORM_ALLOW_DIRECT_PUSH: '1' })
    expect(allowed.status).toBe(0)
    // 放行也必须出声——静默放行等于没有这道防线
    expect(allowed.stderr).toContain('放行')

    // 其它值不算数（防止有人写成 =true / =yes 以为生效了）
    expect(runHook(PUSH_MAIN, { PLATFORM_ALLOW_DIRECT_PUSH: 'true' }).status).toBe(1)
    expect(runHook(PUSH_MAIN, { PLATFORM_ALLOW_DIRECT_PUSH: '0' }).status).toBe(1)
  })

  it('真实仓库里钩子文件存在且带执行位（git 只跑可执行钩子）', () => {
    expect(existsSync(hookPath)).toBe(true)
    // 0o111 = 任一执行位
    expect(statSync(hookPath).mode & 0o111).not.toBe(0)
  })
})

// 上面那档是"拿自造的计划喂钩子"——它验证不了 git 真的会这样喂。这一档补上：
// 建真仓、真推、看真 git 的反应。契约若变，这里先红。
describe('pre-push 钩子：经真 git 走一遍（锁住 git 与钩子之间的契约）', () => {
  it('直推 main 被真 git 拦下，且把走 PR 的命令打给用户', () => {
    const { work } = makePushFixture()
    const r = git(work, ['push', 'origin', 'main'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('拒绝直推 main')
    expect(r.stderr).toContain('gh pr create')
  })

  it('特性分支经真 git 正常推送（不误伤）', () => {
    const { work } = makePushFixture()
    git(work, ['switch', '-q', '-c', 'feat/x'])
    expect(git(work, ['push', 'origin', 'feat/x']).status).toBe(0)
  })

  it('删除远端 main 经真 git 也被拦', () => {
    const { work } = makePushFixture()
    // 先用 --no-verify 把 main 铺到远端（顺带证明下一条测试所述的绕过口真实存在）
    expect(git(work, ['push', '--no-verify', 'origin', 'main']).status).toBe(0)
    const r = git(work, ['push', 'origin', ':main'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('拒绝直推 main')
  })

  it('已知边界（记录在案，不是缺陷）：--no-verify 可一步绕过本钩子', () => {
    // 这条是**特征化测试**：git 压根不会调用钩子，所以钩子看不见 --no-verify。
    // 存在的意义是让"这钩子拦不住 --no-verify"这件事在代码里可测可见——若哪天有人
    // 以为它滴水不漏，这条测试就是反证。缓解在服务端：main-guard 事后仍会记一笔。
    const { work } = makePushFixture()
    expect(git(work, ['push', '--no-verify', 'origin', 'main']).status).toBe(0)
  })

  it('已知边界：对任意远端名都拦（--no-verify 之外，推 fork/备份仓 main 会被误伤）', () => {
    // 钩子只看 remote_ref，不看 $1 的远端名，故 `git push backup main` 也会被拦。
    // 方向是 fail-closed（多拦而非漏拦），记录下来而非"修好"——放宽远端名反而开出口子。
    const { work, bare } = makePushFixture()
    git(work, ['remote', 'add', 'backup', bare])
    const r = git(work, ['push', 'backup', 'main'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('拒绝直推 main')
  })
})

describe('install-git-hooks：让同事 clone 后自动装上', () => {
  it('在 git 仓库里会设好 core.hooksPath 并出声', () => {
    const root = makeRepo(true)
    expect(gitConfig(root, 'core.hooksPath')).toBeNull() // 前置：新 clone 没有它

    const r = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(r.status).toBe(0)
    expect(gitConfig(root, 'core.hooksPath')).toBe('.githooks')
    expect(r.stdout).toContain('core.hooksPath=.githooks')
  })

  it('幂等：已配好则完全静默', () => {
    const root = makeRepo(true)
    spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    const second = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(second.status).toBe(0)
    expect(second.stdout + second.stderr).toBe('')
  })

  it('已配好但钩子丢了执行位 → 再跑一次必须补回（幂等早退不得跳过修复）', () => {
    // 开发机的稳态正是“已经指向 .githooks”，而执行位会因 clone / 解包 / 拷贝 / 跨文件系统而丢。
    // 若补执行位排在幂等早退**之后**，它在稳态下永远不会执行 —— 守卫从此静默失效：git 只跑
    // 带执行位的钩子，直推 main 不再被拦，而**没有任何报错**。
    // CI 的“钩子存在且可执行”只覆盖全新 checkout（执行位来自索引），救不了本机被丢位的旧 checkout。
    const root = makeRepo(true)
    const hook = join(root, '.githooks', 'pre-push')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])

    chmodSync(hook, 0o644) // 模拟丢执行位（clone/解包/拷贝的常见结果）
    const again = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])

    expect(again.status).toBe(0)
    expect(statSync(hook).mode & 0o111).not.toBe(0) // ← 关键断言：修复必须回来
  })

  it('在 git 工作树里却找不到 .githooks 时必须出声（静默会掩盖"脚本位置放错"这类故障）', () => {
    const root = makeRepo(false)
    const r = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(r.status).toBe(0) // 永不阻断安装
    expect(r.stderr).toContain('找不到 .githooks')
  })

  it('被当依赖装在别人的仓库里时：**不写对方配置**，且出声', () => {
    // 这是真形态：<consumer>/node_modules/platform-core/scripts/install-git-hooks.mjs。
    // 危险在于 consumer 仓是个 git 工作树，所以"不在工作树里就退出"那道守卫**不会**触发；
    // 若无条件写 core.hooksPath，就会把 consumer 仓的所有钩子指向一个它那里不存在的
    // .githooks —— 该仓钩子集体静默失效。故这里断言仓根取自 git（--show-toplevel）。
    const consumer = mkdtempSync(join(tmpdir(), 'platform-consumer-'))
    tmpDirs.push(consumer)
    execFileSync('git', ['init', '-q'], { cwd: consumer, env: cleanGitEnv })
    const pkgRoot = join(consumer, 'node_modules', 'platform-core')
    const pkgScripts = join(pkgRoot, 'scripts')
    mkdirSync(pkgScripts, { recursive: true })
    copyFileSync(installerPath, join(pkgScripts, 'install-git-hooks.mjs'))
    // 包里自带 .githooks（源码发布形态）——但 **consumer 仓根没有**
    mkdirSync(join(pkgRoot, '.githooks'), { recursive: true })

    const r = spawn(process.execPath, [join(pkgScripts, 'install-git-hooks.mjs')])
    expect(r.status).toBe(0)
    expect(gitConfig(consumer, 'core.hooksPath')).toBeNull() // ← 关键断言
    expect(r.stderr).toContain('找不到 .githooks')
  })

  it('不在任何 git 仓库里（源码被解到别处）时静默且不报错', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-hooks-nogit-'))
    tmpDirs.push(root)
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(installerPath, join(root, 'scripts', 'install-git-hooks.mjs'))
    const r = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toBe('')
  })

  it('永不阻断安装：.githooks 是个普通文件（readdirSync 会 ENOTDIR）也 exit 0', () => {
    // 头注承诺的是**任何**失败都只警告、不 exit 非 0。列目录失败曾是漏网的那条：
    // readdirSync 在 try 之外时，node 会以未捕获异常退出码 1 让 pnpm install 整个挂掉。
    const root = mkdtempSync(join(tmpdir(), 'platform-hooks-enotdir-'))
    tmpDirs.push(root)
    execFileSync('git', ['init', '-q'], { cwd: root, env: cleanGitEnv })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(installerPath, join(root, 'scripts', 'install-git-hooks.mjs'))
    writeFileSync(join(root, '.githooks'), 'not a directory') // ← 同名普通文件

    const r = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(r.status).toBe(0)
  })

  it('真实仓库里 prepare 仍指向本安装脚本（层②的接线不许被悄悄改掉）', () => {
    // CI 的 gates job 也校验这一条；这里再钉一次，让本地 `pnpm test` 就能发现，
    // 不必等到推上去才知道自动安装已经断了。
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.prepare).toMatch(/install-git-hooks\.mjs/)
  })
})
