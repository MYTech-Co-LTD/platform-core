#!/usr/bin/env node
// @ts-nocheck —— 调度器入口（判据本体是三个仓内 python：export-transcript / attribute / verify）。
//
// askdata/loop.mjs —— askdata 演进回路 P1 的**容器形态**入口（#2624，Wave 8 ③）。
//
// 替代宿主 `sync-and-run.sh`（靠 docker sock 找卷路径 + source /etc/openobserve-ingest.env）：
//   · agent 库从**只读挂载** `openclaw_state:/openclaw-state` 里找；
//   · 每个库先**快照复制**到 /tmp 再读——只读挂载上 WAL 模式的 SQLite 建不了 -shm（#2624 实测风险）；
//   · OO 摄取凭据走映射：容器里是 `OO_READ_*`（应用单元形态），python 认 `OO_*`（宿主形态）；
//   · 水位写 `/var/lib/askdata`（复用 `askdata-state` 命名卷，与 verify-ingest 同卷）。
//
// 与旧 shell 的**有意行为变更**（旧的是 `set -eu` fail-fast，一个 agent 坏 ⇒ 整轮停）：
//   单个 agent 失败**不拖停其他 agent**；本轮退出码=2，失败明细打日志并投判红探针。
//   水位纪律不变：任一步失败，该 agent 的水位停在失败点之前（python 侧 #969 的纪律），下一轮重读。
//
// 退出码：0 = 全部 agent 三步成功（含「无新事件」）；2 = 有 agent 失败 / 一个 agent 都没找到 /
//         凭据缺失（fail-closed，绝不静默空转）。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emitFailure } from '../probe-emit.mjs'

/** agent 库的只读挂载根（compose：`openclaw_state:/openclaw-state:ro`）。 */
export const DEFAULT_AGENTS_ROOT = '/openclaw-state/agents'
/** 水位目录（复用 `askdata-state:/var/lib/askdata` 命名卷）。 */
export const DEFAULT_WM_DIR = '/var/lib/askdata'
/** 快照目录：**必须可写**（/tmp）；只读挂载上 WAL 库开不了。 */
export const DEFAULT_SNAPSHOT_DIR = '/tmp/askdata-read'

/** 三个判据本体（仓内路径，镜像 WORKDIR=/app）。顺序即执行顺序：export → attribute → verify。 */
export const STEPS = [
  { key: 'export', script: 'scripts/askdata/export-transcript.py', wmEnv: 'ASK_TRACE_WM', wmFile: 'export.watermark' },
  { key: 'attribute', script: 'scripts/askdata/attribute.py', wmEnv: 'ASK_ATTR_WM', wmFile: 'attribute.watermark' },
  { key: 'verify', script: 'scripts/askdata/verify.py', wmEnv: 'ASK_VERIFY_WM', wmFile: 'verify.watermark' },
]

/**
 * OO 摄取三元组的映射（纯函数）：宿主形态 `OO_*` 优先（回滚用），否则从应用单元的 `OO_READ_*` 取。
 * @param {Record<string,string|undefined>} env
 * @returns {{OO_BASE: string, OO_ORG: string, OO_AUTH: string}|null} 任一缺失 ⇒ null（fail-closed）
 */
export function ooEnvFor(env) {
  const pick = (a, b) => String(env[a] ?? '').trim() || String(env[b] ?? '').trim()
  const out = { OO_BASE: pick('OO_BASE', 'OO_READ_URL'), OO_ORG: pick('OO_ORG', 'OO_READ_ORG'), OO_AUTH: pick('OO_AUTH', 'OO_READ_TOKEN') }
  return Object.values(out).every((v) => v !== '') ? out : null
}

/** 租户隔离键：`ASK_VERIFY_ORG` 显式优先，缺省回落 `PLATFORM_ORG`（verify.py fail-closed，不猜）。 */
export function verifyOrg(env) {
  return String(env.ASK_VERIFY_ORG ?? '').trim() || String(env.PLATFORM_ORG ?? '').trim()
}

/** 从库路径取 agent 名：`<root>/<agent>/agent/openclaw-agent.sqlite` → `<agent>`。 */
export function agentOf(dbPath) {
  const parts = String(dbPath).split('/')
  return parts[parts.length - 3] ?? '(unknown)'
}

