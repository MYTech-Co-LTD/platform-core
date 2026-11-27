// scripts/lemeng/retail-hot-gc.test.ts — GC 的**审计行**必须说真话（#2901）。
//
// 2026-11-27 实测：脚本真删了 347,678 行，却打印 `deleted=0`——因为 psql `-q` 抑制了
// `DELETE n` 命令标签，解析兜底到 '0'。那是最坏的一种「看起来很安全」：运维会以为 GC 没生效。
// 所以这里钉两件事：① SQL 必须是 `RETURNING` + `count(*)` 形态；② 解析器**不把「不知道」报成 0**。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDeleted } from './retail-hot-gc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'retail-hot-gc.mjs'), 'utf8')

describe('retail-hot-gc · 删除行数', () => {
  it('SQL 用 RETURNING + count(*)，不依赖 psql 命令标签', () => {
    expect(SRC).toContain('delete from staging.retail_hot')
    expect(SRC).toContain('returning 1')
    expect(SRC).toContain('select count(*) from d')
  })

  it('裸数字（-tAq 的实际输出）⇒ 原样取', () => {
    expect(parseDeleted('347678\n')).toBe('347678')
    expect(parseDeleted('0\n')).toBe('0')
  })

  it('旧形态 DELETE n 仍兼容', () => {
    expect(parseDeleted('DELETE 5\n')).toBe('5')
  })

  it('解析不出来 ⇒ "?"，绝不报 0', () => {
    expect(parseDeleted('')).toBe('?')
    expect(parseDeleted('psql: warning: something\n')).toBe('?')
  })
})
