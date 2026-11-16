#!/usr/bin/env node
// oa-p1-smoke.mjs — OA P1「请假」端到端验收（计划 2026-11-16-ai-native-oa-p0-p1 Task 15 / issue #2363）。
//
// 用法：
//   DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/oa-p1-smoke.mjs
//
// 形态：**真宿主进程 + 真 HTTP + 假引擎（假引擎按 spec §10 公开契约实现）**。
//   · 宿主走 apps/server/src/index.ts 子进程（真 loadModules / 真 declaredScopeGate / 真 OrgPort /
//     真 OaEnginePort 读 platform.oa_engine 登记行），不是模块级测试壳——「无 publish scope 调
//     publish → 403」只有在宿主门卫上才成立，模块壳不挂门卫；
//   · 引擎用本脚本内起的假 HTTP 服务替代真 case-engine：逐条实现 §10.1–10.6（org 校验、externalRef
//     幂等、节点循环/quorum、撤回 CAS、final 回调）。**它证不了真引擎的实现**——真引擎的节点循环
//     由 case-engine 的 `core/engine/__tests__/case-approval.test.ts` 负责；本脚本证的是**平台侧
//     接缝与授权**（计划/快照/回调幂等/在途单不吃改版）。
//
// 不回退的两条纪律（写在这里防后来者「简化」掉）：
//   ① 假引擎的 `GET /cases/:id` 刻意延迟 50ms：并发决策用例要两个平台请求都在**第一次决策落库前**
//      读到 `currentNode=leader`，否则竞态会退化成 403（第二个请求看到节点已前进）而不是引擎 CAS 的
//      409。延迟把「测哪一层」钉死，不是为了让用例好过。
//   ② 通知断言不手写 notify 规则：跑 `notify-seed-builtin.mjs` + `notify-worker.mjs --once`，让
//      「manifest 声明 ⇔ 内置模板 ⇔ 派生规则」这条真链自己产出行——手写规则只能证明手写的那份。
//
// 清理：本脚本只用 org `oa-smoke`（自建租户），开跑前清掉该 org 的提交/审计/引擎映射/组织行/通知行；
// asset_id 每次带随机后缀（published 版本物理不可删是 DB 契约，见 forms 内核测试），其余行留在
// oa-smoke 名下（惰性数据，不碰 acme/beta 或任何别的夹具）。
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { request as nodeHttpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockCasdoor } from '../packages/auth-core/src/test-util/mock-casdoor.ts'
import { safePermissionName } from '../packages/auth-core/src/casdoor-client.ts'
import { runMigrations } from '../apps/server/src/migrate.ts'

// ---- 路径（一律按本文件位置，与 cwd 无关） ----
const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')
const serverDir = path.join(repoRoot, 'apps', 'server')

// ---- 常量：本脚本是这些值的唯一事实源 ----
const ORG = 'oa-smoke'
const ORG_SLUG = 'oa-smoke'
const TENANT_NAME = 'OA P1 验收租户'
const SESSION_SECRET = 'oa-p1-smoke-secret-oa-p1-smoke!!' // ≥32（config.ts 强校验）
const CASDOOR_CLIENT_ID = 'oa-smoke-client'
const CASDOOR_ADMIN_USER = 'admin'
const CASDOOR_ADMIN_PWD = 'pw'
const USER_PASSWORD = 'pw'
const ENGINE_PAT = 'engine-pat-oa-smoke' // 平台 → 引擎；落在宿主子进程 env，引用名见 PAT_SECRET_REF
const PAT_SECRET_REF = 'OA_ENGINE_PAT_OA_SMOKE' // platform.oa_engine.pat_secret_ref（只存键名）
const READY_TIMEOUT_MS = 30_000
const ENGINE_GET_DELAY_MS = 50
const SUF = Math.random().toString(36).slice(2, 8)

/** 用户（owner 全部归 ORG；admin 由 MockCasdoor 内置）。 */
const U = {
  mgr: 'u-mgr', // forms:manage + forms:publish + approval:manage + approval:publish
  ai: 'u-ai', // 只有 approval:manage（无 publish）——「AI/无 publish scope 调 publish」对照
  u1: 'u1', // 申请人（部门 10 成员，主部门 10）
  lead: 'u-lead', // 部门 10 负责人（dept_leader 来源）
  hr: 'u-hr', // 审批模板里的 HR 指定人（user 来源）
  hr2: 'u-hr2', // v2 模板的 HR（在途单不受影响用）
  nodept: 'u-nodept', // 无主部门（dept_leader 缺失发布对照）
  stranger: 'u-stranger', // 与审批无关的普通员工
  svc: 'case-engine', // 引擎服务账号：forms:case:callback + notify:emit
}

/** 每次 run 独立的 asset id（published 行物理不可删 ⇒ 不能复用同名资产验版本号）。 */
const ASSETS = {
  approval: `leave-${SUF}`,
  approvalNoDept: `leave-nodept-${SUF}`,
  item: `leave-item-${SUF}`,
}

// ---- 断言 / 输出 ----
class SmokeFailure extends Error {}

/** @type {Array<{ id: string, expected: string, actual: string, pass: boolean }>} */
const results = []

/**
 * @param {boolean} cond
 * @param {string} label
 * @param {unknown} [detail]
 */
function check(cond, label, detail) {
  if (cond) {
    console.log(`    ✓ ${label}`)
    return
  }
  console.error(`    ✗ ${label}`)
  if (detail !== undefined) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    console.error(text.split('\n').map((l) => `      ${l}`).join('\n'))
  }
  throw new SmokeFailure(label)
}

/**
 * 记一条验收结果（期望/实际/判定）——最后原样进 JSON 摘要，供验收文档引用。
 *
 * **不抛错**（有意）：负对照之间相互独立，一条红不该把后面六条的观测面一起埋掉——
 * 验收报告要的是「哪几条红」，不是「第一条红之后的空白」。硬前置（提交返回 201 这类）
 * 仍走 check()，因为后续断言建立在它上面。
 * @param {string} id
 * @param {string} expected
 * @param {string} actual
 * @param {boolean} pass
 */
function record(id, expected, actual, pass) {
  results.push({ id, expected, actual, pass })
  if (pass) console.log(`    ✓ [${id}] ${expected}`)
  else console.error(`    ✗ [${id}] 期望 ${expected}；实际 ${actual}`)
}

/** @param {string} label */
function step(label) {
  console.log(`\n== ${label}`)
}

/** @param {string} label */
function note(label) {
  console.log(`    · ${label}`)
}

/** 北京时间（验收文档一律北京时间；DB 侧用 Asia/Shanghai 直接出串）。 */
/** @param {Date} [d] */
function bj(d = new Date()) {
  // UTC+8 固定偏移（北京无夏令时）；用不带 ICU 依赖的写法
  const shifted = new Date(d.getTime() + 8 * 3600_000)
  return `${shifted.toISOString().slice(0, 19).replace('T', ' ')} BJT`
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 极简 HTTP 客户端（node:http；fetch 会静默丢 Host，且这里要拿原始状态/体） ----

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} text
 */

/**
 * @param {{ port: number, method?: string, path: string, cookie?: string, headers?: Record<string, string>, body?: string }} opts
 * @returns {Promise<HttpResponse>}
 */
