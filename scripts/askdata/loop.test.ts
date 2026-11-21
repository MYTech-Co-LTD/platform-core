// scripts/askdata/loop.test.ts —— 纯逻辑 + 快照/发现（真文件系统，临时目录），不跑 python、不投 OO。
//
// 钉五件事：
//   ① 凭据映射：`OO_READ_*` → python 认的 `OO_*`；任一缺失 ⇒ null（fail-closed，绝不猜）；
//   ② `ASK_VERIFY_ORG` 回落 `PLATFORM_ORG`（verify.py 自己 fail-closed，这里不许给它空串以外的自由）；
//   ③ 水位路径按 agent 一份（`<dir>/<step>.watermark.<agent>`）——全局一份会永久跳过新 agent（#1419 教训）；
//   ④ 快照复制带 `-wal/-shm` 且**先清旧目录**（残留 wal = 回放旧事务）；
//   ⑤ 单 agent 失败**不拖停**：三步中任一步 rc≠0 ⇒ 该 agent 判红、循环继续（与旧 shell fail-fast 的有意差异）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_AGENTS_ROOT, agentOf, discoverAgents, ooEnvFor, runAgent, safeAgent, snapshotDb, stepEnv, verifyOrg,
} from './loop.mjs'

describe('askdata-loop 凭据与租户键', () => {
  it('★ OO_READ_* 映射成 python 认的 OO_*；任一缺失 ⇒ null', () => {
    expect(ooEnvFor({ OO_READ_URL: 'https://oo', OO_READ_ORG: 'o', OO_READ_TOKEN: 't' }))
      .toEqual({ OO_BASE: 'https://oo', OO_ORG: 'o', OO_AUTH: 't' })
    expect(ooEnvFor({ OO_BASE: 'b', OO_ORG: 'o', OO_AUTH: 'a' })).toEqual({ OO_BASE: 'b', OO_ORG: 'o', OO_AUTH: 'a' })
    expect(ooEnvFor({ OO_READ_URL: 'https://oo', OO_READ_ORG: 'o' })).toBeNull()
    expect(ooEnvFor({})).toBeNull()
  })

  it('★ ASK_VERIFY_ORG 显式优先，缺省回落 PLATFORM_ORG；两者都无 ⇒ 空串（verify.py 会拒）', () => {
    expect(verifyOrg({ ASK_VERIFY_ORG: 'x', PLATFORM_ORG: 'y' })).toBe('x')
    expect(verifyOrg({ PLATFORM_ORG: 'y' })).toBe('y')
    expect(verifyOrg({})).toBe('')
  })
})

describe('askdata-loop 路径与命名', () => {
  it('★ 水位按 agent 一份（三步各自独立文件）', () => {
    const env = { PLATFORM_ORG: 'shanhaiyiguo-org' }
    const oo = { OO_BASE: 'b', OO_ORG: 'o', OO_AUTH: 'a' }
    const e1 = stepEnv({ key: 'export', wmEnv: 'ASK_TRACE_WM', wmFile: 'export.watermark' }, 'main', env, oo, '/var/lib/askdata')
    expect(e1.ASK_TRACE_WM).toBe('/var/lib/askdata/export.watermark.main')
    expect(e1.ASK_VERIFY_ORG).toBe('shanhaiyiguo-org')
    expect(e1.OO_BASE).toBe('b')
    const e2 = stepEnv({ key: 'verify', wmEnv: 'ASK_VERIFY_WM', wmFile: 'verify.watermark' }, 'wecom-dm-x', env, oo, '/var/lib/askdata')
    expect(e2.ASK_VERIFY_WM).toBe('/var/lib/askdata/verify.watermark.wecom-dm-x')
  })

  it('agent 名从库路径取；脏字符替换成 _（探针/目录名不赌）', () => {
    expect(agentOf('/openclaw-state/agents/main/agent/openclaw-agent.sqlite')).toBe('main')
    expect(safeAgent('a b/c')).toBe('a_b_c')
    expect(DEFAULT_AGENTS_ROOT).toBe('/openclaw-state/agents')
  })
})

describe('askdata-loop 快照与发现', () => {
  it('★ 快照带 -wal/-shm，且先清旧目录（残留 wal = 回放旧事务）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-loop-snap-'))
    const db = join(dir, 'openclaw-agent.sqlite')
    writeFileSync(db, 'main')
    writeFileSync(db + '-wal', 'wal-v2')
    const snapRoot = join(dir, 'snap')
    const first = snapshotDb(db, 'main', snapRoot)
    expect(readFileSync(first, 'utf8')).toBe('main')
    expect(readFileSync(first + '-wal', 'utf8')).toBe('wal-v2')
    // 残留：第二次快照时源没有 wal 了，目标也不许留旧的
    rmSync(db + '-wal')
    snapshotDb(db, 'main', snapRoot)
    expect(existsSync(first + '-wal')).toBe(false)
  })

  it('发现：只认 <root>/<agent>/agent/openclaw-agent.sqlite 形状；坏形状/缺文件不算 agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ask-loop-agents-'))
    mkdirSync(join(root, 'main', 'agent'), { recursive: true })
    writeFileSync(join(root, 'main', 'agent', 'openclaw-agent.sqlite'), 'x')
    mkdirSync(join(root, 'broken'), { recursive: true }) // 没有 agent 子目录
    expect(discoverAgents(root)).toEqual([{ agent: 'main', db: join(root, 'main', 'agent', 'openclaw-agent.sqlite') }])
    expect(discoverAgents('/nonexistent-askdata-root')).toEqual([])
  })
})

describe('askdata-loop 失败隔离（与旧 shell fail-fast 的有意差异）', () => {
  const oo = { OO_BASE: 'b', OO_ORG: 'o', OO_AUTH: 'a' }

  it('★ 任一步 rc≠0 ⇒ 该 agent 判红并点名 step，不再继续后续步', () => {
    const spawn = vi.fn()
      .mockImplementationOnce((_cmd, _argv) => ({ status: 0, stdout: 'EXPORT_OK rows=0', stderr: '' }))
      .mockImplementationOnce((_cmd, _argv) => ({ status: 1, stdout: '', stderr: 'boom' }))
    const r = runAgent({ agent: 'main', db: '/tmp/x.sqlite' }, { env: {}, oo, wmDir: '/tmp/wm', snapRoot: '/tmp/snap', spawn: spawn as never })
    expect(r.ok).toBe(false)
    expect(r.failedStep).toBe('attribute')
    expect(r.output).toContain('ASKDATA_STEP_FAILED agent=main step=attribute rc=1')
    expect(spawn).toHaveBeenCalledTimes(2) // 第三步（verify）没被带跑
  })

  it('spawn 级失败也判红并点名依赖', () => {
    const spawn = vi.fn(() => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }))
    const r = runAgent({ agent: 'main', db: '/tmp/x.sqlite' }, { env: {}, oo, wmDir: '/tmp/wm', snapRoot: '/tmp/snap', spawn: spawn as never })
    expect(r.failedStep).toBe('export')
    expect(r.output).toContain('SPAWN_FAILED')
  })
})
