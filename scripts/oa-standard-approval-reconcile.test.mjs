// oa-standard-approval-reconcile.test.mjs — 标准审批小时级对账（OA P2 Task 5 / issue #2385）。
//
// 形态：**内存 store + 假 fetch**（不连库、不连网）。证明的是脚本自己的编排语义：
// 列表 → 详情 → 幂等 upsert、配置缺失跳过 + 告警、token 失败退出码、列表不可用时的
// callback_only 降级。企微响应的字段路径按 T1 取证口径（sp_no / template_id / sp_status /
// apply_time / applyer.userid / sp_record[].details[].sptime）；真实形状由 T1 笔记负责，
// 这里不替它作证。
import { describe, expect, it } from 'vitest'
import {
  detailToRow,
  mapSpStatus,
  missingCredFields,
  runReconcile,
} from './oa-standard-approval-reconcile.mjs'

const ORG = 'acme'
const PROCESS_CODE = 'PC1'

/** @returns {{ org: string, corpId: string, agentId: string, secret: string, token: string, aesKey: string }} */
function completeCreds() {
  return { org: ORG, corpId: 'corp', agentId: '1000002', secret: 'sec', token: 'tk', aesKey: 'ak' }
}

/**
 * 内存 store：upsert 按 (org, provider, providerRef) 命中同一行 —— 与真实 SQL 的
 * `on conflict` 同语义（status 后写胜、可空列 coalesce），用来证幂等而不是只数调用次数。
 * @param {{ bindings?: any[], creds?: any[], rows?: any[] }} [init]
 */
function makeStore({ bindings = [], creds = [], rows = [] } = {}) {
  const map = new Map()
  for (const r of rows) map.set(`${r.org}|${r.provider ?? 'wecom'}|${r.providerRef}`, { ...r })
  return {
    map,
    async listPublishedBindings() { return bindings },
    /** @param {string[]} orgs */
    async tenantCredentials(orgs) { return creds.filter((c) => orgs.includes(c.org)) },
    /**
     * @param {string} org
     * @param {string[]} codes
     * @param {number} limit
     */
    async listDetailMissing(org, codes, limit) {
      return [...map.values()]
        .filter((r) => r.org === org && codes.includes(r.processCode) && (r.detail === null || r.detail === undefined))
        .slice(0, limit)
        .map((r) => ({ providerRef: r.providerRef, processCode: r.processCode }))
    },
    /** @param {any} row */
    async upsertExternalApproval(row) {
      const key = `${row.org}|${row.provider}|${row.providerRef}`
      const prev = map.get(key)
      if (!prev) { map.set(key, { ...row }); return }
      map.set(key, {
        ...prev,
        processCode: row.processCode,
        title: row.title ?? prev.title,
        requester: row.requester ?? prev.requester,
        status: row.status,
        startedAt: row.startedAt ?? prev.startedAt,
        finishedAt: row.finishedAt ?? prev.finishedAt,
        detail: row.detail ?? prev.detail,
      })
    },
  }
}

/** 企微详情响应（只放本用例要断言的字段；形状按 T1 口径）。 */
/**
 * @param {string} spNo
 * @param {{ templateId?: string, spStatus?: number, applyTime?: number, sptime?: number }} [opts]
 * @returns {any}
 */
function detailPayload(spNo, { templateId = PROCESS_CODE, spStatus = 1, applyTime = 1700000000, sptime } = {}) {
  /** @type {any} */
  const info = {
    sp_no: spNo,
    template_id: templateId,
    sp_name: '差旅报销',
    sp_status: spStatus,
    apply_time: applyTime,
    applyer: { userid: 'u1' },
    apply_data: { contents: [{ control: 'Text', id: 'Text-1', title: '事由', value: { text: '出差' } }] },
  }
  if (sptime !== undefined) info.sp_record = [{ sp_status: spStatus, details: [{ sptime, approver: { userid: 'a1' } }] }]
  return { errcode: 0, errmsg: 'ok', info }
}

/**
 * 假 fetch：按 pathname 分派，记录每次调用（便于断言「没调列表」）。
 * @param {{ tokenResponse?: any, listResponse?: any, details?: Record<string, any> }} [init]
 */
