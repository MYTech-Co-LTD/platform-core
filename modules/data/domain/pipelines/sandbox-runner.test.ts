import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandboxRunner, SandboxUnreachableError, sandboxRunnerFromEnv } from './sandbox-runner'

const draft = { name: 'lemeng.x.y', nodes: [], edges: [] }

/** 每次调用一个新的临时工作区（真读盘，只有网络是假的）。 */
const workspace = () => mkdtemp(join(tmpdir(), 'sandbox-runner-'))

interface Rec { url: string; method: string; auth: string; body: string }
/** 假 console：按调用次序回放响应，记下每次请求（含鉴权头与请求体）。 */
const fakeConsole = (script: ((req: Rec, i: number) => Response | Promise<Response>)[]) => {
  const seen: Rec[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const rec: Rec = {
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.authorization ?? '',
      body: typeof init?.body === 'string' ? init.body : '',
    }
    const i = seen.length
    seen.push(rec)
    const step = script[i] ?? script[script.length - 1]
    if (step === undefined) throw new Error(`unexpected request #${i}: ${rec.method} ${rec.url}`)
    return step(rec, i)
  }) as unknown as typeof fetch
  return { fetchImpl, seen }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
/** 超时的真实形状：`AbortSignal.timeout` 让 fetch 以 TimeoutError 拒绝。 */
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })

const sinkDraft = {
  name: 'lemeng.x.y',
  nodes: [
    { id: 's1', type: 'source' },
    { id: 'k1', type: 'sink' },
  ],
  edges: [],
}

