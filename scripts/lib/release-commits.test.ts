// scripts/lib/release-commits.test.ts — 发布门 PR 引用识别的真值表。
//
// 这组断言的来历是一条真实事故：2026-10 有一批提交把 PR 号写成全角 `（#1508）`，
// 而发布门只认半角 `(#1508)` ⇒ 它们被当成「直推」⇒ main 上的 release 从 v0.278.1 起恒红。
// 门只挡发版、不挡部署，所以这条红持续了很久才被发现——正是「判据口径」值得单独测的理由。
import { execFileSync } from 'node:child_process'
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

describe('真实仓库：发布门必须能过（黑盒）', () => {
  it('★ `release.mjs --dry-run` 在主干上 exit 0，且不回退成「拒绝发版」', () => {
    // 这条钉的是**机制在真仓库上成立**：事故形态是「门恒红而没人知道」，纯函数测试测不到它。
    const out = execFileSync(process.execPath, ['scripts/release.mjs', '--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    expect(out).not.toContain('拒绝发版')
    // 两种环境都要成立：
    //   本机/全量历史 ⇒ 解析出条目（`- 【…】`）；
    //   PR 的 CI 是浅克隆 + merge commit，`--no-merges` 后为空 ⇒ 脚本打印「无可见变更」并 exit 0。
    // 这条只钉「门不误判」，不钉「一定有东西可发」。
    expect(/^- 【/m.test(out) || out.includes('无可见变更')).toBe(true)
    // ★ 零写入：dry-run 在本地与 test:guard 里都会被跑。早先的写入在 DRY 退出之前，
    //   每跑一次就改一次 CHANGELOG，还会被 `git add -A` 顺手提交——这条钉住它不再发生。
    const dirty = execFileSync('git', ['status', '--porcelain', 'CHANGELOG.md'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(dirty.trim()).toBe('')
  })
})
