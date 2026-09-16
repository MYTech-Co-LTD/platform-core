// lib/format.test.ts — 展示层格式化（**不做任何金额推导**）
import { describe, expect, it } from 'vitest'
import { formatMinor } from './format'

describe('formatMinor', () => {
  it('整数分 → 元，保留两位', () => {
    expect(formatMinor(0)).toBe('¥0.00')
    expect(formatMinor(1)).toBe('¥0.01')
    expect(formatMinor(12345)).toBe('¥123.45')
  })

  it('null / undefined → 占位（端点未处理时该字段就是 null）', () => {
    expect(formatMinor(null)).toBe('—')
    expect(formatMinor(undefined)).toBe('—')
  })
})
