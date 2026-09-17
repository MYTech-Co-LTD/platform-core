// storage-probe.test.ts — 探测的**真网络栈**用例（M3c，Task 7）。
//
// 为什么单开一个文件：它要**铸真 socket**，admin.test.ts 的替身 harness（fakePool + mount）覆盖不到。
// 为什么必须有一条**不桩**的用例：admin.test.ts 里所有探测都是 `d.probe = async () => …` ——
// 那些用例证明的是「路由在拿到某个 ProbeResult 后做对了什么」，**一个字都没证明** classify() 的
// 映射在**真实 SDK 错误**上有效。桩掉探测 = 只证明「我们写了一个 catch」。本文件是那条断言的落点。
//
// 地址选 `127.0.0.1:1`：必然连不上（端口 1 无监听、不需要任何外部依赖、不依赖网络可达性），
// 且错误**确定**落在 CONNECT 档。
import { describe, expect, it } from 'vitest'
import { probeStorage } from './storage-probe'

describe('storage-probe：真网络栈失败分类（不桩）', () => {
  it('连不上 ⇒ ok:false / reason=CONNECT（分类映射在真实错误上有效）', async () => {
    const r = await probeStorage({
      kind: 's3', endpoint: 'http://127.0.0.1:1', region: 'x', bucket: 'b',
      accessKeyId: 'a', secretAccessKey: 'b',
    })
    expect(r).toMatchObject({ ok: false, reason: 'CONNECT' })
  })

  it('detail 只有 endpoint host 与错误码，**不含凭据、不含 SDK 原文**', async () => {
    const r = await probeStorage({
      kind: 's3', endpoint: 'http://127.0.0.1:1', region: 'x', bucket: 'b',
      accessKeyId: 'AKIALEAKME', secretAccessKey: 'sk-leak-me',
    })
    expect(r.ok).toBe(false)
    const detail = r.ok ? '' : r.detail
    expect(detail).toContain('127.0.0.1:1')       // host（含端口）
    expect(detail).not.toContain('AKIALEAKME')
    expect(detail).not.toContain('sk-leak-me')
    // SDK 原文形如 `connect ECONNREFUSED 127.0.0.1:1`——detail 里只能有「host: 码」，不能是整句
    expect(detail).not.toContain('connect ECONNREFUSED')
  })
})
