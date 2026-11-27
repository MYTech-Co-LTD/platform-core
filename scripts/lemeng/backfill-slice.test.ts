// scripts/lemeng/backfill-slice.test.ts — 回填切片驱动（#2742 第③刀）的纯函数机检。
//
// 钉三件事：
//   ① 队列解析对**手维文本**宽容但**不猜**：坏行进 bad、未知 flag 只告警不传；
//   ② 执行体参数与宿主脚本同源，唯一差别是 `--max-days 1`（这就是「切片」）；
//   ③ `BF_DONE ok=0` 的两种含义必须能分开（全部已存在 vs 窗口关空转）——
//      2026-11-08 的假绿就是这里看不出来，15 条任务 3 秒「全 OK」。
import { describe, expect, it } from 'vitest'
import { buildArgs, parseQueue, summarize } from './backfill-slice.mjs'

describe('backfill-slice · 队列解析', () => {
  const text = [
    '# 注释行',
    '',
    'transfer_in                    3120 2026-11-02 2026-11-07',
    'business_collection_coupon     3120 2024-11-01 2025-02-01 allow-empty',
    'bad line without dates',
    'x 3120 2026-11-01 2026-11-02 weird-flag',
  ].join('\n')

  it('只取有效行，坏行进 bad', () => {
    const { items, bad } = parseQueue(text)
    expect(items.map((i) => i.dataset)).toEqual(['transfer_in', 'business_collection_coupon', 'x'])
    expect(bad).toEqual(['bad line without dates'])
  })

  it('flag 白名单：只认 allow-empty，未知的进 unknownFlags 且不传', () => {
    const { items, unknownFlags } = parseQueue(text)
    expect(items.find((i) => i.dataset === 'x')?.flags).toEqual([])
    expect(unknownFlags).toEqual(['x weird-flag'])
  })

  it('空/无内容 ⇒ 空队列（不抛）', () => {
    expect(parseQueue('').items).toEqual([])
    expect(parseQueue(undefined).items).toEqual([])
  })
})

describe('backfill-slice · 执行体参数', () => {
  it('与宿主脚本同源，唯一差别是 --max-days 1', () => {
    const args = buildArgs({ dataset: 'transfer_in', book: '3120', from: '2026-11-02', to: '2026-11-07', flags: [] })
    expect(args).toEqual([
      'scripts/lemeng/backfill-history.py',
      '--dataset', 'transfer_in',
      '--books', '3120',
      '--from', '2026-11-02',
      '--to', '2026-11-07',
      '--apply', '--skip-existing', '--continue-on-fail',
      '--max-days', '1',
    ])
  })

  it('allow-empty 透传', () => {
    const args = buildArgs({ dataset: 'd', book: '1', from: '2026-01-01', to: '2026-01-02', flags: ['allow-empty'] })
    expect(args).toContain('--allow-empty')
  })
})

describe('backfill-slice · 输出归类', () => {
  it('真推进：ok=1', () => {
    expect(summarize('BF_PLAN day=x\nBF_DONE ok=1 empty=0 failed=0')).toMatchObject({ ok: 1, failed: 0 })
  })

  it('★ ok=0 的两种含义要能分开：全部已存在 vs 窗口关空转', () => {
    const allExist = summarize('BF_SKIP_EXISTING day=1\nBF_DONE ok=0 empty=0 failed=0')
    const windowClosed = summarize('BF_WINDOW_CLOSED cst=8\nBF_DONE ok=0 empty=0 failed=0')
    expect(allExist.skipped).toBe(1)
    expect(allExist.windowClosed).toBe(false)
    expect(windowClosed.skipped).toBe(0)
    expect(windowClosed.windowClosed).toBe(true)
  })

  it('失败计数', () => {
    expect(summarize('BF_DAY_FAILED day=1\nBF_DONE ok=0 empty=0 failed=2').failed).toBe(2)
  })
})
