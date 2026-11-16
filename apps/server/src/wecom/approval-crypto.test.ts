// approval-crypto.test.ts — 企微回调验签/AES 解密（OA P2 Task 3）
//
// 算法口径（企微官方 WXBizMsgCrypt，与 case-engine 参考实现一致，但本文件独立实现、不 import 私有包）：
//   签名：sha1( sort([token, timestamp, nonce, encrypt]).join('') ) 十六进制小写
//   解密：AES-256-CBC，key = base64(EncodingAESKey + '=')（32B），IV = key 前 16B，PKCS#7
//   明文：random(16B) + msgLen(4B 大端) + msg + receiveId
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptWecomEnvelope, verifyWecomSignature, wecomSignature } from './approval-crypto'

/**
 * 企微后台生成的 EncodingAESKey 形状：43 字符 base64（无 `=` 补位），解码恰好 32 字节。
 * 这里是一个固定的测试值（不是任何真实环境的凭据）。
 */
const AES_KEY = 'Xk3p9QzR7mT2vW8bY5nJ6cL1hF4dS0gA2eU7iK9oP3t'

/** 本地加密替身：按企微信封构造密文（仅测试用，生产只解密不加密）。 */
function encryptForTest(
  msg: string,
  opts: { aesKey?: string; receiveId?: string; random?: Buffer } = {},
): { key: string; encrypt: string; plain: string } {
  const aesKey = opts.aesKey ?? AES_KEY
  const key = Buffer.from(aesKey + '=', 'base64')
  const msgBuf = Buffer.from(msg, 'utf8')
  const msgLen = Buffer.alloc(4)
  msgLen.writeUInt32BE(msgBuf.length)
  const plain = Buffer.concat([
    opts.random ?? randomBytes(16),
    msgLen,
    msgBuf,
    Buffer.from(opts.receiveId ?? 'wx-test-corp', 'utf8'),
  ])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  const encrypt = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
  return { key: aesKey, encrypt, plain: msg }
}

describe('wecomSignature', () => {
  it('签名：sha1(sort(token,timestamp,nonce,encrypt)) 拼接后取 hex', () => {
    const sig = wecomSignature({ token: 't', timestamp: '1', nonce: 'n', encrypt: 'e' })
    expect(sig).toBe(createHash('sha1').update(['t', '1', 'n', 'e'].sort().join('')).digest('hex'))
  })

  it('排序是字典序、与入参顺序无关', () => {
    const a = wecomSignature({ token: 'zzz', timestamp: '100', nonce: 'aaa', encrypt: 'mmm' })
    const b = wecomSignature({ token: 'zzz', timestamp: '100', nonce: 'aaa', encrypt: 'mmm' })
    expect(a).toBe(b)
    expect(a).toBe(createHash('sha1').update(['100', 'aaa', 'mmm', 'zzz'].join('')).digest('hex'))
  })
})

describe('verifyWecomSignature', () => {
  const base = { token: 'token-1', timestamp: '1700000000', nonce: 'nonce-1', encrypt: 'ENCRYPT-BLOB' }
  const good = wecomSignature(base)

  it('签名正确 ⇒ true（msg_signature 与 signature 两种入参名都认）', () => {
    expect(verifyWecomSignature({ ...base, msgSignature: good })).toBe(true)
    expect(verifyWecomSignature({ ...base, signature: good })).toBe(true)
  })

  it('任一因子被篡改 ⇒ false（fail-closed）', () => {
    expect(verifyWecomSignature({ ...base, msgSignature: wecomSignature({ ...base, token: 'other' }) })).toBe(false)
    expect(verifyWecomSignature({ ...base, msgSignature: wecomSignature({ ...base, timestamp: '1700000001' }) })).toBe(false)
    expect(verifyWecomSignature({ ...base, msgSignature: wecomSignature({ ...base, nonce: 'nonce-2' }) })).toBe(false)
    expect(verifyWecomSignature({ ...base, msgSignature: wecomSignature({ ...base, encrypt: 'OTHER' }) })).toBe(false)
  })

  it('缺签名 / 长度不对 / 非 hex ⇒ false，不抛', () => {
    expect(verifyWecomSignature(base)).toBe(false)
    expect(verifyWecomSignature({ ...base, msgSignature: '' })).toBe(false)
    expect(verifyWecomSignature({ ...base, msgSignature: good.slice(0, 39) })).toBe(false)
    expect(verifyWecomSignature({ ...base, msgSignature: 'z'.repeat(40) })).toBe(false)
  })
})