describe('createSandboxRunner', () => {
  it('成功路径：写草案 → 一次同步 /api/run → ok（带逐节点结果与引擎 runId）', async () => {
    const dir = await workspace()
    const { fetchImpl, seen } = fakeConsole([
      () => json({
        id: 'lemeng.x.y', runId: 'run-manual-lemeng.x.y-1700000000000', status: 'ok', durationMs: 42, error: null,
        nodes: [{ id: 's1', status: 'ok', rows: 3, durationMs: 5 }, { id: 'k1', status: 'ok', rows: 3, durationMs: 7 }],
      }),
    ])
    const runner = createSandboxRunner(
      { baseUrl: 'http://sandbox-console:18090', token: 'tok-test', dir, timeoutMs: 3_000 },
      { fetchImpl },
    )

    const out = await runner.run(sinkDraft, 'sbx-1-a')

    expect(out).toMatchObject({
      status: 'ok', runId: 'sbx-1-a', file: 'sandbox/sbx-1-a.json',
      engineRunId: 'run-manual-lemeng.x.y-1700000000000', durationMs: 42, rows: 3,
    })
    expect(out.nodes).toEqual([
      { id: 's1', status: 'ok', rows: 3, durationMs: 5 },
      { id: 'k1', status: 'ok', rows: 3, durationMs: 7 },
    ])
    // 草案落在共享卷上，且是合法 JSON
    expect(JSON.parse(await readFile(join(dir, 'sandbox', 'sbx-1-a.json'), 'utf8'))).toEqual(sinkDraft)
    // 只发一次：POST 同步 /api/run + Bearer + 工作区相对路径（不再起跑后轮询）
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('http://sandbox-console:18090/api/run')
    expect(seen[0].auth).toBe('Bearer tok-test')
    expect(JSON.parse(seen[0].body)).toEqual({ file: 'sandbox/sbx-1-a.json' })
  })

  it('管线跑失败 ⇒ failed + 引擎错误原文（不是抛）', async () => {
    const dir = await workspace()
    const { fetchImpl } = fakeConsole([
      () => json({ id: 'x', runId: 'r1', status: 'error', durationMs: 9, error: 'Data contract violated: in_range(exit_code)', nodes: [] }),
    ])
    const runner = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 3_000 }, { fetchImpl })
    const out = await runner.run(draft, 'sbx-2-a')
    expect(out.status).toBe('failed')
    expect(out.error).toContain('Data contract violated')
  })

  it('引擎 400 ⇒ parse_error + 引擎原话（一个节点都没跑）', async () => {
    const dir = await workspace()
    const { fetchImpl } = fakeConsole([
      () => json({ error: 'parse sandbox/sbx-3-a.json: missing field `label`' }, 400),
    ])
    const runner = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 3_000 }, { fetchImpl })
    const out = await runner.run(draft, 'sbx-3-a')
    expect(out).toMatchObject({ status: 'parse_error', runId: 'sbx-3-a' })
    expect(out.error).toContain('missing field `label`')
  })

  it('等待预算耗尽 ⇒ timeout（不说「还在跑」）', async () => {
    const dir = await workspace()
    const fetchImpl = (async () => { throw timeoutError() }) as unknown as typeof fetch
    const runner = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 500 }, { fetchImpl })
    const out = await runner.run(draft, 'sbx-4-a')
    expect(out).toEqual({ status: 'timeout', runId: 'sbx-4-a', file: 'sandbox/sbx-4-a.json' })
  })

  it('预算耗尽前刚好跑完 ⇒ 用新回执捡回结果（带逐节点明细）', async () => {
    const dir = await workspace()
    const receipts = join(dir, 'runs', 'receipts')
    await mkdir(receipts, { recursive: true })
    const fetchImpl = (async () => {
      await writeFile(join(receipts, 'run-manual-lemeng.x.y-1700000000000.json'), JSON.stringify({
        status: 'ok',
        startedAt: new Date(Date.now() - 30).toISOString(),
        finishedAt: new Date().toISOString(),
        nodes: { source: { rows: 3 }, sink: { rows: 3 } },
      }))
      throw timeoutError()
    }) as unknown as typeof fetch
    const runner = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 1_000 }, { fetchImpl })
    const out = await runner.run(draft, 'sbx-5-a')
    expect(out.status).toBe('ok')
    expect(out.rows).toBe(3)
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
    expect(out.nodes).toMatchObject({ sink: { rows: 3 } })
  })

  it('旧的回执不认领（开始前就在的不算本次结果）', async () => {
    const dir = await workspace()
    const receipts = join(dir, 'runs', 'receipts')
    await mkdir(receipts, { recursive: true })
    await writeFile(join(receipts, 'run-manual-old.json'), JSON.stringify({ status: 'ok', nodes: {} }))
    const fetchImpl = (async () => { throw timeoutError() }) as unknown as typeof fetch
    const runner = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 300 }, { fetchImpl })
    expect((await runner.run(draft, 'sbx-6-a')).status).toBe('timeout')
  })

  it('401 / 网络错误 ⇒ 抛 SandboxUnreachableError（跑不了 ≠ 跑失败）', async () => {
    const dir = await workspace()
    const unauth = fakeConsole([() => json({ error: 'unauthorized' }, 401)])
    const r1 = createSandboxRunner({ baseUrl: 'http://x:1', token: '', dir, timeoutMs: 100 }, { fetchImpl: unauth.fetchImpl })
    await expect(r1.run(draft, 'sbx-7-a')).rejects.toBeInstanceOf(SandboxUnreachableError)

    const dir2 = await workspace()
    const netErr = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const r2 = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir: dir2, timeoutMs: 100 }, { fetchImpl: netErr })
    await expect(r2.run(draft, 'sbx-7-b')).rejects.toBeInstanceOf(SandboxUnreachableError)
  })

  it('拒绝非法 runId（它会变成文件名主干）', async () => {
    const dir = await workspace()
    const runner = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 100 }, { fetchImpl: (async () => json({})) as unknown as typeof fetch })
    await expect(runner.run(draft, '../../etc/passwd')).rejects.toThrow('非法 runId')
    // 什么也没写出去
    await expect(readdir(dir)).resolves.toEqual([])
  })
})

describe('sandboxRunnerFromEnv', () => {
  it('未配 DATA_SANDBOX_URL ⇒ null（seam 语义不变）', () => {
    expect(sandboxRunnerFromEnv({})).toBeNull()
    expect(sandboxRunnerFromEnv({ DATA_SANDBOX_URL: '   ' })).toBeNull()
  })
  it('配了 URL ⇒ runner（默认目录与 compose 挂载一致）', async () => {
    const runner = sandboxRunnerFromEnv({ DATA_SANDBOX_URL: 'http://sandbox-console:18090/' })
    expect(runner).not.toBeNull()
    // 默认 dir 的文件名下落可观测：写一次草案即建出 sandbox/ 目录
    // （默认目录是容器内绝对路径，测试机上不可写 ⇒ 这里只验构造，不验落盘）
  })
})
