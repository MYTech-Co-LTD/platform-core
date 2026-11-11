// detail-gate.ts — 明细查询的**并发准入门**（#1951 Wave 0.1）。
//
// 为什么需要它（而 pool.max 不够）：
//   pg_duckdb 每条连接一个 DuckDB 实例、每条上限 1536MB；数据面容器 mem_limit 默认 4g。
//   `pool.max=3` 只约束**同时打开的连接**，可明细查询恰好是最吃内存的一类（扫 1–2 个月文件）。
//   并发数由这里再压一道：超过 `DATA_DETAIL_CONCURRENCY`（默认 2）就排队，等不到就**快速失败**
//   （可重试），而不是把 pg_duckdb 推过内存预算、让 backend 被 OOM kill。
//
// 语义（三条）：
//   ① 默认 2 个名额、等 15s；超过等待时间抛 DetailGateBusyError —— 调用方翻成
//      `warehouse_transient`（可重试），**不是** 500。
//   ② 名额是**进程内**的（与连接池同生命周期）；多副本时每个副本各自守预算，正确（内存是每副本的）。
//   ③ 只包**执行**，不包鉴权/审计/缓存命中（缓存命中的请求不占名额）。
export class DetailGateBusyError extends Error {
  constructor(readonly waitedMs: number) {
    super(`detail gate busy after ${waitedMs}ms`)
    this.name = 'DetailGateBusyError'
  }
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface DetailGateOptions {
  concurrency?: number
  waitMs?: number
}

export class DetailGate {
  private readonly concurrency: number
  private readonly waitMs: number
  private inFlight = 0
  private readonly queue: Waiter[] = []

  constructor(opts: DetailGateOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2)
    this.waitMs = Math.max(1, opts.waitMs ?? 15_000)
  }

  /** 申请一个名额；返回 release（必须恰好调用一次，幂等）。 */
  async acquire(): Promise<() => void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1
      return this.releaser()
    }
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        reject(new DetailGateBusyError(this.waitMs))
      }, this.waitMs)
      const waiter: Waiter = {
        resolve: (release) => { clearTimeout(timer); resolve(release) },
        reject,
        timer,
      }
      this.queue.push(waiter)
    })
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next !== undefined) {
        // 名额直接转交给下一个等待者，inFlight 不变。
        next.resolve(this.releaser())
      } else {
        this.inFlight -= 1
      }
    }
  }

  stats(): { inFlight: number; waiting: number; concurrency: number; waitMs: number } {
    return { inFlight: this.inFlight, waiting: this.queue.length, concurrency: this.concurrency, waitMs: this.waitMs }
  }
}

function intEnv(key: string, def: number): number {
  const raw = process.env[key]?.trim()
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : def
}

/** 进程单例（模块装载期不建任何东西；第一次问数才用到）。 */
let singleton: DetailGate | null = null

export function detailGate(): DetailGate {
  if (singleton === null) {
    singleton = new DetailGate({
      concurrency: intEnv('DATA_DETAIL_CONCURRENCY', 2),
      waitMs: intEnv('DATA_DETAIL_WAIT_MS', 15_000),
    })
  }
  return singleton
}

/** 测试钩子：清掉单例（换 env 的用例之间必须调）。 */
export function resetDetailGate(): void {
  singleton = null
}
