// console-drift.test.ts — #2629「运行态 vs 声明真相」对账的护栏。
//
// 守三件事：① 归属规则（专属/共享/forms 跳过）不能漂；② 三种判据的方向不能混
// （缺失=ERR、多余=WARN、孤儿只计数）；③ 清单不可读必须响亮失败（静默跳过 = 又一次观测面黑了）。

import { describe, expect, it } from 'vitest'
import { booksFor, countOrphanRuns, diffWorkspaces } from './console-drift.mjs'

describe('#2629 console 漂移对账', () => {
  it('归属规则：#531 账套后缀 = 专属；无后缀 = 共享族；forms.* = 与本两卷无关', () => {
    expect(booksFor('lemeng.request.order.l0.3120.json')).toEqual(['3120'])
    expect(booksFor('lemeng.request.order.l0.64188.json')).toEqual(['64188'])
    expect(booksFor('lemeng.retail.tick.l1.json')).toEqual(['3120', '64188'])
    expect(booksFor('forms.submission.l0.json')).toBeNull()
  })

  it('① 声明有、卷里没有 ⇒ ERR（部署没落地 / 有人手删）', () => {
    const out = diffWorkspaces(
      ['a.3120.json', 'shared.json'],
      { 3120: ['shared.json'] }, // 缺 a.3120.json
    )
    expect(out[0].ok).toBe(false)
    expect(out[0].detail).toContain('ERR')
    expect(out[0].detail).toContain('a.3120.json')
  })

  it('② 卷里多出 ⇒ WARN，且**不翻 ERR**（实验残留无害，但要可见）', () => {
    const out = diffWorkspaces(
      ['shared.json'],
      { 3120: ['shared.json', 'mvbf-3120-w0.json', 'tmp.fanout.exp.json'] },
    )
    expect(out[0].ok).toBe(true)
    expect(out[0].verdict).toBe('WARN')
    expect(out[0].detail).toContain('mvbf-3120-w0.json')
    expect(out[0].detail).toContain('extra=2')
  })

  it('归属规则必须两处同源：forms.* 不在仓清单里，也不该算「卷内多余」', () => {
    // 真机 2026-11-21：两卷里都留着 forms.submission.l0.json（forms 专属 console 建立前的分发残留）
    const out = diffWorkspaces(
      ['shared.json'],
      { 3120: ['shared.json', 'forms.submission.l0.json'] },
    )
    expect(out[0].verdict).toBeUndefined() // 不是 WARN——forms 与本卷无关
    expect(out[0].detail).toContain('extra=0')
  })

  it('③ 干净卷 ⇒ OK，且 detail 里带上孤儿 run 计数（可看趋势，不单独判红）', () => {
    const out = diffWorkspaces(['shared.json'], { 3120: ['shared.json'] }, { 3120: 7 })
    expect(out[0].ok).toBe(true)
    expect(out[0].verdict).toBeUndefined()
    expect(out[0].detail).toContain('orphanRuns=7')
  })

  it('账套隔离：3120 的专属件不该被要求出现在 64188 卷', () => {
    const out = diffWorkspaces(
      ['a.3120.json', 'b.64188.json'],
      { 3120: ['a.3120.json'], 64188: ['b.64188.json'] },
    )
    expect(out.every((v) => v.ok)).toBe(true)
  })

  it('清单不可读时 listJson 返回空数组（由 main 负责响亮失败，不在这里静默放过）', async () => {
    const mod = await import('./console-drift.mjs')
    expect(mod.listJson('/definitely/not/a/dir')).toEqual([])
  })

  it('孤儿 run 计数：runs/ 里有、pipelines/ 里没有', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    mkdirSync(join(ws, 'pipelines'))
    mkdirSync(join(ws, 'runs'))
    writeFileSync(join(ws, 'pipelines', 'keep.json'), '{}')
    writeFileSync(join(ws, 'runs', 'keep.json'), '[]')
    writeFileSync(join(ws, 'runs', 'orphan-a.json'), '[]')
    writeFileSync(join(ws, 'runs', 'orphan-b.json'), '[]')
    expect(countOrphanRuns(ws)).toEqual({ orphan: 2, total: 3 })
  })
})