function httpRequest({ port, method = 'GET', path: reqPath, cookie, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** @param {HttpResponse} res @returns {any} */
function json(res) {
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

/**
 * @param {HttpResponse} res
 * @param {Record<string, unknown>} [extra]
 */
function describe(res, extra = {}) {
  return {
    ...extra,
    status: res.status,
    body: res.text.length > 2000 ? `${res.text.slice(0, 2000)}…(truncated)` : res.text,
  }
}

// ---- 会话 cookie 罐 ----

class CookieJar {
  #cookies = new Map()

  /** @param {HttpResponse} res */
  apply(res) {
    for (const raw of res.headers['set-cookie'] ?? []) {
      const pair = raw.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || /max-age\s*=\s*0\b/i.test(raw)) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/**
 * 取 n 个互不相同的空闲端口（同时 bind 全部再统一释放）。
 * @param {number} n
 * @returns {Promise<number[]>}
 */
async function freePorts(n) {
  /** @type {import('node:net').Server[]} */
  const servers = []
  /** @type {number[]} */
  const ports = []
  try {
    for (let i = 0; i < n; i++) {
      const srv = createServer()
      await new Promise((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(0, () => resolve(undefined))
      })
      servers.push(srv)
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') throw new Error('freePorts: 未拿到端口')
      ports.push(addr.port)
    }
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))))
  }
  return ports
}

// ---- 假 case-engine（spec §10 契约的最小实现） ----

/**
 * @typedef {object} FakeCase
 * @property {string} caseId
 * @property {string} org
 * @property {string} externalRef
 * @property {string} provider
 * @property {string} type
 * @property {string} title
 * @property {string} requesterId
 * @property {Record<string, unknown>} payload
 * @property {{ nodes: Array<{ key: string, title?: string, approvers: string[], quorum?: unknown }> }} plan
 * @property {'gate'|'closed'} status
 * @property {string | null} currentNode
 * @property {string | null} outcome
 * @property {Array<{ nodeKey: string, decidedBy: string, action: string, comment: string | null, decidedAt: string }>} decisions
 * @property {Array<{ type: string, nodeKey?: string, at: string }>} events
 */

class FakeEngine {
  /** @param {{ org: string, pat: string }} cfg */
  constructor(cfg) {
    this.cfg = { org: cfg.org, pat: cfg.pat, platformBase: '', platformPat: '' }
    /** @type {Map<string, FakeCase>} */
    this.cases = new Map()
    /** @type {Map<string, string>} externalRef → caseId（幂等键） */
    this.byRef = new Map()
    /** @type {Array<{ method: string, path: string, body: unknown, status: number }>} */
    this.requests = []
    /** @type {Array<{ caseId: string, url: string, status: number, body: unknown }>} */
    this.callbacks = []
    this.seq = 0
    /** @type {null | import('node:http').Server} */
    this.server = null
    this.port = 0
  }

  /** @param {number} port */
  async start(port) {
    this.port = port
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((e) => {
        this.#send(res, 500, { error: 'FAKE_ENGINE_INTERNAL', detail: String(e) })
      })
    })
    await new Promise((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(port, '127.0.0.1', () => resolve(undefined))
    })
    return this
  }

  async stop() {
    await new Promise((r) => this.server?.close(() => r(undefined)))
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`
  }

  /** @param {string} caseId */
  caseOf(caseId) {
    const c = this.cases.get(caseId)
    if (c === undefined) throw new SmokeFailure(`假引擎里没有 case ${caseId}`)
    return c
  }

  /**
   * final 结论回调平台（spec §10.6）。fail-open 由引擎侧负责——测试里失败即断言失败。
   * @param {FakeCase} c
   * @param {'approved'|'rejected'|'withdrawn'} action
   * @param {string} decidedBy
   * @param {string} [comment]
   */
  async #callback(c, action, decidedBy, comment) {
    const decidedAt = new Date().toISOString()
    const body = {
      org: c.org,
      caseId: c.caseId,
      externalRef: c.externalRef,
      final: true,
      action,
      decidedBy,
      decidedAt,
      submitter: c.requesterId,
      ...(comment ? { comment } : {}),
    }
    /** @type {{ status: number, body: unknown }} */
    let out = { status: 0, body: null }
    if (this.cfg.platformBase.length > 0) {
      const res = await httpRequest({
        port: Number(new URL(this.cfg.platformBase).port),
        method: 'POST',
        path: '/api/modules/forms/approval-callback',
        headers: { Authorization: `Bearer ${this.cfg.platformPat}` },
        body: JSON.stringify(body),
      })
      out = { status: res.status, body: json(res) }
    }
    this.callbacks.push({ caseId: c.caseId, url: `${this.cfg.platformBase}/api/modules/forms/approval-callback`, ...out })
  }

  /**
   * 逐审批人发 `forms.approval.awaiting`（真引擎 T14 的同款动作；best-effort——失败不阻塞引擎语义，
   * 但会记进 `emitFailures` 供断言「没静默失败」）。
   * @param {FakeCase} c
   * @param {string} nodeKey
   */
  async #emitAwaiting(c, nodeKey) {
    const node = c.plan.nodes.find((n) => n.key === nodeKey)
    if (node === undefined) return
    for (const assignee of node.approvers) {
      const url = `${this.cfg.platformBase}/api/modules/notify/emit`
      const body = {
        eventKey: 'forms.approval.awaiting',
        // 契约（计划 T14）：确定性 event id；一节点多审批人时用 array payload 的语义另定，P1 未用
        eventId: `${c.externalRef}:node:${nodeKey}:awaiting`,
        scope: c.caseId,
        payload: {
          submissionId: c.externalRef.replace('forms:submission:', ''),
          caseId: c.caseId,
          nodeKey,
          title: c.title,
          assignee,
          link: `${this.cfg.platformBase}/m/oa/${c.caseId}`,
        },
      }
      const res = await httpRequest({
        port: Number(new URL(this.cfg.platformBase).port),
        method: 'POST',
        path: '/api/modules/notify/emit',
        headers: { Authorization: `Bearer ${this.cfg.platformPat}` },
        body: JSON.stringify(body),
      })
      this.requests.push({ method: 'POST', path: '/notify/emit', body, status: res.status })
    }
  }

  /**
   * 节点是否满足 quorum。
   * @param {FakeCase} c
   * @param {string} nodeKey
   */
  #quorumSatisfied(c, nodeKey) {
    const node = c.plan.nodes.find((n) => n.key === nodeKey)
    if (node === undefined) return false
    const n = c.decisions.filter((d) => d.nodeKey === nodeKey).length
    const q = node.quorum
    if (q === 'any') return n >= 1
    if (typeof q === 'object' && q !== null && typeof (/** @type {any} */ (q).n) === 'number') {
      return n >= /** @type {any} */ (q).n
    }
    return n >= node.approvers.length
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #handle(req, res) {
    /** @type {Buffer[]} */
    const chunks = []
    for await (const chunk of req) chunks.push(/** @type {Buffer} */ (chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    /** @type {any} */
    let body = null
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw)
      } catch {
        this.#send(res, 400, { error: 'BAD_JSON' })
        return
      }
    }
    const url = new URL(req.url ?? '/', this.origin)
    const method = req.method ?? 'GET'
    const p = url.pathname
    /** @param {number} status @param {unknown} out */
    const reply = (status, out) => {
      this.requests.push({ method, path: p, body, status })
      this.#send(res, status, out)
    }

    // 认证：除 /capabilities 外一律 Bearer（spec §10 的公开面由服务 PAT 保护）
    if (p !== '/capabilities') {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${this.cfg.pat}`) return reply(401, { error: 'UNAUTHORIZED' })
    }

    if (method === 'GET' && p === '/capabilities') {
      return reply(200, {
        planVersion: 1,
        engineVersion: 'fake-engine-0.1.0',
        providers: ['inapp'],
        features: ['nodeLoop', 'quorum'],
      })
    }

    if (method === 'POST' && p === '/cases') {
      if (body?.org !== this.cfg.org) return reply(403, { error: 'ORG_MISMATCH' })
      if (typeof body?.externalRef !== 'string' || body.externalRef.length === 0) {
        return reply(400, { error: 'EXTERNAL_REF_REQUIRED' })
      }
      const existing = this.byRef.get(body.externalRef)
      if (existing !== undefined) return reply(200, { caseId: existing, runId: `run-${existing}` })
      const nodes = body?.plan?.nodes
      if (!Array.isArray(nodes) || nodes.length === 0) return reply(400, { error: 'PLAN_INVALID' })
      for (const n of nodes) {
        if (typeof n?.key !== 'string' || !Array.isArray(n?.approvers)) {
          return reply(400, { error: 'PLAN_INVALID' })
        }
      }
      const caseId = `case-${++this.seq}`
      /** @type {FakeCase} */
      const c = {
        caseId,
        org: body.org,
        externalRef: body.externalRef,
        provider: String(body.provider ?? 'inapp'),
        type: String(body.type ?? 'approval'),
        title: String(body.title ?? ''),
        requesterId: String(body.requesterId ?? ''),
        payload: body.payload ?? {},
        plan: { nodes },
        status: 'gate',
        currentNode: nodes[0].key,
        outcome: null,
        decisions: [],
        events: [{ type: 'case.created', at: new Date().toISOString() }],
      }
      this.cases.set(caseId, c)
      this.byRef.set(c.externalRef, caseId)
      await this.#emitAwaiting(c, /** @type {string} */ (c.currentNode))
      return reply(201, { caseId, runId: `run-${caseId}` })
    }

    if (method === 'GET' && p === '/cases') {
      const ref = url.searchParams.get('externalRef')
      const rows = [...this.cases.values()].filter((c) => ref === null || c.externalRef === ref)
      return reply(200, { cases: rows.map((c) => ({ caseId: c.caseId, status: c.status, currentNode: c.currentNode })) })
    }

    const getMatch = /^\/cases\/([^/]+)$/.exec(p)
    if (method === 'GET' && getMatch) {
      const c = this.cases.get(decodeURIComponent(getMatch[1]))
      if (c === undefined) return reply(404, { error: 'CASE_NOT_FOUND' })
      // 刻意延迟（头注纪律①）：并发决策用例要两个平台请求都先读到旧 currentNode
      await sleep(ENGINE_GET_DELAY_MS)
      return reply(200, c)
    }

    const decideMatch = /^\/cases\/([^/]+)\/decision$/.exec(p)
    if (method === 'POST' && decideMatch) {
      const c = this.cases.get(decodeURIComponent(decideMatch[1]))
      if (c === undefined) return reply(404, { error: 'CASE_NOT_FOUND' })
      const action = String(body?.action ?? '')
      const nodeKey = String(body?.nodeKey ?? '')
      const decidedBy = String(body?.decidedBy ?? '')
      const comment = typeof body?.comment === 'string' ? body.comment : null
      if (c.status !== 'gate') return reply(409, { error: 'CASE_CLOSED' })
      if (nodeKey.length === 0 || nodeKey !== c.currentNode) {
        return reply(409, { error: 'NOT_CURRENT_NODE', currentNode: c.currentNode })
      }
      if (!['approve', 'reject', 'reassign', 'veto'].includes(action)) {
        return reply(400, { error: 'ACTION_INVALID' })
      }
      if ((action === 'reject' || action === 'veto') && comment === null) {
        return reply(400, { error: 'COMMENT_REQUIRED' })
      }
      const node = c.plan.nodes.find((n) => n.key === nodeKey)
      if (node === undefined) return reply(409, { error: 'NOT_CURRENT_NODE' })
      if (!node.approvers.includes(decidedBy)) return reply(403, { error: 'NOT_APPROVER' })
      if (c.decisions.some((d) => d.nodeKey === nodeKey && d.decidedBy === decidedBy)) {
        return reply(409, { error: 'ALREADY_DECIDED' })
      }
      const decidedAt = new Date().toISOString()
      c.decisions.push({ nodeKey, decidedBy, action, comment, decidedAt })
      c.events.push({ type: 'gate.node.decided', nodeKey, at: decidedAt })

      if (action === 'reject' || action === 'veto') {
        c.status = 'closed'
        c.outcome = 'rejected'
        c.currentNode = null
        c.events.push({ type: 'case.closed', at: new Date().toISOString() })
        await this.#callback(c, 'rejected', decidedBy, comment ?? undefined)
        return reply(200, { ok: true, status: c.status, outcome: c.outcome, currentNode: c.currentNode })
      }

      if (this.#quorumSatisfied(c, nodeKey)) {
        const idx = c.plan.nodes.findIndex((n) => n.key === nodeKey)
        const next = c.plan.nodes[idx + 1]
        if (next !== undefined) {
          c.currentNode = next.key
          c.events.push({ type: 'gate.node.awaiting', nodeKey: next.key, at: new Date().toISOString() })
          await this.#emitAwaiting(c, next.key)
        } else {
          c.status = 'closed'
          c.outcome = 'approved'
          c.currentNode = null
          c.events.push({ type: 'case.closed', at: new Date().toISOString() })
          await this.#callback(c, 'approved', decidedBy, comment ?? undefined)
        }
      }
      return reply(200, { ok: true, status: c.status, outcome: c.outcome, currentNode: c.currentNode })
    }

    const withdrawMatch = /^\/cases\/([^/]+)\/withdraw$/.exec(p)
    if (method === 'POST' && withdrawMatch) {
      const c = this.cases.get(decodeURIComponent(withdrawMatch[1]))
      if (c === undefined) return reply(404, { error: 'CASE_NOT_FOUND' })
      if (body?.org !== this.cfg.org) return reply(403, { error: 'ORG_MISMATCH' })
      if (c.status !== 'gate') return reply(409, { error: 'CASE_CLOSED' })
      // spec §10.4：仅「尚无任何节点决策事件」时允许撤回
      if (c.decisions.length > 0) return reply(409, { error: 'HAS_DECISIONS' })
      c.status = 'closed'
      c.outcome = 'withdrawn'
      c.currentNode = null
      c.events.push({ type: 'case.withdrawn', at: new Date().toISOString() })
      await this.#callback(c, 'withdrawn', String(body?.actor ?? c.requesterId))
      return reply(200, { ok: true })
    }

    return reply(404, { error: 'NOT_FOUND' })
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {unknown} out
   */
  #send(res, status, out) {
    const text = JSON.stringify(out)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
}