function makeFetch({ tokenResponse = { errcode: 0, errmsg: 'ok', access_token: 'tok' }, listResponse, details = {} } = {}) {
  /** @type {Array<{ path: string, body: any }>} */
  const calls = []
  /**
   * @param {RequestInfo | URL} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  const fetchImpl = async (input, init = {}) => {
    const path = new URL(String(input)).pathname
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ path, body })
    /** @type {any} */
    let payload
    if (path.endsWith('/cgi-bin/gettoken')) payload = tokenResponse
    else if (path.endsWith('/cgi-bin/oa/getapprovaldata')) payload = listResponse
    else if (path.endsWith('/cgi-bin/oa/getapprovaldetail')) payload = details[body?.sp_no] ?? { errcode: 40001, errmsg: 'no stub' }
    else payload = { errcode: 404, errmsg: 'unknown path' }
    return /** @type {Response} */ ({ ok: true, status: 200, json: async () => payload })
  }
  return { calls, fetchImpl }
}

/**
 * @param {any} p  options + 捕获日志用的 `log: string[]`
 * @returns {Promise<{ exitCode: number, stats: any }>}
 */
function run(p) {
  const { log, ...rest } = p
  return runReconcile({ ...rest, log: (line) => { log.push(line) } })
}

const binding = { org: ORG, assetId: 'bao-xiao', version: 1, processCode: PROCESS_CODE, name: '差旅报销' }

describe('mapSpStatus（只映射确定语义；7/10/未知不猜）', () => {
  it('1→pending 2→approved 3→rejected 4/6→canceled', () => {
    expect(mapSpStatus(1)).toBe('pending')
    expect(mapSpStatus(2)).toBe('approved')
    expect(mapSpStatus(3)).toBe('rejected')
    expect(mapSpStatus(4)).toBe('canceled')
    expect(mapSpStatus(6)).toBe('canceled')
  })

  it('已删除(7)/已支付(10)/非数字 ⇒ null（不写不确定的状态）', () => {
    expect(mapSpStatus(7)).toBeNull()
    expect(mapSpStatus(10)).toBeNull()
    expect(mapSpStatus('2')).toBeNull()
    expect(mapSpStatus(undefined)).toBeNull()
  })
})

describe('detailToRow', () => {
  it('投影真实字段：标题/申请人/开始时间/终态办结时间/摘要，不补默认值', () => {
    const out = detailToRow(ORG, detailPayload('SP1', { spStatus: 2, applyTime: 1700000000, sptime: 1700000900 }).info)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.row).toMatchObject({
      org: ORG, provider: 'wecom', processCode: PROCESS_CODE, providerRef: 'SP1',
      title: '差旅报销', requester: 'u1', status: 'approved',
      startedAt: new Date(1700000000 * 1000),
      finishedAt: new Date(1700000900 * 1000),
    })
    expect(out.row.detail).toMatchObject({ template_id: PROCESS_CODE, sp_status: 2 })
  })

  it('pending 不写 finishedAt；缺 apply_time ⇒ startedAt=null（不拿别的时间冒充）', () => {
    const payload = detailPayload('SP2', { spStatus: 1 })
    delete payload.info.apply_time
    delete payload.info.sp_name
    delete payload.info.applyer
    const out = detailToRow(ORG, payload.info)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.row.startedAt).toBeNull()
    expect(out.row.finishedAt).toBeNull()
    expect(out.row.title).toBeNull()
    expect(out.row.requester).toBeNull()
  })

  it('未知状态 / 缺 sp_no / 缺 template_id ⇒ 带 reason 的失败（由调用方告警）', () => {
    expect(detailToRow(ORG, detailPayload('SP3', { spStatus: 7 }).info)).toEqual({ ok: false, reason: 'unknown_status' })
    const noRef = detailPayload('SP4', {})
    delete noRef.info.sp_no
    expect(detailToRow(ORG, noRef.info)).toEqual({ ok: false, reason: 'detail_incomplete' })
    const noTpl = detailPayload('SP5', {})
    delete noTpl.info.template_id
    expect(detailToRow(ORG, noTpl.info)).toEqual({ ok: false, reason: 'detail_incomplete' })
  })
})