/** 探针/日志用的安全名：agent 目录名理论上干净，但别赌。 */
export function safeAgent(agent) {
  return String(agent).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 某一步的 python 子进程 env（纯函数：只拼装，不读进程外状态）。 */
export function stepEnv(step, agent, env, oo, wmDir) {
  return {
    ...env,
    ...oo,
    [step.wmEnv]: join(wmDir, `${step.wmFile}.${agent}`),
    ASK_VERIFY_ORG: verifyOrg(env),
  }
}

/**
 * 快照复制：db + `-wal`/`-shm`（若在）→ `<snap>/<agent>/`。先清旧目录，避免残留 wal 造成「回放旧事务」。
 * 只读挂载上这是唯一安全的读法（#2624 实测：mode=ro 在只读 FS 上可能因 -shm 建不了而失败）。
 */
export function snapshotDb(db, agent, snapRoot) {
  const dir = join(snapRoot, safeAgent(agent))
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dst = join(dir, 'openclaw-agent.sqlite')
  for (const suffix of ['', '-wal', '-shm']) {
    const src = db + suffix
    if (existsSync(src)) cpSync(src, dst + suffix, { preserveTimestamps: true })
  }
  return dst
}

/** 找 agent 库（浅层 glob：`<root>/<agent>/agent/openclaw-agent.sqlite`）。
 *  ⚠️ 块注释里别出现「星号紧跟斜杠」的字面量（通配路径最容易踩）——它会把 JSDoc 提前终结，
 *  剩下的文本变成代码（本文件第一版就因此把反引号配对全打乱）。 */
export function discoverAgents(root) {
  let agents
  try {
    agents = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  return agents
    .map((a) => ({ agent: a, db: join(root, a, 'agent', 'openclaw-agent.sqlite') }))
    .filter((x) => existsSync(x.db))
}

/**
 * 跑一个 agent 的三步（快照 → export → attribute → verify）。
 * @returns {{agent: string, ok: boolean, failedStep: string|null, output: string}}
 */
export function runAgent(entry, opts) {
  const { env, oo, wmDir, snapRoot, spawn = spawnSync } = opts
  let snap
  try {
    snap = snapshotDb(entry.db, entry.agent, snapRoot)
  } catch (e) {
    return { agent: entry.agent, ok: false, failedStep: 'snapshot', output: `SNAPSHOT_FAILED ${e instanceof Error ? e.message : String(e)}` }
  }
  const chunks = [`AGENT ${entry.agent}`]
  for (const step of STEPS) {
    const r = spawn('python3', [step.script, snap], {
      cwd: process.cwd(), encoding: 'utf8', env: stepEnv(step, entry.agent, env, oo, wmDir),
    })
    chunks.push(`${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd())
    if (r.error || (r.status ?? 2) !== 0) {
      const msg = r.error ? `SPAWN_FAILED ${r.error.message}` : `rc=${r.status}`
      chunks.push(`ASKDATA_STEP_FAILED agent=${entry.agent} step=${step.key} ${msg}`)
      return { agent: entry.agent, ok: false, failedStep: step.key, output: chunks.join('\n') }
    }
  }
  return { agent: entry.agent, ok: true, failedStep: null, output: chunks.join('\n') }
}

async function main() {
  const env = process.env
  const root = (env.ASKDATA_AGENTS_ROOT ?? '').trim() || DEFAULT_AGENTS_ROOT
  const wmDir = (env.ASKDATA_WM_DIR ?? '').trim() || DEFAULT_WM_DIR
  const snapRoot = (env.ASKDATA_SNAPSHOT_DIR ?? '').trim() || DEFAULT_SNAPSHOT_DIR
  const oo = ooEnvFor(env)
  const org = verifyOrg(env)
  if (oo === null || org === '') {
    console.error(`ASKDATA_CONFIG_FAILED oo=${oo === null ? '缺 OO_*/OO_READ_*' : 'ok'} org=${org || '缺 ASK_VERIFY_ORG/PLATFORM_ORG'}`)
    return 2
  }
  mkdirSync(wmDir, { recursive: true })
  const agents = discoverAgents(root)
  if (agents.length === 0) {
    console.error(`ASKDATA_NO_AGENTS ${root}（挂载是否在？openclaw 是否起过？）`)
    if (process.env.NODE_ENV !== 'test') await emitFailure('askdata_loop:agents', `在 ${root} 找不到任何 agent 库`)
    return 2
  }
  let failed = 0
  for (const entry of agents) {
    const r = runAgent(entry, { env, oo, wmDir, snapRoot })
    process.stdout.write(`${r.output}\n`)
    if (!r.ok) {
      failed += 1
      // 告警单出口：单 agent 判红进 OO（桥 12h 冷却收敛），不再依赖 openship job 通知（静默）。
      if (process.env.NODE_ENV !== 'test') {
        await emitFailure(`askdata_loop:${safeAgent(r.agent)}`, `step=${r.failedStep}\n${r.output.slice(-300)}`)
      }
    }
  }
  const rc = failed > 0 ? 2 : 0
  console.log(`ASKDATA_LOOP_DONE agents=${agents.length} failed=${failed} rc=${rc}`)
  return rc
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