// ---- 宿主子进程 ----

function tsxRunner() {
  const shim = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  if (existsSync(shim)) return { cmd: shim, args: [] }
  return { cmd: process.execPath, args: [fileURLToPath(import.meta.resolve('tsx/cli'))] }
}

/**
 * @param {Record<string, string>} env
 * @param {string} label
 * @returns {import('node:child_process').ChildProcess}
 */
function startServer(env, label) {
  const tsx = tsxRunner()
  const child = spawn(tsx.cmd, [...tsx.args, 'src/index.ts'], {
    cwd: serverDir, // modules/ 按 cwd/../../modules 解析（app.ts）
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  /** @param {unknown} buf */
  const relay = (buf) => process.stderr.write(String(buf).replace(/^/gm, `[server:${label}] `))
  child.stdout?.on('data', relay)
  child.stderr?.on('data', relay)
  return child
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} port
 * @param {string} label
 */
async function waitReady(child, port, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`[${label}] 宿主提前退出，code=${child.exitCode}`)
    try {
      const res = await httpRequest({ port, path: '/healthz' })
      if (res.status === 200) return
    } catch {
      // 尚未监听
    }
    await sleep(200)
  }
  throw new Error(`[${label}] 宿主未在 ${READY_TIMEOUT_MS}ms 内就绪`)
}

