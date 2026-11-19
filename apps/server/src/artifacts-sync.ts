// artifacts-sync.ts — 把**数据单元**的只读产物拉到应用单元的本地文件（#2518，跨机拆分前置）
//
// 为什么需要这一层：
//   · console 的管线运行回执（`runs/*.json`）与 dbt 的 `manifest.json` / `run_results.json`
//     都产生在**数据单元**；
//   · 消费它们的模块（`modules/data/domain/pipelines/*`、`analysis/reconcile.ts`、
//     `toolbox/health.ts`）按**文件**读，且按设计「读不到 ⇒ unknown，未知 ≠ 没跑过」；
//   · 同机部署时靠宿主 bind 直接读对方目录，**跨机后那条路必断**。
//
// 做法＝单向同步（远端只读 HTTP → 本地文件），放在**宿主层**而不是模块里：
//   模块与它的判据一行不改，现有测试继续有效；拉不到就不更新 ⇒ 文件保持陈旧 ⇒
//   模块自己的 unknown / 陈旧档位生效（**不会假绿**）。
//
// 远端由数据单元的 `artifacts` 服务提供（nginx 静态 + Bearer token + autoindex JSON）。
//
// 失败语义：整轮 try/catch，只打日志；**绝不动已拉下来的文件**——半截文件比旧文件更糟。
import { mkdir, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** 远端 autoindex（`autoindex_format json`）的条目形状。 */
export interface RemoteEntry { name: string; type: string; mtime: string; size: number }

export interface SyncTarget { book: string; dir: string }

export interface ArtifactsSyncConfig {
  /** 例：`http://10.0.0.5:18090`（数据单元 artifacts 服务，仅内网）。 */
  baseUrl: string
  token: string
  /** 账套 → 本地目录（从 `DATA_RUN_DIRS` 解析，与模块**同源**）。 */
  runs: SyncTarget[]
  /** dbt 产物本地目录（`dirname(DATA_DBT_MANIFEST_PATH)`）；未配置则不同步。 */
  dbtDir: string | null
  intervalMs: number
}

/** 只允许产物文件名：防 `..`、防子目录、防非 JSON 资产。 */
const SAFE_NAME = /^[A-Za-z0-9._-]+\.json$/

/**
 * 解析 `DATA_RUN_DIRS`（`3120=/dir,64188=/dir`）。
 * 畸形条目**整份作废**（返回空数组）——与模块侧 `run-source.ts` 同一条纪律：
 * 悄悄跳过坏条目会让「少一个账套」看起来像「那个账套没有运行记录」。
 */
export function parseRunDirs(raw: string | undefined): SyncTarget[] {
  if (raw === undefined || raw.trim() === '') return []
  const out: SyncTarget[] = []
  for (const part of raw.split(',')) {
    const [book, dir] = part.split('=')
    if (book === undefined || dir === undefined || book.trim() === '' || dir.trim() === '') return []
    out.push({ book: book.trim(), dir: dir.trim() })
  }
  return out
}

/**
 * 从 env 读同步配置。`ARTIFACTS_BASE_URL` 缺省 ⇒ 返回 null（**关**，fail-closed）：
 * 本地/测试不该因为起个 app 就去打内网；生产由 compose 显式给。
 */
export function parseArtifactsSyncConfig(env: Record<string, string | undefined>): ArtifactsSyncConfig | null {
  const baseUrl = env.ARTIFACTS_BASE_URL?.trim()
  if (baseUrl === undefined || baseUrl === '') return null
  const token = env.ARTIFACTS_TOKEN?.trim() ?? ''
  const runs = parseRunDirs(env.DATA_RUN_DIRS)
  const manifest = env.DATA_DBT_MANIFEST_PATH?.trim()
  const dbtDir = manifest === undefined || manifest === '' ? null : dirname(manifest)
  const rawInterval = Number(env.ARTIFACTS_SYNC_INTERVAL_MS ?? 60000)
  const intervalMs = Number.isSafeInteger(rawInterval) && rawInterval >= 5000 ? rawInterval : 60000
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token, runs, dbtDir, intervalMs }
}

/**
 * 判断该拉哪些文件（**纯函数**，便于单独测）。
 * 判据：本地缺失，或 size / mtime 与远端不同。`local` 返回 null 表示本地没有该文件。
 */
export function planDownloads(
  remote: readonly RemoteEntry[],
  local: (name: string) => { size: number; mtimeMs: number } | null,
): string[] {
  const out: string[] = []
  for (const e of remote) {
    if (e.type !== 'file' || !SAFE_NAME.test(e.name)) continue
    const st = local(e.name)
    if (st === null) { out.push(e.name); continue }
    const remoteMs = Date.parse(e.mtime)
    if (st.size !== e.size) { out.push(e.name); continue }
    // nginx 的 mtime 精确到秒；本地按毫秒对齐后比较，避免 1s 抖动导致每轮重拉。
    if (Number.isFinite(remoteMs) && Math.abs(st.mtimeMs - remoteMs) > 1000) out.push(e.name)
  }
  return out.sort()
}

