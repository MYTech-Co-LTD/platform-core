// approval-crypto.ts — 企微回调验签 / AES 解密（OA P2 Task 3）
//
// 独立实现，只依赖 Node 内置 crypto；**不 import、不复制** case-engine 私有包
// （参考实现仅用于口径核对，见 case-engine/core/decision-gate/src/wecom.ts）。
//
// 口径（企微官方 WXBizMsgCrypt）：
//   签名：sha1( sort([token, timestamp, nonce, encrypt]).join('') )，十六进制小写
//   解密：AES-256-CBC；key = base64(EncodingAESKey + '=')（32 字节）；IV = key 前 16 字节；
//         PKCS#7 填充；明文 = random(16B) + msgLen(4B 大端) + msg + receiveId
//
// 使用方：
//   - GET 回调验证：解密 `echostr`（明文通常是随机数字串，**不是 XML**）⇒ 用默认选项；
//   - POST 审批事件：解密 inner XML ⇒ 传 `{ expectXml: true }` 收紧形状（fail-closed）。
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

/** 验签四因子（顺序无关，内部按字典序排序后拼接）。 */
export interface WecomSignatureInput {
  /** 回调配置里的 Token（明文只在 env/tenant 列，代码不落日志）。 */
  token: string
  /** 回调 query 里的 timestamp（按原样参与签名，不做数值化）。 */
  timestamp: string
  /** 回调 query 里的 nonce。 */
  nonce: string
  /** 回调 query 里的 msg_signature 对应密文：GET 时是 echostr，POST 时是 Encrypt。 */
  encrypt: string
}

/** 计算企微回调签名（sha1 hex）。 */
export function wecomSignature(input: WecomSignatureInput): string {
  const sorted = [input.token, input.timestamp, input.nonce, input.encrypt].sort()
  return createHash('sha1').update(sorted.join('')).digest('hex')
}

/**
 * 校验企微回调签名（fail-closed：缺签名 / 形状不对 / 不相等一律 false，绝不抛）。
 * `msg_signature` 是 query 里的真实名字；`signature` 是兼容旧调用方的别名。
 */
export function verifyWecomSignature(
  input: WecomSignatureInput & { msgSignature?: string; signature?: string },
): boolean {
  const provided = input.msgSignature ?? input.signature
  if (!provided) return false
  // 只接受 40 位十六进制：既挡注入，也让 timingSafeEqual 的等长前提恒成立。
  if (!/^[0-9a-f]{40}$/i.test(provided)) return false
  const expected = Buffer.from(wecomSignature(input), 'hex')
  const actual = Buffer.from(provided.toLowerCase(), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export interface DecryptOptions {
  /**
   * 是否要求明文以 `<xml>` 开头。审批事件必须开；GET 的 echostr 必须关。
   * 默认 false —— 默认值服务于 echostr，调用方对事件路径显式开启。
   */
  expectXml?: boolean
}

/** EncodingAESKey（43 字符 base64，可带一个 `=`）→ 32 字节 AES key。 */
function decodeAesKey(aesKey: string): Buffer {
  const raw = aesKey.trim()
  // 32 字节 base64 恒为 43 字符 + 1 个 '='；企微后台只给 43 字符（无 '='）。
  const base64 = raw.length === 43 ? `${raw}=` : raw
  if (!/^[A-Za-z0-9+/]{43}=$/.test(base64)) {
    throw new Error('EncodingAESKey 非法：应为 43 字符 base64（无填充）或 44 字符（带一个 =）')
  }
  const key = Buffer.from(base64, 'base64')
  if (key.length !== 32) throw new Error('EncodingAESKey 非法：base64 解码后必须是 32 字节')
  return key
}

/**
 * 解密企微信封，返回 msg 明文（不含 16B 随机数 / 4B msgLen / 尾部 receiveId）。
 * 任何形状异常都抛错（由调用方 fail-closed 处理），不返回半截数据。
 */
export function decryptWecomEnvelope(encrypt: string, aesKey: string, options: DecryptOptions = {}): string {
  const key = decodeAesKey(aesKey)

  if (!encrypt || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypt)) {
    throw new Error('企微回调密文非法：不是合法的 base64')
  }
  const cipherText = Buffer.from(encrypt, 'base64')
  if (cipherText.length === 0 || cipherText.length % 16 !== 0) {
    throw new Error('企微回调密文非法：长度必须是 16 的正整数倍')
  }

  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  let plain: Buffer
  try {
    // Node/OpenSSL 默认按 PKCS#7 去填充；填充非法时 final() 抛错。
    plain = Buffer.concat([decipher.update(cipherText), decipher.final()])
  } catch {
    throw new Error('企微回调解密失败：密钥不匹配或密文损坏（PKCS#7 校验未通过）')
  }

  if (plain.length < 20) {
    throw new Error('企微信封长度不足：缺少随机 16 字节 + msgLen 4 字节')
  }
  const msgLen = plain.readUInt32BE(16)
  const available = plain.length - 20
  if (msgLen > available) {
    throw new Error(`企微信封损坏：msgLen(${msgLen}) 超出可用长度(${available})`)
  }
  const msg = plain.subarray(20, 20 + msgLen).toString('utf8')

  if (options.expectXml && !/^\s*(?:<\?xml[^>]*\?>\s*)?<xml[\s>]/i.test(msg)) {
    throw new Error('企微回调明文不是 XML（<xml> 开头校验失败）')
  }
  return msg
}