/**
 * @param {import('node:child_process').ChildProcess | undefined} child
 * @param {string} label
 */
async function stopServer(child, label) {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const ok = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!ok) {
    console.error(`[server:${label}] SIGTERM 后 5s 未退出，SIGKILL`)
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    await Promise.race([exited, sleep(2000)])
  }
}

/**
 * 跑一个一次性 CLI（notify seed / worker），等退出码。
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} label
 */
async function runOnceCli(args, env, label) {
  const tsx = tsxRunner()
  const child = spawn(tsx.cmd, [...tsx.args, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  /** @type {string[]} */
  const out = []
  child.stdout?.on('data', (b) => out.push(String(b)))
  child.stderr?.on('data', (b) => out.push(String(b)))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (c) => resolve(c))
  })
  const text = out.join('')
  if (code !== 0) throw new SmokeFailure(`${label} 退出码 ${code}\n${text}`)
  return text
}

// ---- 组织 / 权限 / 登录 ----

/**
 * @param {MockCasdoor} mock
 * @returns {Promise<string>}
 */
async function mockAdminCookie(mock) {
  const res = await httpRequest({
    port: mock.port,
    path: '/api/login',
    method: 'POST',
    body: JSON.stringify({ username: CASDOOR_ADMIN_USER, password: CASDOOR_ADMIN_PWD }),
  })
  const hit = /casdoor_session_id=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''))
  if (res.status !== 200 || hit === null) throw new SmokeFailure(`MockCasdoor admin 登录失败：${describe(res)}`)
  return `casdoor_session_id=${hit[1]}`
}

/**
 * @param {MockCasdoor} mock
 * @param {string} cookie
 * @param {string} permCode
 * @param {string[]} users
 */
async function grantPermission(mock, cookie, permCode, users) {
  const res = await httpRequest({
    port: mock.port,
    method: 'POST',
    cookie,
    path: `/api/update-permission?id=${encodeURIComponent(`${ORG}/${safePermissionName(permCode)}`)}`,
    body: JSON.stringify({ users }),
  })
  const body = json(res)
  check(
    res.status === 200 && body?.status === 'ok',
    `MockCasdoor 把 ${permCode} 授予 [${users.join(',')}]`,
    describe(res),
  )
}

/**
 * @param {number} port
 * @param {CookieJar} jar
 * @param {string} username
 */
async function login(port, jar, username) {
  const res = await httpRequest({
    port,
    method: 'POST',
    path: '/api/platform/auth/login',
    body: JSON.stringify({ username, password: USER_PASSWORD }),
  })
  jar.apply(res)
  check(res.status === 200, `登录 ${username} 200`, describe(res))
  return res
}

/**
 * 统一请求入口（带 cookie）。
 * @param {number} port
 * @param {CookieJar} jar
 * @param {string} method
 * @param {string} p
 * @param {unknown} [body]
 */