export interface SyncDeps {
  fetchImpl?: typeof fetch
  now?: () => Date
  log?: (o: unknown) => void
}

async function listRemote(
  baseUrl: string,
  token: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<RemoteEntry[]> {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    headers: token === '' ? {} : { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  const body: unknown = await res.json()
  if (!Array.isArray(body)) throw new Error(`${path} → 非数组（autoindex_format 应为 json）`)
  return body.filter((x): x is RemoteEntry =>
    typeof x === 'object' && x !== null && typeof (x as RemoteEntry).name === 'string')
}

async function localStatOf(dir: string, name: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(join(dir, name))
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** 拉一个目录。返回 {fetched, failed}；**单个文件失败不中断整轮**。 */
async function syncDir(
  cfg: ArtifactsSyncConfig,
  remotePath: string,
  localDir: string,
  fetchImpl: typeof fetch,
  log: (o: unknown) => void,
): Promise<{ fetched: number; failed: number }> {
  const entries = await listRemote(cfg.baseUrl, cfg.token, remotePath, fetchImpl)
  const stats = new Map<string, { size: number; mtimeMs: number } | null>()
  for (const e of entries) stats.set(e.name, await localStatOf(localDir, e.name))
  const wantedNames = new Set(planDownloads(entries, (n) => stats.get(n) ?? null))
  const wanted = entries.filter((e) => wantedNames.has(e.name))
  if (wanted.length === 0) return { fetched: 0, failed: 0 }

  await mkdir(localDir, { recursive: true })
  let fetched = 0
  let failed = 0
  for (const entry of wanted) {
    const name = entry.name
    try {
      const res = await fetchImpl(`${cfg.baseUrl}${remotePath}${name}`, {
        headers: cfg.token === '' ? {} : { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // 原子写：先写 `.tmp` 再 rename ⇒ 模块永远不会读到半截 JSON。
      const final = join(localDir, basename(name))
      const tmp = `${final}.tmp-${process.pid}`
      await writeFile(tmp, buf)
      // 把本地 mtime 对齐**远端**的 mtime：否则「本地写入时刻 vs 远端文件时刻」永远不同，
      // 每一轮都会判成「变了」而重拉（manifest 2.8MB × N 次/小时 = 白烧带宽）。
      const remoteMs = Date.parse(entry.mtime)
      if (Number.isFinite(remoteMs)) {
        const secs = remoteMs / 1000
        await utimes(tmp, secs, secs).catch(() => {})
      }
      await rename(tmp, final)
      fetched += 1
    } catch (e) {
      failed += 1
      log({ ts: new Date().toISOString(), artifactsSync: 'file-failed', path: `${remotePath}${name}`, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { fetched, failed }
}

/** 一轮同步。任一目录列表失败只记日志，不影响其它目录。 */
export async function syncOnce(
  cfg: ArtifactsSyncConfig,
  deps: SyncDeps = {},
): Promise<{ fetched: number; failed: number; errors: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const log = deps.log ?? ((o: unknown) => console.log(JSON.stringify(o)))
  let fetched = 0
  let failed = 0
  let errors = 0
  const jobs: Array<[string, string]> = cfg.runs.map((t) => [`/runs/${t.book}/`, t.dir])
  if (cfg.dbtDir !== null) jobs.push(['/dbt/', cfg.dbtDir])
  for (const [remotePath, localDir] of jobs) {
    try {
      const r = await syncDir(cfg, remotePath, localDir, fetchImpl, log)
      fetched += r.fetched
      failed += r.failed
    } catch (e) {
      errors += 1
      log({ ts: new Date().toISOString(), artifactsSync: 'dir-failed', path: remotePath, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { fetched, failed, errors }
}

/**
 * 起同步循环。`setInterval` + `unref`（不因它拖住进程退出）。
 * 与 `integration-probe` 同一形态：宿主层、失败只留痕。
 */
export function startArtifactsSyncLoop(cfg: ArtifactsSyncConfig, deps: SyncDeps = {}): void {
  const log = deps.log ?? ((o: unknown) => console.log(JSON.stringify(o)))
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return // 上一轮还没跑完（大 manifest 可能慢）⇒ 跳过本拍，不叠加
    running = true
    try {
      const r = await syncOnce(cfg, deps)
      if (r.fetched > 0 || r.errors > 0) {
        log({ ts: new Date().toISOString(), artifactsSync: 'tick', ...r })
      }
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, cfg.intervalMs)
  timer.unref?.()
}
