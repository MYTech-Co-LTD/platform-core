// scripts/check-dev-discipline.test.ts —— CHANGELOG 手改守卫（scripts/check-dev-discipline.sh）的测试。
//
// 为什么要有这些测试：这道守卫会**两种方向**失效，而且都不出声。
//   · 松（假阳性）：变更集取两棵树比（`$BASE..$HEAD`）时，分支只要**落后于 main**，main 上的改动
//     就显示成「这个分支改了它」；而 main 每次发版都有 `chore(release)` 改 CHANGELOG.md
//     ⇒ 落后即误报。这是**稳态**，不是边角（issue #99）。
//   · 紧（假阴性）：为了消误报而放宽判据 —— 例如把豁免那句 `git log` 也改成三点 —— 会把真手改放掉。
//     **一个放走真阳性的守卫比没有守卫更糟**（不合规的 CHANGELOG 会直接进 main）。
// 所以下面两组用例必须同时在：**落后分支必须放行** 与 **真手改必须拦住**。
//
// 跑的是**真 git 仓 + 真脚本**（照 scripts/git-hooks.test.ts 的做法）：判据本身就是 git 的两点/三点
// 语义，拿自造 fixture 去断言等于用自己的假设验证自己的假设。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptPath = join(repoRoot, 'scripts', 'check-dev-discipline.sh')

const tmpDirs: string[] = []

/** 无菌 git 环境：屏蔽开发机的全局/系统配置，避免测试随环境漂移。 */
const cleanGitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

/** 真提交需要的身份（被 cleanGitEnv 一并屏蔽掉了，这里补回）。 */
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