describe('decryptWecomEnvelope', () => {
  it('解密：AES-256-CBC，IV=key 前 16B，PKCS#7（round-trip）', () => {
    const { key, encrypt, plain } = encryptForTest('hello')
    expect(decryptWecomEnvelope(encrypt, key)).toBe(plain)
  })

  it('只返回 msg：去掉随机 16B、msgLen 4B 与尾部 receiveId', () => {
    const xml = '<xml><Event><![CDATA[sys_approval_change]]></Event></xml>'
    const { encrypt } = encryptForTest(xml, { receiveId: 'ww0123456789abcdef' })
    expect(decryptWecomEnvelope(encrypt, AES_KEY)).toBe(xml)
  })

  it('中文 / CDATA 原样还原（UTF-8 长度按字节算）', () => {
    const xml = '<xml><SpName><![CDATA[差旅报销——北京]]></SpName><SpNo><![CDATA[SP20261116001]]></SpNo></xml>'
    const { encrypt } = encryptForTest(xml)
    expect(decryptWecomEnvelope(encrypt, AES_KEY)).toBe(xml)
  })

  it('43 字符 key 与带 `=` 的 44 字符 key 等价', () => {
    const { encrypt } = encryptForTest('hello')
    expect(decryptWecomEnvelope(encrypt, AES_KEY + '=')).toBe('hello')
  })

  it('echostr（非 XML 明文）默认不做 XML 形状校验——GET 验证要能解出原样字符串', () => {
    const echo = '1616140317555161061'
    const { encrypt } = encryptForTest(echo)
    expect(decryptWecomEnvelope(encrypt, AES_KEY)).toBe(echo)
  })

  it('expectXml=true 时非 XML 明文 ⇒ 抛（审批事件路径用）', () => {
    const { encrypt } = encryptForTest('not-xml')
    expect(() => decryptWecomEnvelope(encrypt, AES_KEY, { expectXml: true })).toThrow(/XML/i)
  })

  it('key 形状不对 ⇒ 抛', () => {
    const { encrypt } = encryptForTest('hello')
    expect(() => decryptWecomEnvelope(encrypt, 'too-short')).toThrow(/EncodingAESKey/i)
    // 长度对但含非 base64 字符 ⇒ 形状校验先拦下（而不是落到「解密失败」）
    expect(() => decryptWecomEnvelope(encrypt, '!'.repeat(43))).toThrow(/EncodingAESKey/i)
  })

  it('密文不是合法 base64 / 长度非 16 的倍数 / 截断 ⇒ 抛', () => {
    expect(() => decryptWecomEnvelope('not base64!!!', AES_KEY)).toThrow()
    expect(() => decryptWecomEnvelope(Buffer.alloc(15).toString('base64'), AES_KEY)).toThrow()
    const { encrypt } = encryptForTest('hello')
    const truncated = Buffer.from(encrypt, 'base64').subarray(0, 16).toString('base64')
    expect(() => decryptWecomEnvelope(truncated, AES_KEY)).toThrow()
  })

  it('msgLen 越界（信封损坏）⇒ 抛，不返回半截数据', () => {
    // 手工构造：random(16) + msgLen 声明 4096 但实际没有 msg
    const key = Buffer.from(AES_KEY + '=', 'base64')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(4096)
    const evil = Buffer.concat([randomBytes(16), len, Buffer.from('x')])
    const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
    const encrypt = Buffer.concat([cipher.update(evil), cipher.final()]).toString('base64')
    expect(() => decryptWecomEnvelope(encrypt, AES_KEY)).toThrow(/长度|msgLen|信封/)
  })

  // ---------------------------------------------------------------------------
  // T1 真实样本 known-answer：**显式 skip**，不得伪造真实样本。
  // T1（真实回调抓包）完成后，把脱敏后的 { encrypt, msgSignature, timestamp, nonce,
  // token, aesKey, 期望解析结果 } 落到 `./__fixtures__/approval-callback-t1.json`，
  // 再把本用例改成 it(...) 并读取该 fixture。T4 验收前必须补上。
  // ---------------------------------------------------------------------------
  it.skip('known-answer：T1 真实回调密文（待真实样本落 fixtures 后启用）', () => {
    // 真实样本不可用（T1 未完成），此处刻意不造假。
  })
})
