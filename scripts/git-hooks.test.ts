// scripts/git-hooks.test.ts —— 提交纪律装置（.githooks/pre-push + scripts/install-git-hooks.mjs）的测试。
//
// 为什么要有这些测试：这两件东西是**私有仓 free 版没有服务端分支保护**之后唯一的本地防线
// （见 deploy/branch-protection-runbook.md）。它们的失效方式是静默的 —— 钩子被删、执行位丢了、
// 或安装脚本挪了位置导致仓根算错，都不会有任何报错，只会"从此拦不住直推"。所以这里既测行为，
// 也钉住"真实仓库里装置完好"。
//
// 全部黑盒：spawn 真实入口、断言退出码与 stderr —— 与 scripts/lint-architecture.test.ts 同一体例。
//
// 注意：本机可能在全局配置里设了 core.hooksPath（dev-workflow 的 commit-msg 就这么装的），
// 那会让"安装脚本应当覆盖它"和"全新克隆应当没有它"这两种断言随开发机漂移。故所有 git 相关
// 子进程都屏蔽全局/系统配置（GIT_CONFIG_GLOBAL=/dev/null），测试才是无菌的。
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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

/** 把 pre-push 钩子当成 git 那样喂推送计划跑一遍。plan 每行 `<local_ref> <local_sha> <remote_ref> <remote_sha>`。 */
function runHook(plan: string, env: Record<string, string> = {}): RunResult {
  return spawn(hookPath, ['origin', 'https://example.invalid/repo.git'], { input: plan, env })
}

/** 建一个临时 git 仓库，并把安装脚本按真实布局放进 <repo>/scripts/ 下（脚本靠自身位置推仓根）。 */
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

  it('在 git 工作树里却找不到 .githooks 时必须出声（静默会掩盖"脚本位置放错"这类故障）', () => {
    const root = makeRepo(false)
    const r = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(r.status).toBe(0) // 永不阻断安装
    expect(r.stderr).toContain('找不到 .githooks')
  })

  it('不在 git 仓库里（被当依赖安装）时静默且不报错', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-hooks-nogit-'))
    tmpDirs.push(root)
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(installerPath, join(root, 'scripts', 'install-git-hooks.mjs'))
    const r = spawn(process.execPath, [join(root, 'scripts', 'install-git-hooks.mjs')])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).toBe('')
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