function api(port, jar, method, p, body) {
  return httpRequest({
    port,
    method,
    path: p,
    headers: { Cookie: jar.header() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

// ---- 主流程 ----

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      'oa-p1-smoke: 缺少 DATABASE_URL。\n'
        + '  本地：docker compose -f deploy/docker-compose.yml up -d postgres，'
        + '然后 DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/oa-p1-smoke.mjs',
    )
    process.exit(1)
  }
  if (!existsSync(serverDir)) {
    console.error(`oa-p1-smoke: 找不到宿主目录 ${serverDir}`)
    process.exit(1)
  }

  const startedAt = new Date()
  // pg 锚到 apps/server 解析（scripts/ 不属于任何 workspace 包；照 backfill-identity-links.mjs 先例）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')
  // pg 的运行时依赖在 workspace 包里，scripts/ 的 typecheck 工程看不到它的类型声明——
  // 与 notify-seed-builtin.mjs 同款（createRequire 拿到的就是 any，别在这里编造类型）。
  const pool = new Pool({ connectionString: databaseUrl })

  /** @type {MockCasdoor | undefined} */
  let mock
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let serverChild
  /** @type {FakeEngine | undefined} */
  let engine

  try {
    // ── 0. 平台迁移 + 租户行（必须先于宿主启动：装载器按 platform.tenant 供给权限码） ──
    step('0. 平台迁移 + 验收租户（oa-smoke）')
    await runMigrations(pool, 'platform', path.join(serverDir, 'src', 'migrations'), { onMissingDir: 'error' })
    const t = await pool.query(
      `insert into platform.tenant(slug, casdoor_org, product_name, login_methods)
       values ($1,$2,$3,'{password}')
       on conflict (slug) do update set product_name = excluded.product_name
       returning id`,
      [ORG_SLUG, ORG, TENANT_NAME],
    )
    const tenantId = Number(t.rows[0].id)
    note(`tenant.id=${tenantId} org=${ORG}`)

    // 清场：只动本 org 的行（published asset 物理不可删是 DB 契约，asset_id 用随机后缀规避）
    await pool.query('delete from forms.submission where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from forms.audit where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from notify.inbox where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from notify.delivery where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from notify.event where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from notify.rule where org=$1 and origin=\'derived\' and created_by=\'system\'', [ORG]).catch(() => {})
    await pool.query('delete from platform.api_key where org=$1', [ORG]).catch(() => {})
    await pool.query('delete from platform.oa_engine where org=$1', [ORG]).catch(() => {})
    for (const table of ['org_node', 'org_membership', 'org_node_leader', 'org_role_binding']) {
      await pool.query(`delete from platform.${table} where tenant_id=$1`, [tenantId])
    }

    // ── 1. 组织事实（dept 10 + 负责人 u-lead）；u-nodept 刻意不进任何部门 ──
    step('1. 组织事实：部门 10 / 成员 u1 / 负责人 u-lead')
    await pool.query(
      `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
       values ($1,'10','研发部',null,'10',1)`,
      [tenantId],
    )
    for (const user of [U.u1, U.lead, U.hr]) {
      await pool.query(
        `insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary)
         values ($1,$2,'10',true)`,
        [tenantId, user],
      )
    }
    await pool.query(
      `insert into platform.org_node_leader(tenant_id, node_ext_id, user_name, sort)
       values ($1,'10',$2,0)`,
      [tenantId, U.lead],
    )
    const orgCheck = await pool.query(
      `select (select count(*)::int from platform.v_org_membership where tenant_id=$1) members,
              (select count(*)::int from platform.v_org_node_leader where tenant_id=$1) leaders`,
      [tenantId],
    )
    note(`org rows: members=${orgCheck.rows[0].members} leaders=${orgCheck.rows[0].leaders}`)

    // ── 2. MockCasdoor + 假引擎 + 宿主端口 ──
    step('2. 起 MockCasdoor / 假引擎 / 宿主')
    mock = new MockCasdoor({
      users: Object.values(U).map((name) => ({
        name, password: USER_PASSWORD, owner: ORG, displayName: name,
      })),
      subscriptions: ['acme', 'beta', ORG].flatMap((owner) => [
        {
          owner, name: `sub_mod-forms_${owner}`, user: 'tenantsub', plan: 'mod-forms',
          startTime: '2026-01-01T00:00:00Z', endTime: '2099-01-01T00:00:00Z', state: 'Active',
        },
        {
          owner, name: `sub_mod-notify_${owner}`, user: 'tenantsub', plan: 'mod-notify',
          startTime: '2026-01-01T00:00:00Z', endTime: '2099-01-01T00:00:00Z', state: 'Active',
        },
      ]),
    })
    await mock.start()
    // 先起 mock 再要端口：mock 的 :0 随机端口要先占住（smoke-load issue #112 同款顺序约束）
    const [hostPort, enginePort, workerPort] = await freePorts(3)
    check(
      new Set([hostPort, enginePort, workerPort, mock.port]).size === 4,
      `端口互不相同（mock=${mock.port} host=${hostPort} engine=${enginePort} worker=${workerPort}）`,
    )

    engine = await new FakeEngine({ org: ORG, pat: ENGINE_PAT }).start(enginePort)
    note(`假引擎 ${engine.origin}（org=${ORG}，PAT 校验开）`)

    serverChild = startServer(
      {
        DATABASE_URL: databaseUrl,
        CASDOOR_URL: mock.origin,
        CASDOOR_CLIENT_ID,
        CASDOOR_CLIENT_SECRET: '',
        CASDOOR_ADMIN_USER,
        CASDOOR_ADMIN_PWD,
        CASDOOR_APPLICATION: 'app-built-in',
        PLATFORM_SESSION_SECRET: SESSION_SECRET,
        PUBLIC_ORIGIN: `http://127.0.0.1:${hostPort}`,
        PORT: String(hostPort),
        TENANT_MODE: 'single',
        PLATFORM_ORG: ORG,
        // 引擎 PAT 走 secret 引用（引用名见 platform.oa_engine.pat_secret_ref）
        [PAT_SECRET_REF]: ENGINE_PAT,
      },
      'oa',
    )
    await waitReady(serverChild, hostPort, 'oa')
    note(`宿主就绪 http://127.0.0.1:${hostPort}（/healthz 200）`)

    // 引擎映射登记行：宿主 OaEnginePort 每次请求读它（无行 = OA 关闭）
    await pool.query(
      `insert into platform.oa_engine(org, base_url, pat_secret_ref, engine_version, enabled)
       values ($1,$2,$3,'fake-engine-0.1.0',true)
       on conflict (org) do update set base_url=excluded.base_url, pat_secret_ref=excluded.pat_secret_ref,
         engine_version=excluded.engine_version, enabled=true, updated_at=now()`,
      [ORG, engine.origin, PAT_SECRET_REF],
    )

    // ── 3. 授权（装载器已在启动期把码供给到 ORG；这里只把码授给人） ──
    step('3. 权限授予（租户管理员路径：MockCasdoor /api/update-permission）')
    const adminCookie = await mockAdminCookie(mock)
    /** @type {Array<[string, string[]]>} */
    const grants = [
      ['forms:manage', [U.mgr]],
      ['forms:publish', [U.mgr]],
      ['forms:approval:manage', [U.mgr, U.ai, U.nodept]],
      ['forms:approval:publish', [U.mgr, U.nodept]],
      ['forms:approval:view', [U.mgr, U.ai, U.u1, U.lead, U.hr, U.hr2, U.stranger]],
      ['forms:view', [U.u1, U.lead, U.hr, U.hr2, U.stranger, U.mgr, U.ai, U.nodept]],
      ['forms:fill', [U.u1, U.lead, U.hr, U.hr2, U.stranger, U.mgr]],
      ['forms:case:callback', [U.svc]],
      ['notify:emit', [U.svc]],
      ['notify:inbox', [U.u1, U.lead, U.hr]],
    ]
    for (const [code, users] of grants) await grantPermission(mock, adminCookie, code, users)

    // ── 4. 登录 + 服务账号 PAT ──
    step('4. 登录 + 引擎服务账号 PAT（forms:case:callback / notify:emit）')
    /** @type {Record<string, CookieJar>} */
    const jars = {}
    for (const [key, name] of Object.entries(U)) {
      const jar = new CookieJar()
      await login(hostPort, jar, name)
      jars[key] = jar
    }
    const sess = await api(hostPort, jars.svc, 'GET', '/api/platform/auth/session')
    const csrf = json(sess)?.csrfToken
    check(typeof csrf === 'string' && csrf.length > 0, '服务账号会话带 csrfToken', describe(sess))
    const patRes = await httpRequest({
      port: hostPort,
      method: 'POST',
      path: '/api/platform/keys',
      headers: { Cookie: jars.svc.header(), 'x-csrf-token': csrf },
      body: JSON.stringify({ name: `oa-p1-smoke-${SUF}` }),
    })
    const pat = json(patRes)?.token
    check(patRes.status === 201 && typeof pat === 'string' && pat.startsWith('dkq_'), '服务账号 PAT 签发 201', describe(patRes))
    engine.cfg.platformBase = `http://127.0.0.1:${hostPort}`
    engine.cfg.platformPat = pat

    // 通知链：内置模板 + 派生规则（三处同描的那条链），之后凭它产 inbox 行
    const seedOut = await runOnceCli(
      ['scripts/notify-seed-builtin.mjs'],
      { DATABASE_URL: databaseUrl },
      'notify-seed-builtin',
    )
    note(`notify seed: ${seedOut.trim().split('\n').at(-1)}`)

    // ── 5. 发布审批模板 v1 + 事项模板 ──
    step('5. 发布审批模板 v1（直属主管 → HR 指定人）+ 事项模板（mode=approval）')
    const approvalV1 = {
      provider: 'inapp',
      nodes: [
        { key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }], quorum: 'all' },
        { key: 'hr', title: 'HR', approvers: [{ source: 'user', users: [U.hr] }], quorum: 'all' },
      ],
      rejectionPolicy: 'first_reject_ends',
      selfApproval: 'skip',
      dedupe: 'first_occurrence',
      emptyNode: 'block_publish',
    }
    let res = await api(hostPort, jars.mgr, 'POST', '/api/modules/forms/approval-defs', {
      assetId: ASSETS.approval, body: approvalV1,
    })
    check(res.status === 201, `起草审批模板 ${ASSETS.approval} 201`, describe(res))

    res = await api(hostPort, jars.mgr, 'POST', `/api/modules/forms/approval-defs/${ASSETS.approval}/dry-run`, {
      payload: {}, requester: U.u1,
    })
    const dry = json(res)
    check(res.status === 200, 'dry-run 200', describe(res))
    check(
      JSON.stringify(dry?.plan?.nodes?.map((/** @type {any} */ n) => [n.key, n.approvers])) === JSON.stringify([['leader', [U.lead]], ['hr', [U.hr]]]),
      'dry-run 计划 = leader[u-lead] → hr[u-hr]',
      dry?.plan,
    )

    res = await api(hostPort, jars.mgr, 'POST', `/api/modules/forms/approval-defs/${ASSETS.approval}/versions/1/publish`, {
      payload: {}, requester: U.u1,
    })
    check(res.status === 200, '审批模板 v1 发布 200（人 gate + 编译闸）', describe(res))

    res = await api(hostPort, jars.mgr, 'POST', '/api/modules/forms/defs', {
      assetId: ASSETS.item,
      body: {
        mode: 'approval',
        provider: 'inapp',
        approvalRef: { id: ASSETS.approval, version: 1 },
        schema: {
          type: 'object',
          properties: {
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['reason'],
        },
      },
    })
    check(res.status === 201, `起草事项模板 ${ASSETS.item} 201`, describe(res))
    res = await api(hostPort, jars.mgr, 'POST', `/api/modules/forms/defs/${ASSETS.item}/versions/1/publish`)
    check(res.status === 200, '事项模板 v1 发布 200（forms:publish）', describe(res))

    // ── 6. 主路径：提交 → 两级应用内审批 → 回调 → approved ──
    step('6. 主路径：u1 提交 → u-lead 批 → 引擎进 HR → u-hr 批 → 回调 → approved')
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/defs/${ASSETS.item}/submissions`, {
      payload: { startDate: '2026-11-20', endDate: '2026-11-21', reason: '家事' },
    })
    const sub1 = json(res)
    check(res.status === 201 && sub1?.status === 'pending_approval', '提交 201 pending_approval', describe(res))
    check(typeof sub1?.caseId === 'string' && sub1.caseId.length > 0, '回执带 caseId（引擎侧建 case 成功）', sub1)
    record(
      'main.submit',
      '201 pending_approval + case_ref 非空',
      `${res.status} ${sub1?.status} caseId=${sub1?.caseId}`,
      res.status === 201 && sub1?.status === 'pending_approval' && typeof sub1.caseId === 'string',
    )
    const sub1Id = String(sub1.id)
    const case1 = engine.caseOf(sub1.caseId)
    record(
      'main.plan-snapshot',
      'plan nodes = leader[u-lead] → hr[u-hr]',
      JSON.stringify(case1.plan.nodes.map((n) => [n.key, n.approvers])),
      JSON.stringify(case1.plan.nodes.map((n) => [n.key, n.approvers]))
        === JSON.stringify([['leader', [U.lead]], ['hr', [U.hr]]]),
    )
    const createdReq = engine.requests.filter((r) => r.method === 'POST' && r.path === '/cases').at(-1)
    record(
      'main.engine-create',
      `org=${ORG} / externalRef=forms:submission:${sub1Id} / provider=inapp`,
      JSON.stringify({
        org: /** @type {any} */ (createdReq?.body)?.org,
        externalRef: /** @type {any} */ (createdReq?.body)?.externalRef,
        provider: /** @type {any} */ (createdReq?.body)?.provider,
      }),
      /** @type {any} */ (createdReq?.body)?.org === ORG
        && /** @type {any} */ (createdReq?.body)?.externalRef === `forms:submission:${sub1Id}`
        && /** @type {any} */ (createdReq?.body)?.provider === 'inapp',
    )

    // 引擎直接观测（spec §10.5）
    let eng = await httpRequest({
      port: enginePort,
      path: `/cases/${sub1.caseId}`,
      headers: { Authorization: `Bearer ${ENGINE_PAT}` },
    })
    const engDetail = json(eng)
    record(
      'main.engine-gate',
      '引擎 case: status=gate / currentNode=leader',
      `${engDetail?.status} / ${engDetail?.currentNode}`,
      engDetail?.status === 'gate' && engDetail?.currentNode === 'leader',
    )

    res = await api(hostPort, jars.lead, 'GET', `/api/modules/forms/approvals/${sub1.caseId}`)
    const detail1 = json(res)
    check(res.status === 200, 'u-lead 读审批详情 200', describe(res))
    check(detail1?.case?.currentNode === 'leader', '详情 currentNode=leader（平台代理读引擎）', detail1?.case)

    res = await api(hostPort, jars.stranger, 'GET', `/api/modules/forms/approvals/${sub1.caseId}`)
    check(res.status === 403, '无关员工读他人审批详情 403（详情授权=申请人/计划快照审批人/部门管理员）', describe(res))

    // mine 列表
    res = await api(hostPort, jars.lead, 'GET', '/api/modules/forms/approvals/mine')
    const mine = json(res)
    check(
      Array.isArray(mine?.approvals) && mine.approvals.some((/** @type {any} */ a) => a.caseId === sub1.caseId),
      'u-lead「待我审批」包含该单',
      mine,
    )

    res = await api(hostPort, jars.lead, 'POST', `/api/modules/forms/approvals/${sub1.caseId}/decision`, {
      action: 'approve', comment: '同意',
    })
    check(res.status === 200 && json(res)?.nodeKey === 'leader', 'u-lead 审批 leader 200', describe(res))
    eng = await httpRequest({ port: enginePort, path: `/cases/${sub1.caseId}`, headers: { Authorization: `Bearer ${ENGINE_PAT}` } })
    record(
      'main.node2',
      '第一节点通过后引擎进 hr（status 仍 gate）',
      `${json(eng)?.status} / ${json(eng)?.currentNode}`,
      json(eng)?.status === 'gate' && json(eng)?.currentNode === 'hr',
    )

    res = await api(hostPort, jars.hr, 'POST', `/api/modules/forms/approvals/${sub1.caseId}/decision`, {
      action: 'approve', comment: '准假',
    })
    check(res.status === 200, 'u-hr 审批 hr 200', describe(res))

    const sub1Row = (await pool.query(
      `select id, status, provider, case_ref, decided_at, decision_action,
              to_char(decided_at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') decided_at_bj
         from forms.submission where org=$1 and id=$2`, [ORG, sub1Id],
    )).rows[0]
    record(
      'main.approved',
      'submission.status=approved（回调幂等写成功）',
      JSON.stringify(sub1Row),
      sub1Row.status === 'approved' && sub1Row.decided_at !== null && sub1Row.provider === 'inapp',
    )
    const case1After = engine.caseOf(sub1.caseId)
    record(
      'main.case-closed',
      '引擎 case closed / outcome=approved / 2 个 gate.node.decided',
      `${case1After.status} / ${case1After.outcome} / decisions=${case1After.decisions.length}`,
      case1After.status === 'closed' && case1After.outcome === 'approved'
        && case1After.events.filter((e) => e.type === 'gate.node.decided').length === 2,
    )
    record(
      'main.no-duplicate-node-event',
      '无重复 gate.node.decided（每节点恰好 1 条）',
      JSON.stringify(case1After.events.filter((e) => e.type === 'gate.node.decided')),
      new Set(case1After.events.filter((e) => e.type === 'gate.node.decided').map((e) => e.nodeKey)).size === 2,
    )
    const cb1 = engine.callbacks.filter((c) => c.caseId === sub1.caseId)
    record(
      'main.callback',
      '引擎 final 回调平台 200（一次）',
      JSON.stringify(cb1),
      cb1.length === 1 && cb1[0].status === 200,
    )

    // 通知：真链（seed-builtin + worker --once）→ notify.inbox
    const workerOut = await runOnceCli(
      ['scripts/notify-worker.mjs', '--once'],
      {
        DATABASE_URL: databaseUrl,
        CASDOOR_URL: mock.origin,
        CASDOOR_CLIENT_ID,
        CASDOOR_CLIENT_SECRET: '',
        CASDOOR_ADMIN_USER,
        CASDOOR_ADMIN_PWD,
        WORKER_HEALTH_PORT: String(workerPort),
      },
      'notify-worker',
    )
    note(`notify worker: ${workerOut.trim().split('\n').at(-1)}`)
    const inbox = (await pool.query(
      `select recipient, event_id, event_key, title,
              to_char(created_at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') created_at_bj
         from notify.inbox where org=$1 and event_id=$2`,
      [ORG, `forms:submission:${sub1Id}:decided`],
    )).rows
    record(
      'main.inbox-decided',
      `notify.inbox 有 forms.approval.decided 且收件人=${U.u1}`,
      JSON.stringify(inbox),
      inbox.length === 1 && inbox[0].recipient === U.u1 && inbox[0].event_key === 'forms.approval.decided',
    )
    const inboxApi = await api(hostPort, jars.u1, 'GET', '/api/modules/notify/inbox')
    const inboxItems = json(inboxApi)?.items ?? []
    record(
      'main.inbox-api',
      'u1 经 /api/modules/notify/inbox 读到该条',
      `${inboxApi.status} items=${JSON.stringify(inboxItems.map((/** @type {any} */ i) => i.eventKey ?? i.event_key))}`,
      inboxApi.status === 200 && inboxItems.some((/** @type {any} */ i) => (i.eventKey ?? i.event_key) === 'forms.approval.decided'),
    )

    // ── 7. 撤回路径 ──
    step('7. 撤回路径：决策前撤回 200；已有决策后撤回 409 状态不变')
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/defs/${ASSETS.item}/submissions`, {
      payload: { reason: '撤回用例' },
    })
    const sub2 = json(res)
    check(res.status === 201, '新建在途单 #2 201', describe(res))
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/submissions/${sub2.id}/withdraw`, { reason: '计划取消' })
    check(res.status === 200, '提交人撤回 200', describe(res))
    const sub2Row = (await pool.query('select status, withdrawn_at from forms.submission where org=$1 and id=$2', [ORG, sub2.id])).rows[0]
    record(
      'withdraw.pending',
      'submission.status=withdrawn + withdrawn_at 落值 + 引擎 closed/withdrawn',
      `${JSON.stringify(sub2Row)} / ${engine.caseOf(sub2.caseId).outcome}`,
      sub2Row.status === 'withdrawn' && sub2Row.withdrawn_at !== null
        && engine.caseOf(sub2.caseId).status === 'closed' && engine.caseOf(sub2.caseId).outcome === 'withdrawn',
    )
    const withdrawReq = engine.requests.filter((r) => r.path.endsWith('/withdraw')).at(-1)
    record(
      'withdraw.engine',
      '引擎收到 withdraw（200，actor=提交人）',
      JSON.stringify(withdrawReq),
      withdrawReq?.status === 200 && /** @type {any} */ (withdrawReq?.body)?.actor === U.u1,
    )

    // 已有一节点决策后再撤回 → 409，状态不变
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/defs/${ASSETS.item}/submissions`, {
      payload: { reason: '决策后撤回用例' },
    })
    const sub3 = json(res)
    check(res.status === 201, '新建在途单 #3 201', describe(res))
    res = await api(hostPort, jars.lead, 'POST', `/api/modules/forms/approvals/${sub3.caseId}/decision`, { action: 'approve' })
    check(res.status === 200, 'u-lead 先批掉第一节点 200', describe(res))
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/submissions/${sub3.id}/withdraw`, {})
    const sub3Row = (await pool.query('select status from forms.submission where org=$1 and id=$2', [ORG, sub3.id])).rows[0]
    record(
      'withdraw.after-decision',
      '409（引擎已有决策）+ submission 仍 pending_approval',
      `${res.status} / ${sub3Row.status}`,
      res.status === 409 && sub3Row.status === 'pending_approval',
    )

    // ── 8. 负对照（Task 15 Step 4 全表） ──
    step('8. 负对照 1/7：org 不一致（引擎侧契约 + 平台回调侧）')
    // 8a. 引擎侧：spec §10.2「引擎单租户实例校验 org == ENGINE_ORG，不一致 403」
    res = await httpRequest({
      port: enginePort,
      method: 'POST',
      path: '/cases',
      headers: { Authorization: `Bearer ${ENGINE_PAT}` },
      body: JSON.stringify({
        org: 'beta', externalRef: 'forms:submission:999999', planVersion: 1, provider: 'inapp',
        type: 'approval', title: 'org mismatch', requesterId: U.u1, plan: { nodes: [{ key: 'a', approvers: [U.u1] }] },
      }),
    })
    record('neg.org-engine', '403（引擎拒绝跨 org 建单）', String(res.status), res.status === 403)
    // 8b. 平台回调侧（真平台代码）：raw.org ≠ 会话 org → 403 ORG_MISMATCH
    res = await httpRequest({
      port: hostPort,
      method: 'POST',
      path: '/api/modules/forms/approval-callback',
      headers: { Authorization: `Bearer ${pat}` },
      body: JSON.stringify({
        org: 'beta', caseId: sub1.caseId, externalRef: `forms:submission:${sub1Id}`,
        final: true, action: 'approved', decidedBy: U.hr, decidedAt: new Date().toISOString(),
      }),
    })
    record('neg.org-callback', '403 ORG_MISMATCH（平台只回自己租户）', `${res.status} ${json(res)?.error}`, res.status === 403)

    step('8. 负对照 2/7：无 publish scope 调 publish')
    res = await api(hostPort, jars.ai, 'POST', `/api/modules/forms/approval-defs/${ASSETS.approval}/versions/1/publish`, {})
    record('neg.no-publish-scope', '403 FORBIDDEN（宿主 declaredScopeGate，需 forms:approval:publish）', `${res.status} ${json(res)?.error}`, res.status === 403)

    step('8. 负对照 3/7：dept_leader 缺失时发布')
    await api(hostPort, jars.mgr, 'POST', '/api/modules/forms/approval-defs', {
      assetId: ASSETS.approvalNoDept,
      body: { provider: 'inapp', nodes: [{ key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }] }] },
    })
    res = await api(hostPort, jars.nodept, 'POST', `/api/modules/forms/approval-defs/${ASSETS.approvalNoDept}/versions/1/publish`, {
      requester: U.nodept,
    })
    const noDeptDetail = json(await api(hostPort, jars.mgr, 'GET', `/api/modules/forms/approval-defs/${ASSETS.approvalNoDept}`))
    record(
      'neg.dept-leader-missing',
      '409 APPROVERS_UNRESOLVED + head 不变（null，版本仍 draft）',
      `${res.status} ${json(res)?.error} head=${noDeptDetail?.head} status=${JSON.stringify(noDeptDetail?.versions?.map((/** @type {any} */ v) => v.status))}`,
      res.status === 409 && noDeptDetail?.head === null
        && JSON.stringify(noDeptDetail?.versions?.map((/** @type {any} */ v) => v.status)) === JSON.stringify(['draft']),
    )

    step('8. 负对照 4/7：回调重放两次')
    const beforeReplay = (await pool.query('select decided_at from forms.submission where org=$1 and id=$2', [ORG, sub1Id])).rows[0].decided_at
    /** @type {string[]} */
    const replayStatuses = []
    for (let i = 0; i < 2; i++) {
      const replay = await httpRequest({
        port: hostPort,
        method: 'POST',
        path: '/api/modules/forms/approval-callback',
        headers: { Authorization: `Bearer ${pat}` },
        body: JSON.stringify({
          org: ORG, caseId: sub1.caseId, externalRef: `forms:submission:${sub1Id}`, final: true,
          action: 'approved', decidedBy: U.hr, decidedAt: new Date().toISOString(), submitter: U.u1,
        }),
      })
      replayStatuses.push(`${replay.status}${json(replay)?.deduped === true ? ';deduped:true' : ''}`)
    }
    const afterReplay = (await pool.query('select decided_at from forms.submission where org=$1 and id=$2', [ORG, sub1Id])).rows[0].decided_at
    record(
      'neg.callback-replay',
      '两次重放均 200 deduped:true，decided_at 不变',
      `${JSON.stringify(replayStatuses)} decided_at ${beforeReplay?.toISOString()} → ${afterReplay?.toISOString()}`,
      replayStatuses.every((s) => s.startsWith('200') && s.includes('deduped:true'))
        && beforeReplay?.getTime() === afterReplay?.getTime(),
    )

    step('8. 负对照 5/7：在途单 + 发布模板 v2（在途单仍按 v1 计划执行）')
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/defs/${ASSETS.item}/submissions`, {
      payload: { reason: '在途单 vs v2' },
    })
    const sub4 = json(res)
    check(res.status === 201, '新建在途单 #4 201（v1 计划）', describe(res))
    const v2 = {
      provider: 'inapp',
      nodes: [
        { key: 'leader', title: '直属主管', approvers: [{ source: 'dept_leader' }], quorum: 'all' },
        { key: 'hr', title: 'HR', approvers: [{ source: 'user', users: [U.hr2] }], quorum: 'all' },
      ],
      rejectionPolicy: 'first_reject_ends',
      selfApproval: 'skip',
      dedupe: 'first_occurrence',
      emptyNode: 'block_publish',
    }
    // v2 = 同一 asset 的新 draft 版本（POST /approval-defs 递增版本号；PUT 只能改已存在的 draft）
    res = await api(hostPort, jars.mgr, 'POST', '/api/modules/forms/approval-defs', {
      assetId: ASSETS.approval, body: v2,
    })
    record('neg.inflight-v2-draft', '起草审批模板 v2 → 201 version=2', `${res.status} v${json(res)?.version}`, res.status === 201 && json(res)?.version === 2)
    res = await api(hostPort, jars.mgr, 'POST', `/api/modules/forms/approval-defs/${ASSETS.approval}/versions/2/publish`, {
      payload: {}, requester: U.u1,
    })
    check(res.status === 200, '审批模板 v2 发布 200', describe(res))
    const sub4Plan = (await pool.query('select approval_plan from forms.submission where org=$1 and id=$2', [ORG, sub4.id])).rows[0].approval_plan
    record(
      'neg.inflight-v2-snapshot',
      '在途单 #4 的 approval_plan 仍是 v1（hr 审批人=u-hr）',
      JSON.stringify(sub4Plan.nodes.map((/** @type {any} */ n) => [n.key, n.approvers])),
      JSON.stringify(sub4Plan.nodes.map((/** @type {any} */ n) => [n.key, n.approvers]))
        === JSON.stringify([['leader', [U.lead]], ['hr', [U.hr]]]),
    )
    // v2 的 hr 审批人 u-hr2 不能批在途单（平台按计划快照授权）
    await api(hostPort, jars.lead, 'POST', `/api/modules/forms/approvals/${sub4.caseId}/decision`, { action: 'approve' })
    res = await api(hostPort, jars.hr2, 'POST', `/api/modules/forms/approvals/${sub4.caseId}/decision`, { action: 'approve' })
    record('neg.inflight-v2-not-approver', '403 FORBIDDEN（v2 的 HR 不在在途计划快照里）', `${res.status} ${json(res)?.error}`, res.status === 403)
    // v1 的 HR 继续批完 → approved（证明在途单按 v1 走完）
    res = await api(hostPort, jars.hr, 'POST', `/api/modules/forms/approvals/${sub4.caseId}/decision`, { action: 'approve' })
    const sub4Row = (await pool.query('select status from forms.submission where org=$1 and id=$2', [ORG, sub4.id])).rows[0]
    record('neg.inflight-v2-finish', 'v1 的 u-hr 批完 → 200 且 submission approved', `${res.status} / ${sub4Row.status}`, res.status === 200 && sub4Row.status === 'approved')

    step('8. 负对照 6/7：并发两次 decision 同一节点')
    res = await api(hostPort, jars.u1, 'POST', `/api/modules/forms/defs/${ASSETS.item}/submissions`, {
      payload: { reason: '并发决策' },
    })
    const sub5 = json(res)
    check(res.status === 201, '新建在途单 #5 201', describe(res))
    const [r1, r2] = await Promise.all([
      api(hostPort, jars.lead, 'POST', `/api/modules/forms/approvals/${sub5.caseId}/decision`, { action: 'approve' }),
      api(hostPort, jars.lead, 'POST', `/api/modules/forms/approvals/${sub5.caseId}/decision`, { action: 'approve' }),
    ])
    const statuses = [r1.status, r2.status].sort()
    const case5 = engine.caseOf(sub5.caseId)
    record(
      'neg.concurrent-decision',
      '一个 200 / 一个 409；节点决策只落一次（不双落）',
      `statuses=${JSON.stringify(statuses)} leaderDecisions=${case5.decisions.filter((d) => d.nodeKey === 'leader').length}`,
      statuses[0] === 200 && statuses[1] === 409
        && case5.decisions.filter((d) => d.nodeKey === 'leader').length === 1,
    )
    // 收尾：让这张单走完（不影响上述断言）
    await api(hostPort, jars.hr, 'POST', `/api/modules/forms/approvals/${sub5.caseId}/decision`, { action: 'approve' })

    step('8. 负对照 7/7：未声明事件 emit')
    res = await httpRequest({
      port: hostPort,
      method: 'POST',
      path: '/api/modules/notify/emit',
      headers: { Authorization: `Bearer ${pat}` },
      body: JSON.stringify({ eventKey: 'forms.not.declared', eventId: `smoke-undeclared-${SUF}`, payload: {} }),
    })
    record('neg.undeclared-event', '400 EVENT_NOT_DECLARED', `${res.status} ${json(res)?.error}`, res.status === 400 && json(res)?.error === 'EVENT_NOT_DECLARED')

    // ── 9. 证据汇总 ──
    step('9. 证据汇总（submission / case / inbox / audit）')
    const submissions = (await pool.query(
      `select id, status, provider, case_ref, action,
              to_char(submitted_at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') submitted_at_bj,
              to_char(decided_at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') decided_at_bj
         from (
           select id, status, provider, case_ref, decision_action action, submitted_at, decided_at
             from forms.submission where org=$1 order by id
         ) s`,
      [ORG],
    )).rows
    const audit = (await pool.query(
      `select actor, action, target, detail,
              to_char(at at time zone 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') at_bj
         from forms.audit where org=$1 order by id`,
      [ORG],
    )).rows
    const cases = [...engine.cases.values()].map((c) => ({
      caseId: c.caseId,
      externalRef: c.externalRef,
      status: c.status,
      outcome: c.outcome,
      currentNode: c.currentNode,
      decisions: c.decisions,
      events: c.events,
    }))
    const finishedAt = new Date()
    const summary = {
      run: { org: ORG, suffix: SUF, startedAtBj: bj(startedAt), finishedAtBj: bj(finishedAt), hostPort, enginePort },
      results,
      failures: results.filter((r) => !r.pass).length,
      evidence: { submissions, cases, callbacks: engine.callbacks, inbox, audit },
    }
    console.log('\n===== SMOKE_RESULT_JSON_BEGIN =====')
    console.log(JSON.stringify(summary, null, 2))
    console.log('===== SMOKE_RESULT_JSON_END =====')

    check(results.length >= 20, `负对照 + 主/撤回路径断言数 ${results.length} ≥ 20`)
    const failed = results.filter((r) => !r.pass)
    if (failed.length > 0) {
      throw new SmokeFailure(
        `${failed.length} 条未过：${failed.map((r) => r.id).join(', ')}（期望/实际见上方 JSON 的 results）`,
      )
    }
    console.log(`\noa-p1-smoke: OK（${results.length} 条断言全过；${bj(finishedAt)}）`)
  } finally {
    await stopServer(serverChild, 'oa')
    await engine?.stop()
    await mock?.stop()
    await pool.end().catch(() => {})
  }
}

try {
  await main()
} catch (err) {
  console.error(
    err instanceof SmokeFailure
      ? `\noa-p1-smoke: FAILED — 断言未通过：${err.message}`
      : `\noa-p1-smoke: FAILED — ${err instanceof Error ? err.stack : String(err)}`,
  )
  process.exitCode = 1
}