function git(cwd: string, args: string[]): RunResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: realGitEnv })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function gitOut(cwd: string, args: string[]): string {
  const r = git(cwd, args)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`)
  return r.stdout.trim()
}

/** 走 CI 的调用方式：显式传 `origin/main HEAD`（与 .github/workflows/{,ci}*.yml 一致）。 */
function runGuard(cwd: string, args = ['origin/main', 'HEAD']): RunResult & { out: string } {
  const r = spawnSync('bash', [scriptPath, ...args], { cwd, encoding: 'utf8', env: cleanGitEnv })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { status: r.status, stdout, stderr, out: stdout + stderr }
}

interface Fixture {
  work: string
  /** 分叉点：main 上第一个 `chore(release)` **之前**的提交（从它建分支 = 落后 main）。 */
  forkPoint: string
}

/**
 * 建一个「裸 origin + 工作仓」，main 的形状对齐真实仓：
 *
 *   c1 feat(demo): 起点            ← forkPoint（从它分叉就是「落后于 main」）
 *   c2 chore(release): v1.0.0      ← 改 CHANGELOG.md（main 每次发版都有这么一条）
 *   c3 fix(demo): main 又往前走
 *
 * c2 是关键：**没有它就没有这个 bug** —— 两点 diff 把它的 CHANGELOG 改动算到落后分支头上。
 */
function makeFixture(): Fixture {
  const bare = mkdtempSync(join(tmpdir(), 'platform-discipline-origin-'))
  const work = mkdtempSync(join(tmpdir(), 'platform-discipline-work-'))
  tmpDirs.push(bare, work)
  git(bare, ['init', '-q', '--bare'])
  git(work, ['init', '-q', '-b', 'main'])
  git(work, ['remote', 'add', 'origin', bare])

  commitFile(work, 'a.txt', 'a\n', 'feat(demo): 起点 (#1)')
  const forkPoint = gitOut(work, ['rev-parse', 'HEAD'])
  commitFile(work, 'CHANGELOG.md', '# CHANGELOG\n\n## v1.0.0\n', 'chore(release): v1.0.0 [skip ci]')
  commitFile(work, 'b.txt', 'b\n', 'fix(demo): main 又往前走 (#2)')

  expect(git(work, ['push', '-q', 'origin', 'main']).status).toBe(0)
  expect(git(work, ['fetch', '-q', 'origin']).status).toBe(0)
  return { work, forkPoint }
}

function commitFile(work: string, file: string, content: string, message: string): void {
  mkdirSync(dirname(join(work, file)), { recursive: true })
  writeFileSync(join(work, file), content)
  expect(git(work, ['add', file]).status).toBe(0)
  const c = git(work, ['commit', '-q', '-m', message])
  if (c.status !== 0) throw new Error(`commit 失败: ${c.stderr}`)
}

/** 从 from 建分支并切过去。 */
function branchFrom(work: string, name: string, from: string): void {
  const r = git(work, ['switch', '-q', '-c', name, from])
  if (r.status !== 0) throw new Error(`建分支失败: ${r.stderr}`)
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('CHANGELOG 守卫：变更集口径（issue #99 假阳性）', () => {
  it('夹具本身能触发旧 bug：两点 diff 把 main 上的 CHANGELOG 算进分支，三点不会', () => {
    // **特征化测试**：钉住「这个夹具真的能复现 #99」。若哪天夹具退化成两点/三点一样，
    // 下面那条「落后分支必须放行」就变成了空转 —— 由这条先红来报警。
    const { work, forkPoint } = makeFixture()
    branchFrom(work, 'repro/x', forkPoint)
    commitFile(work, 'c.txt', 'c\n', 'docs(demo): 只改一个无关文件 (#99)')

    expect(gitOut(work, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('2') // 确实落后 2 个提交
    expect(gitOut(work, ['diff', '--name-only', 'origin/main..HEAD'])).toContain('CHANGELOG.md')
    expect(gitOut(work, ['diff', '--name-only', 'origin/main...HEAD'])).not.toContain('CHANGELOG.md')
    expect(gitOut(work, ['diff', '--name-only', 'origin/main...HEAD'])).toBe('c.txt')
  })

  it('① 落后于 main 的分支只改无关文件 ⇒ 守卫通过（落后本身不再算「手改」）', () => {
    const { work, forkPoint } = makeFixture()
    branchFrom(work, 'feat/behind', forkPoint)
    commitFile(work, 'c.txt', 'c\n', 'docs(demo): 只改一个无关文件 (#99)')

    const r = runGuard(work)
    expect(r.out).toContain('✅ 开发纪律检查通过')
    expect(r.status).toBe(0)
  })

  it('① 文件名只是**含** CHANGELOG 字样（CHANGELOG-old.md）⇒ 不算手改', () => {
    // 判据是锚定的 `^CHANGELOG\.md$`；改口径时别把锚定弄丢 —— 那会让任何名字带 CHANGELOG 的文件
    // 都撞上这条守卫（新守卫脚本的常见写法事故：grep 掉了边界）。
    const { work, forkPoint } = makeFixture()
    branchFrom(work, 'docs/changelog-old', forkPoint)
    commitFile(work, 'docs/CHANGELOG-old.md', 'old\n', 'docs(demo): 归档旧 changelog (#99)')

    expect(gitOut(work, ['diff', '--name-only', 'origin/main...HEAD'])).toBe('docs/CHANGELOG-old.md')
    expect(runGuard(work).status).toBe(0)
  })

  it('② 基于最新 main 的分支真手改 CHANGELOG.md ⇒ 守卫必须仍然报错', () => {
    // 这条是整个改动里最容易搞砸的一面：消假阳性时把真阳性一起放掉，守卫就成了摆设。
    const { work } = makeFixture()
    branchFrom(work, 'docs/hand-edit', 'origin/main')
    commitFile(work, 'CHANGELOG.md', '# CHANGELOG\n\n## v1.0.0\n\n- 我手加的一行\n', 'docs(demo): 手改 CHANGELOG')

    const r = runGuard(work)
    expect(r.status).toBe(1)
    expect(r.out).toContain('❌ CHANGELOG.md 被改')
    expect(r.out).toContain('❌ 开发纪律检查失败')
  })

  it('② 报错文案：给出各自正确的动作，且不再给有害的 checkout 建议', () => {
    // 旧文案建议 `git checkout origin/main -- CHANGELOG.md` —— 照做会把 main 的发版提交带进本分支，
    // **从「只是落后」变成真违规**。有害建议必须先消失，才谈得上文案改好了。
    const { work } = makeFixture()
    branchFrom(work, 'docs/hand-edit-msg', 'origin/main')
    commitFile(work, 'CHANGELOG.md', '# CHANGELOG\n\n## v1.0.0\n\n- 我手加的一行\n', 'docs(demo): 手改 CHANGELOG')

    const { out } = runGuard(work)
    // 旧文案的整句（把 checkout 当成补救动作）不许再出现
    expect(out).not.toContain('回退该文件后重提：git checkout')
    // 两种情形都要有，且各给自己该做的动作
    expect(out).toContain('撤销')
    expect(out).toContain('git rebase origin/main')
    // checkout main 的那条命令只在**被点名警告**时出现
    expect(out).toMatch(/不要用 git checkout origin\/main -- CHANGELOG\.md/)
    // 别再指错方向：不能只甩一句「被手改」了事
    expect(out).toContain('落后于 main')
  })
})

describe('CHANGELOG 守卫：chore(release) 豁免', () => {
  it('③ 分支只含 chore(release) 提交（基于最新 main）⇒ 放行', () => {
    const { work } = makeFixture()
    branchFrom(work, 'release/up-to-date', 'origin/main')
    commitFile(work, 'CHANGELOG.md', '# CHANGELOG\n\n## v1.1.0\n\n## v1.0.0\n', 'chore(release): v1.1.0 [skip ci]')

    const r = runGuard(work)
    expect(r.out).toContain('chore(release) 提交，放行')
    expect(r.status).toBe(0)
  })

  it('③ 分支只含 chore(release) 提交、**且落后于 main** ⇒ 仍然放行（豁免必须用两点 log）', () => {
    // 这条钉住 #99 里最容易搞反的一处：`diff A...B` 与 `log A...B` **名字像、语义不同** ——
    // diff 三点 = 比 merge-base（要的正是它）；log 三点 = **对称差**（把 main 上分支没有的提交
    // 一并卷进来）。leader 若照字面把豁免那句也改成三点，落后分支上 main 的 `fix(...)` 会被算成
    // 「本分支的非 release 提交」⇒ 这条红。而在三点变更集下，**恰好只有落后场景才走得到这个分支**，
    // 所以这个差别正好落在主路径上，不是边角。
    const { work, forkPoint } = makeFixture()
    branchFrom(work, 'release/behind', forkPoint)
    commitFile(work, 'CHANGELOG.md', '# CHANGELOG\n\n## v1.1.0\n\n## v1.0.0\n', 'chore(release): v1.1.0 [skip ci]')

    // 前置：不落后的话这条测试就没意义了
    expect(gitOut(work, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('2')
    expect(gitOut(work, ['log', '--no-merges', '--format=%s', 'origin/main...HEAD'])).toContain('fix(demo)')

    const r = runGuard(work)
    expect(r.out).toContain('chore(release) 提交，放行')
    expect(r.status).toBe(0)
  })
})

describe('check-dev-discipline.sh：commit 格式那一半没被带坏', () => {
  it('坏 message 仍然拦住（② 的改动不该碰到 ①）', () => {
    const { work, forkPoint } = makeFixture()
    branchFrom(work, 'chore/bad-message', forkPoint)
    commitFile(work, 'e.txt', 'e\n', '随手改了点东西')

    const r = runGuard(work)
    expect(r.status).toBe(1)
    expect(r.out).toContain('格式不符')
  })
})
