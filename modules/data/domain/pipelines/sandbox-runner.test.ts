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
/** 假时钟：sleep 推进时间（不然超时用例会真的等下去）。 */
const clock = () => {
  const state = { t: Date.now() }
  return { now: () => state.t, sleep: async (ms: number) => { state.t += ms } }
}

describe('createSandboxRunner', () => {
  it('成功路径：写草案 → async 起跑 → 轮询到 ok', async () => {
    const dir = await workspace()
    const { fetchImpl, seen } = fakeConsole([
      () => new Response('', { status: 202 }),
      () => json({ runs: [{ file: 'sandbox/sbx-1-a.json', status: 'running' }] }),
      () => json({ runs: [{ file: 'sandbox/sbx-1-a.json', status: 'ok', durationMs: 42, rows: 7 }] }),
    ])
    const c = clock()
    const runner = createSandboxRunner(
      { baseUrl: 'http://sandbox-console:18090', token: 'tok-test', dir, timeoutMs: 3_000, intervalMs: 100 },
      { fetchImpl, now: c.now, sleep: c.sleep },
    )

    const out = await runner.run(draft, 'sbx-1-a')

    expect(out).toEqual({ status: 'ok', runId: 'sbx-1-a', file: 'sandbox/sbx-1-a.json', durationMs: 42, rows: 7 })
    // 草案落在共享卷上，且是合法 JSON
    expect(JSON.parse(await readFile(join(dir, 'sandbox', 'sbx-1-a.json'), 'utf8'))).toEqual(draft)
    // 起跑那一次：POST + Bearer + 工作区相对路径
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('http://sandbox-console:18090/api/run/async')
    expect(seen[0].auth).toBe('Bearer tok-test')
    expect(JSON.parse(seen[0].body)).toEqual({ file: 'sandbox/sbx-1-a.json' })
    // 轮询走 /api/runs
    expect(seen[1].url).toBe('http://sandbox-console:18090/api/runs')
  })

  it('管线跑失败 ⇒ failed + 引擎错误原文（不是抛）', async () => {
    const dir = await workspace()
    const { fetchImpl } = fakeConsole([
      () => new Response('', { status: 202 }),
      () => json({ runs: [{ file: 'sandbox/sbx-2-a.json', status: 'error', error: 'Data contract violated: in_range(exit_code)' }] }),
    ])
    const c = clock()
    const runner = createSandboxRunner(
      { baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 3_000, intervalMs: 0 },
      { fetchImpl, now: c.now, sleep: c.sleep },
    )
    const out = await runner.run(draft, 'sbx-2-a')
    expect(out.status).toBe('failed')
    expect(out.error).toContain('Data contract violated')
  })

  it('一直 running ⇒ 超时回 running（不判失败）', async () => {
    const dir = await workspace()
    const { fetchImpl, seen } = fakeConsole([
      () => new Response('', { status: 202 }),
      () => json({ runs: [{ file: 'sandbox/sbx-3-a.json', status: 'running' }] }),
    ])
    const c = clock()
    const runner = createSandboxRunner(
      { baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 500, intervalMs: 100 },
      { fetchImpl, now: c.now, sleep: c.sleep },
    )
    const out = await runner.run(draft, 'sbx-3-a')
    expect(out).toEqual({ status: 'running', runId: 'sbx-3-a', file: 'sandbox/sbx-3-a.json' })
    // 有界：不是死循环（起跑 1 次 + 轮询若干次）
    expect(seen.length).toBeLessThan(20)
  })

  it('回执先到 ⇒ 用回执（带逐节点明细）收敛，不依赖 /api/runs 是否收录该文件', async () => {
    const dir = await workspace()
    const receipts = join(dir, 'runs', 'receipts')
    await mkdir(receipts, { recursive: true })
    const { fetchImpl } = fakeConsole([
      () => new Response('', { status: 202 }),
      // console 的 /api/runs 不认 sandbox/ 下的文件（实测未证）⇒ 只靠回执也必须能收敛
      async () => {
        await writeFile(join(receipts, 'run-manual-lemeng.x.y-1700000000000.json'), JSON.stringify({
          status: 'ok',
          startedAt: new Date(Date.now() - 30).toISOString(),
          finishedAt: new Date().toISOString(),
          nodes: { source: { rows: 3 }, sink: { rows: 3 } },
        }))
        return json({ runs: [] })
      },
    ])
    const c = clock()
    const runner = createSandboxRunner(
      { baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 1_000, intervalMs: 100 },
      { fetchImpl, now: c.now, sleep: c.sleep },
    )
    const out = await runner.run(draft, 'sbx-4-a')
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
    const { fetchImpl } = fakeConsole([
      () => new Response('', { status: 202 }),
      () => json({ runs: [] }),
    ])
    const c = clock()
    const runner = createSandboxRunner(
      { baseUrl: 'http://x:1', token: 't', dir, timeoutMs: 300, intervalMs: 100 },
      { fetchImpl, now: c.now, sleep: c.sleep },
    )
    expect((await runner.run(draft, 'sbx-5-a')).status).toBe('running')
  })

  it('401 / 网络错误 ⇒ 抛 SandboxUnreachableError（跑不了 ≠ 跑失败）', async () => {
    const dir = await workspace()
    const unauth = fakeConsole([() => json({ error: 'unauthorized' }, 401)])
    const r1 = createSandboxRunner(
      { baseUrl: 'http://x:1', token: '', dir, timeoutMs: 100, intervalMs: 0 },
      { fetchImpl: unauth.fetchImpl },
    )
    await expect(r1.run(draft, 'sbx-6-a')).rejects.toBeInstanceOf(SandboxUnreachableError)

    const dir2 = await workspace()
    const netErr = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const r2 = createSandboxRunner({ baseUrl: 'http://x:1', token: 't', dir: dir2, timeoutMs: 100, intervalMs: 0 }, { fetchImpl: netErr })
    await expect(r2.run(draft, 'sbx-6-b')).rejects.toBeInstanceOf(SandboxUnreachableError)
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
