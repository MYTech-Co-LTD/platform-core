// scripts/lib/release-commits.test.ts — 发布门 PR 引用识别的真值表。
//
// 这组断言的来历是一条真实事故：2026-10 有一批提交把 PR 号写成全角 `（#1508）`，
// 而发布门只认半角 `(#1508)` ⇒ 它们被当成「直推」⇒ main 上的 release 从 v0.278.1 起恒红。
// 门只挡发版、不挡部署，所以这条红持续了很久才被发现——正是「判据口径」值得单独测的理由。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { needsPrLookup, prRefOf, stripPrRef } from './release-commits.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('prRefOf', () => {
  it('半角括号', () => {
    expect(prRefOf('feat(data): x (#123)')).toBe('123')
  })

  it('★ 全角括号（历史提交形态，事故根因）', () => {
    expect(prRefOf('feat(data): W6 会话关联——query_audit.session_id（#1508）')).toBe('1508')
  })

  it('末尾允许空白', () => {
    expect(prRefOf('fix(data): y （#9）  ')).toBe('9')
  })

  it('不在末尾的引用不算（避免把正文里的提及当 PR 关联）', () => {
    expect(prRefOf('fix(data): 回滚 #12 的改动')).toBeNull()
    expect(prRefOf('fix(data): (#12) 之外还有别的')).toBeNull()
  })

  it('没有引用 / 空值', () => {
    expect(prRefOf('feat(data): 直推的提交')).toBeNull()
    expect(prRefOf('')).toBeNull()
    expect(prRefOf(undefined as unknown as string)).toBeNull()
  })
})

describe('stripPrRef', () => {
  it('两种括号都剥掉，且不留尾部空格', () => {
    expect(stripPrRef('feat(data): x (#123)')).toBe('feat(data): x')
    expect(stripPrRef('feat(data): x（#123）')).toBe('feat(data): x')
  })

  it('不含引用时原样返回', () => {
    expect(stripPrRef('feat(data): x')).toBe('feat(data): x')
  })
})

describe('needsPrLookup', () => {
  it('可见类型且无文本引用 ⇒ 需要问 API', () => {
    expect(needsPrLookup({ subject: 'feat(data): x', visible: true })).toBe(true)
  })

  it('可见类型且已有文本引用 ⇒ 不需要（快路径）', () => {
    expect(needsPrLookup({ subject: 'feat(data): x（#1）', visible: true })).toBe(false)
  })

  it('不可见类型 ⇒ 永远不需要（docs/test/chore 不上榜）', () => {
    expect(needsPrLookup({ subject: 'docs: x', visible: false })).toBe(false)
  })
})

describe('黑盒：夹具仓库（与分支状态无关）', () => {
  // 为什么用夹具仓库而不是真仓库：真仓库上跑 release.mjs 会把**当前分支未合并的提交**也算进来
  // （它们没有 PR 引用）⇒ 任何 feature 分支的 test:guard 都会红。事故形态要钉的是「判据对不对」，
  // 不是「这条分支合没合」。夹具仓库里我们精确控制历史与 tag。
  it('★ 全角 PR 引用能过门（事故形态）；真直推仍被拒', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-fixture-'))
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      git(['init', '-q'])
      git(['config', 'user.email', 't@example.com'])
      git(['config', 'user.name', 't'])
      // 基线：打 tag 之后才是发布门要审的范围。
      writeFileSync(join(dir, 'a.txt'), 'a')
      // release.mjs 读 CHANGELOG.md（dry-run 只读不写）⇒ 夹具必须有一个最小合法文件。
      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n')
      git(['add', '.'])
      git(['commit', '-q', '-m', 'chore: init'])
      git(['tag', 'v0.1.0'])
      // ① 全角引用（历史事故形态）——必须被认作 PR 提交。
      writeFileSync(join(dir, 'b.txt'), 'b')
      git(['add', '.'])
      git(['commit', '-q', '-m', 'feat(data): 全角引用的一条（#12）'])
      // ② 真直推（没有任何引用）——必须被拒。
      writeFileSync(join(dir, 'c.txt'), 'c')
      git(['add', '.'])
      git(['commit', '-q', '-m', 'feat(data): 真正直推的一条'])

      const run = () => {
        try {
          return { code: 0, out: execFileSync(process.execPath, [join(repoRoot, 'scripts/release.mjs'), '--dry-run'], {
            cwd: dir, encoding: 'utf8', env: { ...process.env, REPO: 'test/repo', GH_TOKEN: '' },
          }) }
        } catch (e) {
          const err = e as { status?: number; stderr?: string; stdout?: string }
          return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
        }
      }

      const first = run()
      expect(first.code).toBe(1)
      expect(first.out).toContain('真正直推的一条')

      // 把直推那条从历史里去掉（reset 到全角提交），应当 exit 0 且生成带链接的条目。
      git(['reset', '-q', '--hard', 'HEAD~1'])
      const second = run()
      expect(second.code).toBe(0)
      expect(second.out).toContain('全角引用的一条')
      expect(second.out).toContain('pull/12')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
