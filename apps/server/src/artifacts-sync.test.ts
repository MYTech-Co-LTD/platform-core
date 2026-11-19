// artifacts-sync.test.ts — 数据面产物同步的纯判据 + 一轮同步的行为。
//
// 不连网、不写真目录以外的东西：`fetchImpl` 用桩，本地目录用 `os.tmpdir()` 下的临时目录。
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseArtifactsSyncConfig, parseRunDirs, planDownloads, syncOnce, type RemoteEntry,
} from './artifacts-sync'

const dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'artifacts-sync-'))
  dirs.push(d)
  return d
}
afterEach(() => { dirs.length = 0 })

const entry = (name: string, size: number, mtime = 'Wed, 19 Nov 2026 01:32:00 GMT'): RemoteEntry =>
  ({ name, type: 'file', mtime, size })

describe('parseRunDirs（与模块同源，畸形整份作废）', () => {
  it('正常解析；空串 ⇒ 空数组', () => {
    expect(parseRunDirs('3120=/a,64188=/b')).toEqual([
      { book: '3120', dir: '/a' }, { book: '64188', dir: '/b' },
    ])
    expect(parseRunDirs('')).toEqual([])
    expect(parseRunDirs(undefined)).toEqual([])
  })

  it('★ 任一条目畸形 ⇒ 整份作废（不悄悄少一个账套）', () => {
    expect(parseRunDirs('3120=/a,64188')).toEqual([])
    expect(parseRunDirs('3120=/a,=/b')).toEqual([])
    expect(parseRunDirs('3120=/a,64188=')).toEqual([])
  })
})

describe('parseArtifactsSyncConfig', () => {
  it('未配 baseUrl ⇒ null（fail-closed）', () => {
    expect(parseArtifactsSyncConfig({})).toBeNull()
    expect(parseArtifactsSyncConfig({ ARTIFACTS_BASE_URL: '' })).toBeNull()
  })

  it('dbt 目录由 DATA_DBT_MANIFEST_PATH 的 dirname 推出（与模块同一事实源）', () => {
    const cfg = parseArtifactsSyncConfig({
      ARTIFACTS_BASE_URL: 'http://10.0.0.5:18090/',
      DATA_RUN_DIRS: '3120=/tmp/runs/3120',
      DATA_DBT_MANIFEST_PATH: '/tmp/dbt/manifest.json',
    })
    expect(cfg?.baseUrl).toBe('http://10.0.0.5:18090') // 去掉尾斜杠
    expect(cfg?.runs).toEqual([{ book: '3120', dir: '/tmp/runs/3120' }])
    expect(cfg?.dbtDir).toBe('/tmp/dbt')
  })

  it('间隔：非正整数/过小 ⇒ 回退 60000（宁可慢，不要打成轮询风暴）', () => {
    const base = { ARTIFACTS_BASE_URL: 'http://x' }
    expect(parseArtifactsSyncConfig({ ...base, ARTIFACTS_SYNC_INTERVAL_MS: '1000' })?.intervalMs).toBe(60000)
    expect(parseArtifactsSyncConfig({ ...base, ARTIFACTS_SYNC_INTERVAL_MS: 'abc' })?.intervalMs).toBe(60000)
    expect(parseArtifactsSyncConfig({ ...base, ARTIFACTS_SYNC_INTERVAL_MS: '30000' })?.intervalMs).toBe(30000)
  })
})

describe('planDownloads（纯判据）', () => {
  it('缺失 / 大小不同 / mtime 差 >1s ⇒ 拉；相同 ⇒ 不拉', () => {
    const remote = [entry('a.json', 10), entry('b.json', 20), entry('c.json', 30)]
    const local = (n: string) => {
      if (n === 'a.json') return null                       // 缺失
      if (n === 'b.json') return { size: 21, mtimeMs: Date.parse('Wed, 19 Nov 2026 01:32:00 GMT') } // 大小不同
      return { size: 30, mtimeMs: Date.parse('Wed, 19 Nov 2026 01:32:00 GMT') }                     // 一致
    }
    expect(planDownloads(remote, local)).toEqual(['a.json', 'b.json'])
  })

  it('★ 文件名白名单：目录项 / 非 json / 带路径一律跳过（远端不该有，但客户端也不许被它带偏）', () => {
    const remote = [
      entry('ok.json', 1),
      { name: '..', type: 'directory', mtime: '', size: 0 },
      entry('evil.txt', 1),
      entry('../escape.json', 1),
    ]
    expect(planDownloads(remote, () => null)).toEqual(['ok.json'])
  })

  it('mtime 抖动 ≤1s 不重拉（nginx 精确到秒）', () => {
    const remote = [entry('a.json', 10, 'Wed, 19 Nov 2026 01:32:00 GMT')]
    const local = () => ({ size: 10, mtimeMs: Date.parse('Wed, 19 Nov 2026 01:32:00 GMT') + 400 })
    expect(planDownloads(remote, local)).toEqual([])
  })
})

