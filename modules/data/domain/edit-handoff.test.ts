import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { signEditHandoff } from './edit-handoff'

const SECRET = 'test-secret-test-secret-test-secret!'

/** 独立解出 payload（不依赖被测实现的 decode 函数——那是自证） */
function payloadOf(token: string): Record<string, unknown> {
  const [h, p] = token.split('.')
  expect(h).toBe(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'))
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
}

describe('edit-handoff 票据', () => {
  it('payload 字段与 TTL：org/did/nonce + exp-iat=120', () => {
    const now = 1_700_000_000
    const t = signEditHandoff({ org: 'acme', did: 42, nonce: 'n-1' }, SECRET, 120, now)
    const p = payloadOf(t)
    expect(p).toMatchObject({ org: 'acme', did: 42, nonce: 'n-1', iat: now, exp: now + 120 })
  })

  it('签名是 HS256(secret)（用 node:crypto 独立复算，钉死算法与密钥编码）', () => {
    const t = signEditHandoff({ org: 'acme', did: 7, nonce: 'n-2' }, SECRET, 120, 1_700_000_000)
    const [h, p, s] = t.split('.')
    const expectSig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
    expect(s).toBe(expectSig)
  })

  it('★ 金样本（跨实现契约）：同一输入必须给出同一 token 串', () => {
    // 这串同时出现在 apps/mb-proxy/src/handoff.test.ts 里（Task 3）。
    // 任一侧改格式 ⇒ 另一侧红。改这一行必须同时改另一处。
    const t = signEditHandoff({ org: 'acme', did: 7, nonce: 'golden' }, SECRET, 120, 1_700_000_000)
    expect(t).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmciOiJhY21lIiwiZGlkIjo3LCJub25jZSI6ImdvbGRlbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMTIwfQ.lrJSexm5ecq0FA87205P6omvuyGm_ybdzn09xWp2C8U',
    )   // ← 实跑回填；同一串必须出现在 apps/mb-proxy/src/handoff.test.ts（Task 3）
  })
})
