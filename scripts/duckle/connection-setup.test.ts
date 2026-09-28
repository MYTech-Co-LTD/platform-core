// scripts/duckle/connection-setup.test.ts — 加密连接一次性 setup 的黑盒测试。
//
// 被测：`scripts/duckle/connection-setup.py`（在**容器内**跑的那一个；容器没有 node、没有
// `cryptography`，实现是纯 stdlib —— 依据见 report-mk-connection.md §1 的容器探测）。
//
// **黑盒**：spawn CLI，断言退出码 / 落盘文件 / 不泄漏明文。理由同 lint-architecture.test.ts——
// 门禁脚本的对外契约就是退出码与产物。
//
// **独立判读器**：本测试**不复用被测实现的任何代码**。密文用 `node:crypto`（OpenSSL）解开，
// 与被测的纯 Python 实现互为异源实现 —— 「自封的密文能被独立实现按同一 AAD 规则解开」才算
// 方案成立；同源自测（自己封、自己解）证明不了任何事。
// 最强的那一层证据不在这里，而在真引擎：report-mk-connection.md §3 用真 duckle 0.7.4
// 起了一条 `connectionRef` 最小管线，引擎自己把密文解开了。
import { spawnSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./connection-setup.py', import.meta.url))
const PY = process.env.PYTHON ?? 'python3'

/** 假凭据（lab 口径）：只在测试里用，永远不进生产。 */
const FAKE_S3 = {
  ZOS_ENDPOINT: 'oss-cn-lab.invalid:443',
  ZOS_ACCESS_KEY: 'FAKEAK_d41d8cd98f00b204',
  ZOS_SECRET_KEY: 'FAKESEC_2f9c1a7b4e6d8035',
  ZOS_BUCKET: 'lab-bucket',
  ZOS_REGION: 'cn-lab-1',
}
const FAKE_TOKEN = 'LABSEC_2f9c1a7b4e6d8035'

const tmpRoots: string[] = []

function tmpWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'duckle-connsetup-'))
  tmpRoots.push(ws)
  return ws
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(PY, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 按源码 crates/duckle-secrets/src/lib.rs 的 aad_for()：context + 0x1f + field。 */
function aadFor(context: string, field: string): Buffer {
  return Buffer.concat([Buffer.from(context, 'utf8'), Buffer.from([0x1f]), Buffer.from(field, 'utf8')])
}

/** 用 node:crypto（OpenSSL）解一条 `enc:v2:` token —— 与被测实现异源。 */
function openV2(token: string, key: Buffer, context: string, field: string): string {
  expect(token.startsWith('enc:v2:'), `token 必须以 enc:v2: 开头，实际 ${token.slice(0, 12)}…`).toBe(true)
  const raw = Buffer.from(token.slice('enc:v2:'.length), 'base64')
  const nonce = raw.subarray(0, 12)
  const body = raw.subarray(12)
  const tag = body.subarray(body.length - 16)
  const ct = body.subarray(0, body.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, nonce)
  d.setAAD(aadFor(context, field))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

// python3 缺席时明确 skip（并说明验证载体），不静默假绿。
const pyReady = spawnSync(PY, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']).status === 0
if (!pyReady) {
  // eslint-disable-next-line no-console
  console.warn(`[connection-setup] ${PY} 不可用（或 < 3.8）—— 本组用例 skip；验证在容器内与 /tmp lab 完成`)
}

describe.skipIf(!pyReady)('duckle 加密连接 setup 脚本', () => {
  it('把 env 里的凭据封成 enc:v2:，且独立实现（node:crypto）能按同一 AAD 解开', () => {
    const ws = tmpWs()
    const r = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3)
    expect(r.status, r.stderr).toBe(0)

    const file = join(ws, 'connections', 'zos.json')
    expect(existsSync(file)).toBe(true)
    const conn = readJson(file)

    // 非敏感字段保持明文（引擎要读它们）
    expect(conn.kind).toBe('s3')
    expect(conn.endpoint).toBe(FAKE_S3.ZOS_ENDPOINT)
    expect(conn.bucket).toBe(FAKE_S3.ZOS_BUCKET)
    expect(conn.region).toBe(FAKE_S3.ZOS_REGION)
    expect(conn.urlStyle).toBe('path')

    // 敏感字段必须是密文，且能被异源实现解开
    const key = readFileSync(join(ws, '.duckle', 'keys', 'secret.key'))
    expect(key.length).toBe(32)
    expect((statSync(join(ws, '.duckle', 'keys', 'secret.key')).mode & 0o777).toString(8)).toBe('600')

    expect(openV2(conn.accessKey as string, key, 'zos', 'accessKey')).toBe(FAKE_S3.ZOS_ACCESS_KEY)
    expect(openV2(conn.secretKey as string, key, 'zos', 'secretKey')).toBe(FAKE_S3.ZOS_SECRET_KEY)
  })

  it('AAD 绑定生效：换连接 id / 换字段名都解不开', () => {
    const ws = tmpWs()
    expect(run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3).status).toBe(0)
    const conn = readJson(join(ws, 'connections', 'zos.json'))
    const key = readFileSync(join(ws, '.duckle', 'keys', 'secret.key'))

    expect(() => openV2(conn.secretKey as string, key, 'other-id', 'secretKey')).toThrow()
    expect(() => openV2(conn.secretKey as string, key, 'zos', 'accessKey')).toThrow()
  })

  it('幂等：重复跑不改动已有密文（逐字节一致），也不换钥匙', () => {
    const ws = tmpWs()
    expect(run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3).status).toBe(0)
    const file = join(ws, 'connections', 'zos.json')
    const keyFile = join(ws, '.duckle', 'keys', 'secret.key')
    const before = readFileSync(file)
    const keyBefore = readFileSync(keyFile)

    const again = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3)
    expect(again.status, again.stderr).toBe(0)

    expect(readFileSync(file).equals(before)).toBe(true)
    expect(readFileSync(keyFile).equals(keyBefore)).toBe(true)
    expect(again.stdout + again.stderr).toMatch(/未改|unchanged/)
  })

  it('轮换：env 换值后重跑，密文随之更新且新值可解', () => {
    const ws = tmpWs()
    expect(run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3).status).toBe(0)
    const before = readFileSync(join(ws, 'connections', 'zos.json'), 'utf8')

    const rotated = { ...FAKE_S3, ZOS_SECRET_KEY: 'FAKESEC_rotated_value_9c1f' }
    const r = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], rotated)
    expect(r.status, r.stderr).toBe(0)

    const conn = readJson(join(ws, 'connections', 'zos.json'))
    expect(readFileSync(join(ws, 'connections', 'zos.json'), 'utf8')).not.toBe(before)
    const key = readFileSync(join(ws, '.duckle', 'keys', 'secret.key'))
    expect(openV2(conn.secretKey as string, key, 'zos', 'secretKey')).toBe(rotated.ZOS_SECRET_KEY)
    // 没有变化的字段不该被重封（accessKey 明文值未变 ⇒ 密文也不该变）
    expect(openV2(conn.accessKey as string, key, 'zos', 'accessKey')).toBe(FAKE_S3.ZOS_ACCESS_KEY)
  })

  it('rest-token 档：authToken 落密文，authType 留明文；id 可账套无关', () => {
    const ws = tmpWs()
    const r = run(
      ['--workspace', ws, '--id', 'lemeng', '--profile', 'rest-bearer', '--token-env', 'LEMENG_TOKEN'],
      { LEMENG_TOKEN: FAKE_TOKEN },
    )
    expect(r.status, r.stderr).toBe(0)
    const conn = readJson(join(ws, 'connections', 'lemeng.json'))
    expect(conn.kind).toBe('rest')
    expect(conn.authType).toBe('bearer')
    const key = readFileSync(join(ws, '.duckle', 'keys', 'secret.key'))
    expect(openV2(conn.authToken as string, key, 'lemeng', 'authToken')).toBe(FAKE_TOKEN)
  })

  it('绝不回显凭据值（stdout/stderr 全路径）', () => {
    const ws = tmpWs()
    const ok = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3)
    const dry = run(['--workspace', tmpWs(), '--id', 'zos', '--profile', 'zos-s3', '--dry-run'], FAKE_S3)
    const bad = run(['--workspace', tmpWs(), '--id', 'zos', '--profile', 'zos-s3'], {
      ...FAKE_S3,
      ZOS_SECRET_KEY: '',
    })
    for (const [name, r] of [['run', ok], ['dry-run', dry], ['missing-required', bad]] as const) {
      for (const secret of [FAKE_S3.ZOS_SECRET_KEY, FAKE_S3.ZOS_ACCESS_KEY]) {
        expect(r.stdout, `${name} stdout 泄漏了凭据`).not.toContain(secret)
        expect(r.stderr, `${name} stderr 泄漏了凭据`).not.toContain(secret)
      }
    }
    // 但指纹是允许且有意的：ops 靠它和引擎侧回显对账
    expect(ok.stdout).toContain(sha12(FAKE_S3.ZOS_SECRET_KEY))
  })

  it('缺必填来源 ⇒ 拒绝写文件并报键名（不是静默写一条空凭据连接）', () => {
    const ws = tmpWs()
    const r = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], {
      ...FAKE_S3,
      ZOS_SECRET_KEY: '',
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('secretKey')
    expect(existsSync(join(ws, 'connections', 'zos.json'))).toBe(false)
  })

  it('自检护栏：文件里还有明文敏感字段 ⇒ 非零退出并点名，且不打印值', () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'connections'), { recursive: true })
    // 故意留明文敏感字段（这正是「MCP create_connection 产出的连接」那种形态）
    const poisoned = {
      kind: 'rest',
      authType: 'bearer',
      authToken: FAKE_TOKEN,
      headers: { 'X-Api-Key': 'plain-and-leaky' },
    }
    const p = join(ws, 'connections', 'poisoned.json')
    writeFileSync(p, JSON.stringify(poisoned, null, 2))

    const r = run(['--check-only', p])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('authToken')
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN)
  })

  it('自检护栏：敏感键下挂非字符串值（源码的 transform 只封字符串）⇒ 也算留明文', () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'connections'), { recursive: true })
    const p = join(ws, 'connections', 'numeric.json')
    writeFileSync(p, JSON.stringify({ kind: 's3', secretKey: 12345678 }, null, 2))

    const r = run(['--check-only', p])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('secretKey')
    expect(r.stdout + r.stderr).not.toContain('12345678')
  })

  it('自检护栏对合规文件放行（--check-only 干净则 exit 0）', () => {
    const ws = tmpWs()
    expect(run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3).status).toBe(0)
    const r = run(['--check-only', join(ws, 'connections', 'zos.json')])
    expect(r.status, r.stdout + r.stderr).toBe(0)
  })

  it('${...} 占位符与已加密值跳过（幂等口径与源码 transform 一致）', () => {
    const ws = tmpWs()
    mkdirSync(join(ws, 'connections'), { recursive: true })
    const p = join(ws, 'connections', 'mixed.json')
    writeFileSync(
      p,
      JSON.stringify({ kind: 'rest', authType: 'bearer', authToken: '${ENV:LEMENG_TOKEN}', headers: {} }),
    )
    const r = run(['--workspace', ws, '--id', 'mixed', '--profile', 'none', '--set', 'kind=literal:rest'])
    // 幂等：占位符被原样保留，不当成明文
    expect(r.status, r.stderr).toBe(0)
    expect(readJson(p).authToken).toBe('${ENV:LEMENG_TOKEN}')
  })

  it('拒绝用 literal: 传敏感值（密钥不该出现在命令行/ps 里）', () => {
    const ws = tmpWs()
    const r = run([
      '--workspace', ws, '--id', 'x', '--profile', 'none',
      '--set', 'kind=literal:s3', `--set`, `secretKey=literal:${FAKE_TOKEN}`,
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('secretKey')
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN)
  })

  it('钥匙存在但不是 32 字节 ⇒ fail loud（不覆盖、也不静默换钥匙）', () => {
    const ws = tmpWs()
    mkdirSync(join(ws, '.duckle', 'keys'), { recursive: true })
    const kp = join(ws, '.duckle', 'keys', 'secret.key')
    writeFileSync(kp, 'short')
    const r = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3'], FAKE_S3)
    expect(r.status).not.toBe(0)
    expect(readFileSync(kp, 'utf8')).toBe('short')
  })

  it('--dry-run 不落任何文件', () => {
    const ws = tmpWs()
    const r = run(['--workspace', ws, '--id', 'zos', '--profile', 'zos-s3', '--dry-run'], FAKE_S3)
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(join(ws, 'connections', 'zos.json'))).toBe(false)
    expect(existsSync(join(ws, '.duckle', 'keys', 'secret.key'))).toBe(false)
  })
})
