import { describe, expect, it } from 'vitest'
import { verifySession } from '@platform/auth-core'

// Task 1 回填的金样本（与 modules/data/domain/edit-handoff.test.ts 同一串、与代理侧测试同一串）
const GOLDEN_HANDOFF =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmciOiJhY21lIiwiZGlkIjo3LCJub25jZSI6ImdvbGRlbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMTIwfQ.oSuZ8-zjA2GF42ugFh-KgGgMGHhRrqZHi2oTtAVX3xE'
const SECRET = 'test-secret-test-secret-test-secret!'

describe('★ 票据与会话互不承认（域分隔，评审 I-1）', () => {
  it('编辑票据**不得**被 verifySession 接受（否则会被续签分支放大成 7 天会话）', async () => {
    expect(await verifySession(GOLDEN_HANDOFF, SECRET)).toBeNull()
  })
})