describe('missingCredFields（只报列名，不含值）', () => {
  it('配齐 ⇒ 空；缺任一 ⇒ 对应列名', () => {
    expect(missingCredFields(completeCreds())).toEqual([])
    expect(missingCredFields({ ...completeCreds(), aesKey: null })).toEqual(['aes_key'])
    expect(missingCredFields({ ...completeCreds(), corpId: '' })).toEqual(['corp_id'])
    expect(missingCredFields(undefined)).toEqual(['tenant_row'])
  })
})

describe('runReconcile', () => {
  it('列表 2 条 → upsert 2 条；第二次跑幂等（行数不增、状态后写胜）', async () => {
    const store = makeStore({ bindings: [binding], creds: [completeCreds()] })
    const { fetchImpl, calls } = makeFetch({
      listResponse: { errcode: 0, errmsg: 'ok', data: { sp_no_list: ['SP1', 'SP2'], next_cursor: '' } },
      details: {
        SP1: detailPayload('SP1', { spStatus: 1, applyTime: 1700000100 }),
        SP2: detailPayload('SP2', { spStatus: 2, applyTime: 1700000200, sptime: 1700000900 }),
      },
    })
    const logs = /** @type {string[]} */ ([])

    const first = await run({ store, fetchImpl, log: logs })
    expect(first.exitCode).toBe(0)
    expect(first.stats).toMatchObject({ bindings: 1, tenants: 1, synced: 2, skipped: 0, errors: 0 })
    expect(store.map.size).toBe(2)
    expect(store.map.get(`${ORG}|wecom|SP1`).status).toBe('pending')
    expect(store.map.get(`${ORG}|wecom|SP2`).status).toBe('approved')
    expect(store.map.get(`${ORG}|wecom|SP2`).finishedAt).toEqual(new Date(1700000900 * 1000))

    // 列表请求确实带时间窗与游标参数
    const listCall = calls.find((c) => c.path.endsWith('/getapprovaldata'))
    expect(listCall?.body).toMatchObject({ cursor: '', size: 100 })
    expect(typeof listCall?.body.starttime).toBe('number')
    expect(listCall?.body.endtime).toBeGreaterThan(listCall?.body.starttime)

    // 第二次跑：同一批 SpNo，幂等键命中原行 ⇒ 不新增
    const second = await run({ store, fetchImpl, log: logs })
    expect(second.exitCode).toBe(0)
    expect(second.stats.synced).toBe(2)
    expect(store.map.size).toBe(2)
  })

  it('token 失败 ⇒ 退出码非 0 + evt=token_failed，且不调列表/不写行', async () => {
    const store = makeStore({ bindings: [binding], creds: [completeCreds()] })
    const { fetchImpl, calls } = makeFetch({ tokenResponse: { errcode: 40001, errmsg: 'invalid credential' } })
    const logs = /** @type {string[]} */ ([])

    const result = await run({ store, fetchImpl, log: logs })

    expect(result.exitCode).toBe(1)
    expect(result.stats.errors).toBe(1)
    expect(store.map.size).toBe(0)
    expect(calls.some((c) => c.path.endsWith('/getapprovaldata'))).toBe(false)
    expect(logs.some((l) => l.includes('evt=token_failed'))).toBe(true)
    // 敏感值绝不进日志
    expect(logs.join('\n')).not.toContain('sec')
  })

  it('租户凭据缺列 ⇒ 跳过 + evt=config_missing（退出码 0，不阻塞别的租户）', async () => {
    const store = makeStore({ bindings: [binding], creds: [{ ...completeCreds(), aesKey: null }] })
    const { fetchImpl, calls } = makeFetch({ listResponse: { errcode: 0, data: { sp_no_list: [] } } })
    const logs = /** @type {string[]} */ ([])

    const result = await run({ store, fetchImpl, log: logs })

    expect(result.exitCode).toBe(0)
    expect(result.stats).toMatchObject({ tenants: 0, skipped: 1, synced: 0 })
    expect(result.stats.configMissingOrgs).toEqual([ORG])
    expect(calls).toHaveLength(0)
    expect(logs.some((l) => l.includes('evt=config_missing') && l.includes('aes_key'))).toBe(true)
  })

  it('列表端点不可用 ⇒ 降级补详情（detail is null 的行被补齐）并显式 discovery=callback_only', async () => {
    const pendingRow = {
      org: ORG, provider: 'wecom', processCode: PROCESS_CODE, providerRef: 'SP9',
      title: null, requester: null, status: 'pending', startedAt: null, finishedAt: null, detail: null,
    }
    const store = makeStore({ bindings: [binding], creds: [completeCreds()], rows: [pendingRow] })
    const { fetchImpl } = makeFetch({
      listResponse: { errcode: 301002, errmsg: 'api not authorized' },
      details: {
        SP9: detailPayload('SP9', { spStatus: 2, applyTime: 1700000000, sptime: 1700000800 }),
      },
    })
    const logs = /** @type {string[]} */ ([])

    const result = await run({ store, fetchImpl, log: logs })

    expect(result.exitCode).toBe(0)
    expect(result.stats.discovery).toBe('callback_only')
    expect(result.stats.detailFilled).toBe(1)
    expect(result.stats.listUnavailableOrgs).toEqual([ORG])
    expect(store.map.get(`${ORG}|wecom|SP9`).status).toBe('approved')
    expect(store.map.get(`${ORG}|wecom|SP9`).detail).not.toBeNull()
    expect(logs.some((l) => l.includes('discovery=callback_only'))).toBe(true)
    expect(logs.some((l) => l.includes('evt=list_unavailable'))).toBe(true)
  })

  it('--mode=detail 直接走降级通路，不调列表端点', async () => {
    const store = makeStore({
      bindings: [binding],
      creds: [completeCreds()],
      rows: [{ org: ORG, provider: 'wecom', processCode: PROCESS_CODE, providerRef: 'SP8', title: 't', requester: 'u', status: 'pending', startedAt: null, finishedAt: null, detail: null }],
    })
    const { fetchImpl, calls } = makeFetch({ details: { SP8: detailPayload('SP8', { spStatus: 1 }) } })
    const logs = /** @type {string[]} */ ([])

    const result = await run({ store, fetchImpl, mode: 'detail', log: logs })

    expect(result.exitCode).toBe(0)
    expect(result.stats.discovery).toBe('callback_only')
    expect(calls.some((c) => c.path.endsWith('/getapprovaldata'))).toBe(false)
    expect(store.map.get(`${ORG}|wecom|SP8`).detail).not.toBeNull()
  })

  it('不属本租户绑定的模板 ⇒ 不写行，但计数并打 evt=unknown_template（不静默丢）', async () => {
    const store = makeStore({ bindings: [binding], creds: [completeCreds()] })
    const { fetchImpl } = makeFetch({
      listResponse: { errcode: 0, data: { sp_no_list: ['SP-OTHER'], next_cursor: '' } },
      details: { 'SP-OTHER': detailPayload('SP-OTHER', { templateId: 'PC-OTHER' }) },
    })
    const logs = /** @type {string[]} */ ([])

    const result = await run({ store, fetchImpl, log: logs })

    expect(result.exitCode).toBe(0)
    expect(store.map.size).toBe(0)
    expect(logs.some((l) => l.includes('evt=unknown_template') && l.includes('count=1'))).toBe(true)
  })

  it('未知状态（如已删除 7）⇒ 跳过 + 告警，不写不确定状态', async () => {
    const store = makeStore({ bindings: [binding], creds: [completeCreds()] })
    const { fetchImpl } = makeFetch({
      listResponse: { errcode: 0, data: { sp_no_list: ['SP-DEL'], next_cursor: '' } },
      details: { 'SP-DEL': detailPayload('SP-DEL', { spStatus: 7 }) },
    })
    const logs = /** @type {string[]} */ ([])

    const result = await run({ store, fetchImpl, log: logs })

    expect(result.exitCode).toBe(0)
    expect(store.map.size).toBe(0)
    expect(result.stats.skipped).toBe(1)
    expect(result.stats.errors).toBe(1)
    expect(logs.some((l) => l.includes('evt=unknown_status'))).toBe(true)
  })

  it('dry-run 只统计不写库', async () => {
    const store = makeStore({ bindings: [binding], creds: [completeCreds()] })
    const { fetchImpl } = makeFetch({
      listResponse: { errcode: 0, data: { sp_no_list: ['SP1'], next_cursor: '' } },
      details: { SP1: detailPayload('SP1', { spStatus: 1 }) },
    })

    const result = await run({ store, fetchImpl, dryRun: true, log: /** @type {string[]} */ ([]) })

    expect(result.stats.synced).toBe(1)
    expect(store.map.size).toBe(0)
  })
})