describe('syncOnce（一轮同步）', () => {
  /** 极简 fetch 桩：`/runs/<book>/` 返回列表，其它路径返回文件内容。 */
  function fakeFetch(files: Record<string, string>, listByDir: Record<string, RemoteEntry[]>) {
    const calls: string[] = []
    const impl = (async (url: string) => {
      const path = url.replace('http://x', '')
      calls.push(path)
      const list = listByDir[path]
      if (list !== undefined) {
        return { ok: true, status: 200, json: async () => list } as unknown as Response
      }
      const body = files[path]
      if (body === undefined) return { ok: false, status: 404 } as unknown as Response
      return {
        ok: true, status: 200,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      } as unknown as Response
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('缺的文件拉下来、写入目标目录；已齐的下次不再拉', async () => {
    const root = await tmp()
    const runsDir = join(root, 'runs', '3120')
    await mkdir(runsDir, { recursive: true })
    await writeFile(join(runsDir, 'old.json'), 'x')
    const dbtDir = join(root, 'dbt')
    const cfg = {
      baseUrl: 'http://x', token: 't',
      runs: [{ book: '3120', dir: runsDir }],
      dbtDir,
      intervalMs: 60000,
    }
    const { impl } = fakeFetch(
      { '/runs/3120/new.json': '{"a":1}', '/dbt/manifest.json': '{"nodes":{}}' },
      {
        '/runs/3120/': [entry('new.json', 7)],
        '/dbt/': [entry('manifest.json', 12)],
      },
    )
    const r1 = await syncOnce(cfg, { fetchImpl: impl, log: () => {} })
    expect(r1).toMatchObject({ fetched: 2, failed: 0, errors: 0 })
    expect(JSON.parse(await readFile(join(runsDir, 'new.json'), 'utf8'))).toEqual({ a: 1 })
    expect(await readFile(join(dbtDir, 'manifest.json'), 'utf8')).toBe('{"nodes":{}}')

    // 第二轮：本地 size 与远端一致 ⇒ 不再下载
    const { impl: impl2 } = fakeFetch({}, {
      '/runs/3120/': [entry('new.json', 7)],
      '/dbt/': [entry('manifest.json', 12)],
    })
    const r2 = await syncOnce(cfg, { fetchImpl: impl2, log: () => {} })
    expect(r2).toMatchObject({ fetched: 0, failed: 0, errors: 0 })
  })

  it('★ 某个目录列表失败 ⇒ 记 errors，其它目录照常同步（单点故障不放大）', async () => {
    const root = await tmp()
    const cfg = {
      baseUrl: 'http://x', token: 't',
      runs: [{ book: '3120', dir: join(root, 'a') }, { book: '64188', dir: join(root, 'b') }],
      dbtDir: null,
      intervalMs: 60000,
    }
    const { impl } = fakeFetch(
      { '/runs/64188/ok.json': '{}' },
      { '/runs/3120/': [entry('x.json', 2)], '/runs/64188/': [entry('ok.json', 2)] },
    )
    const r = await syncOnce(cfg, { fetchImpl: impl, log: () => {} })
    expect(r.failed).toBe(1)          // 3120 的那个文件失败
    expect(r.fetched).toBe(1)         // 64188 正常
  })

  it('★ 下载失败**不覆盖**已有文件（旧值比半截值好）', async () => {
    const root = await tmp()
    const dir = join(root, 'runs', '3120')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'k.json'), '{"old":true}')
    const cfg = { baseUrl: 'http://x', token: 't', runs: [{ book: '3120', dir }], dbtDir: null, intervalMs: 60000 }
    const impl = (async (url: string) => {
      if (String(url).endsWith('/runs/3120/')) {
        return { ok: true, status: 200, json: async () => [entry('k.json', 999)] } as unknown as Response
      }
      return { ok: false, status: 500 } as unknown as Response
    }) as unknown as typeof fetch
    const r = await syncOnce(cfg, { fetchImpl: impl, log: () => {} })
    expect(r.failed).toBe(1)
    expect(await readFile(join(dir, 'k.json'), 'utf8')).toBe('{"old":true}')
  })
})
