// test-sign.ts — **测试专用**的票据签名器（只在 `*.test.ts` 里用，不在生产路径上）。
//
// 为什么不 import 模块的 `signEditHandoff`：代理与模块是两套部署单元（代理镜像里没有
// `modules/`，仓规 B1 也不许 apps/packages 依赖模块侧），所以这里逐字复刻 Task 1 的算法：
// **派生**子密钥（标签 `'edit-handoff-v1'` 逐字相同）+ HS256 + base64url，
// payload `{org,did,nonce,iat,exp}`。
//
// ⚠️ 必须走**派生**子密钥（不是原始 secret）：否则「坏签名 ⇒ null」那条会因为两侧密钥不同
//    而**恒真**（测不到东西——它红的原因从「签名错」变成了「密钥错」）。
import { createHmac } from 'node:crypto'

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

export function signForTest(
  input: { org: string; did: number; nonce: string },
  secret: string,
  ttlSec: number,
  now: number,
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    org: input.org, did: input.did, nonce: input.nonce, iat: now, exp: now + ttlSec,
  }))
  const key = createHmac('sha256', secret).update('edit-handoff-v1').digest()
  const sig = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
