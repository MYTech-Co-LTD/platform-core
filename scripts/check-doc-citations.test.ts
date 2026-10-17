// scripts/check-doc-citations.test.ts — 文档引用门禁的夹具测试（issue #771）。
//
// 手法与 check-data-contract.test.ts 一致：**在临时目录里造一棵最小的假仓**，按判据逐条变异，
// 确认门禁**真的会红**（本仓规矩：一个从不红的判据等于没有判据）。
//
// ⚠️ 本文件的**一半用例是在钉「不判什么」**（文件不存在 / 歧义 / 无行号一律不报）。
//    那不是凑数：本门禁的核心设计决定就是「只判行号越界」，而这些用例是那个决定的护栏——
//    谁哪天好心把「文件不存在」加回来，这里会红。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { checkDocCitations, countLines, parseLineSpec, resolveRepoFile } from './check-doc-citations.mjs'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** 被引用的文件内容：固定 3 行，方便算越界。 */
const THREE_LINES = 'line1\nline2\nline3\n'

/**
 * 造一棵最小假仓：`src/thing.ts`（3 行）+ 可选的歧义文件对 + 一份文档。
 *
 * @param {string} docBody 文档正文（写进 `docs/x.md`）
 * @param {{ ambiguous?: boolean }} [over]
 * @returns {string} 临时仓根
 */
function fixture(docBody: string, over: { ambiguous?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'doccite-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'src', 'thing.ts'), THREE_LINES)
  if (over.ambiguous === true) {
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'manifest.yaml'), 'a\n')
    writeFileSync(join(root, 'b', 'manifest.yaml'), 'b\n')
  }
  writeFileSync(join(root, 'docs', 'x.md'), docBody)
  return root
}

const check = (docBody: string, over?: { ambiguous?: boolean }) =>
  checkDocCitations(fixture(docBody, over), ['docs/x.md'])

describe('文档引用门禁：行号越界（唯一判据）', () => {
  it('行号在范围内 ⇒ 无违规', () => {
    expect(check('见 `src/thing.ts:2`。')).toHaveLength(0)
  })

  it('行号越界 ⇒ 1 条违规，且消息点名解析到的文件与总行数', () => {
    const v = check('见 `src/thing.ts:9`。')
    expect(v).toHaveLength(1)
    expect(v[0].file).toBe('docs/x.md')
    expect(v[0].line).toBe(1)
    expect(v[0].message).toContain('src/thing.ts')
    expect(v[0].message).toContain('共 3 行')
    expect(v[0].message).toContain('9')
  })

  it('行号 0 / 负数 ⇒ 违规（不是「从末尾数」）', () => {
    expect(check('见 `src/thing.ts:0`。')).toHaveLength(1)
  })

  it('区间整体在范围内 ⇒ 无违规', () => {
    expect(check('见 `src/thing.ts:1-3`。')).toHaveLength(0)
  })

  it('区间端点越界 ⇒ 1 条，且**只报端点**（`1-999` 不刷屏）', () => {
    const v = check('见 `src/thing.ts:1-999`。')
    expect(v).toHaveLength(1)
    expect(v[0].message).toContain('999')
    expect(v[0].message).not.toContain('4, 5')
  })

  it('逗号列表部分越界 ⇒ 1 条', () => {
    expect(check('见 `src/thing.ts:1,5,9`。')).toHaveLength(1)
  })

  it('同一文档多处越界 ⇒ 逐处报（每条带自己的行号）', () => {
    const v = check('第一处 `src/thing.ts:7`。\n第二处 `src/thing.ts:8`。')
    expect(v).toHaveLength(2)
    expect(v.map((x) => x.line)).toEqual([1, 2])
  })

  it('后缀解析：写裸文件名也能定位（唯一时）', () => {
    expect(check('见 `thing.ts:9`。')).toHaveLength(1)
  })
})

describe('文档引用门禁：**不判**什么（核心设计决定的护栏）', () => {
  it('文件不存在 ⇒ 不判（仓外 / 待建 / 已迁移的引用占绝大多数，判了是噪声）', () => {
    expect(check('见 `src/ghost.ts:9`。')).toHaveLength(0)
    expect(check('见 `explore 仓 docs/adr/0005.md:9`。')).toHaveLength(0)
  })

  it('文件名歧义 ⇒ 不判（人读得懂，机器分不清）', () => {
    expect(check('见 `manifest.yaml:9`。', { ambiguous: true })).toHaveLength(0)
  })

  it('没有行号的引用 ⇒ 不判（本门禁只回答「这个行号存在吗」）', () => {
    expect(check('见 `src/thing.ts`。')).toHaveLength(0)
  })

  it('反引号外的裸路径 ⇒ 不判（否则英文句点会误伤）', () => {
    expect(check('见 src/thing.ts:9 与 src/thing.ts。')).toHaveLength(0)
  })
})

describe('resolveRepoFile', () => {
  const files = ['src/thing.ts', 'a/manifest.yaml', 'b/manifest.yaml']

  it('整路径精确命中', () => {
    expect(resolveRepoFile(files, 'src/thing.ts')).toBe('src/thing.ts')
  })

  it('唯一后缀命中', () => {
    expect(resolveRepoFile(files, 'thing.ts')).toBe('src/thing.ts')
  })

  it('歧义返回 null（不判）', () => {
    expect(resolveRepoFile(files, 'manifest.yaml')).toBeNull()
  })

  it('不存在返回 null（不判）', () => {
    expect(resolveRepoFile(files, 'ghost.ts')).toBeNull()
  })
})

describe('parseLineSpec', () => {
  it('单行', () => {
    expect(parseLineSpec('3', 3)).toEqual([])
    expect(parseLineSpec('4', 3)).toEqual([4])
  })

  it('区间', () => {
    expect(parseLineSpec('1-3', 3)).toEqual([])
    expect(parseLineSpec('1-4', 3)).toEqual([4])
  })

  it('逗号列表', () => {
    expect(parseLineSpec('1,3', 3)).toEqual([])
    expect(parseLineSpec('1,3,5', 3)).toEqual([5])
  })

  it('倒序区间（`5-2`）判为坏', () => {
    expect(parseLineSpec('5-2', 10)).toEqual([5])
  })
})

describe('countLines（`wc -l` 口径）', () => {
  it('结尾的换行符**不**额外算一行', () => {
    // ⚠️ 这条钉的是一个真 bug：用 `split('\n').length` 会给出 4，
    //    于是「指向末行之后一位」的错引用被放过——正是本门禁唯一要抓的东西。
    expect(countLines('a\nb\nc\n')).toBe(3)
    expect('a\nb\nc\n'.split('\n').length).toBe(4) // 反例留在旁边，防止有人改回去
  })

  it('无结尾换行', () => {
    expect(countLines('a\nb\nc')).toBe(3)
  })

  it('空文件', () => {
    expect(countLines('')).toBe(0)
  })
})
