// sandbox.ts —— run_pipeline_sandbox：校验闸 + 在沙箱 console 真跑（#1002 / D-W3-4）。
//
// 顺序固定：**结构 → 组件策略 → 写入面 → 执行**。前三道是纯函数，跑不起来也不该跳过；
// 第四道才是网络与引擎。执行面的决策与口径见 `docs/architecture.md` §2.8。
//
// 失败语义（§2.8 的表，改这里先改文档）：
//   · 管线跑失败（引擎报红）⇒ `failed / pipeline_failed` + `isError: true` —— 这是**关于草案的结论**，
//     不是工具坏了；审计判决仍是 ok（`verdictOf` 不改语义）。
//   · 执行面不可达 ⇒ `unknown / sandbox_unreachable` + `isError: true` —— 「不知道跑没跑」，不是拒绝。
//   · 超时仍 running ⇒ `running` + `runId`，`isError: false` —— 引擎还在跑，别报成失败。
import { randomUUID } from 'node:crypto'
import { sandboxComponentViolations, sandboxViolations, validatePipelineDraft } from './validate'
import { SandboxUnreachableError } from './sandbox-runner'
import type { PipelineImpl } from './types'

const NOTE_UNCONFIGURED = '本服务未接沙箱执行面（`DATA_SANDBOX_URL` 未配）⇒ 只做了结构校验、组件策略与'
  + '沙箱前缀断言，**没有执行任何管线**。接入方式见 docs/architecture.md §2.8。'
const NOTE_COMPONENT = '沙箱只跑数据搬运/变换类组件；执行任意代码（`code.*`）与委托子管线（`ctl.foreach`）一律不跑。'
const NOTE_PREFIX = '沙箱试跑不得写正式湖、不得对外发数据——改了再试。'
const NOTE_OK = '已在沙箱 console 真跑：默认档**不带任何生产凭据**，源端读的是公开/无鉴权端点。'
  + '此结果只反映这一次执行，不代表口径正确（口径靠 dbt tests 与对账）。'
const NOTE_FAILED = '管线在沙箱里跑了但失败了（引擎报红）——这是关于草案的结论，按 error / nodes 里的节点定位。'
const NOTE_RUNNING = '到等待上限仍未结束：引擎可能还在跑。用 runId 对应的草案文件与 `list_pipeline_runs` 继续追，'
  + '不要据此判失败。'
const NOTE_BUSY = '沙箱同一时刻只跑一条（单飞）：上一次试跑还没结束。稍后重试。'

/**
 * 单飞：一个 console = 一个 workspace，同时跑两条会互相踩回执认领（见 sandbox-runner 的 `freshReceipt`）。
 * 进程级标志足够——`server` 是单实例；多实例部署时这一层要换成 console 侧的锁（§2.8 反转条件）。
 */
let inFlight = false

const newRunId = (): string => `sbx-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`

export const runPipelineSandboxImpl: PipelineImpl = async (deps, args) => {
  const structure = validatePipelineDraft(args.pipeline)
  if (structure.length > 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: structure }, isError: true, auditRowCount: null }
  }
  const components = sandboxComponentViolations(args.pipeline)
  if (components.length > 0) {
    return {
      payload: { status: 'denied', reason: 'component_not_allowed', violations: components, note: NOTE_COMPONENT },
      isError: true, auditRowCount: null,
    }
  }
  const violations = sandboxViolations(args.pipeline)
  if (violations.length > 0) {
    return {
      payload: { status: 'denied', reason: 'sandbox_prefix_violation', violations, note: NOTE_PREFIX },
      isError: true, auditRowCount: null,
    }
  }

  const runner = deps.sandbox
  if (runner === null) {
    return {
      payload: {
        status: 'not_executed', reason: 'sandbox_runner_unconfigured',
        checked: { structure: true, components: true, sandboxPrefix: true }, note: NOTE_UNCONFIGURED,
      },
      isError: false, auditRowCount: null,
    }
  }
  if (inFlight) {
    return { payload: { status: 'denied', reason: 'sandbox_busy', note: NOTE_BUSY }, isError: true, auditRowCount: null }
  }

  inFlight = true
  const runId = newRunId()
  try {
    const outcome = await runner.run(args.pipeline, runId)
    const where = { runId: outcome.runId, file: outcome.file }
    const timing = {
      ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
      ...(outcome.rows === undefined ? {} : { rows: outcome.rows }),
    }
    if (outcome.status === 'ok') {
      return {
        payload: { status: 'ok', ...where, ...timing, ...(outcome.nodes === undefined ? {} : { nodes: outcome.nodes }), note: NOTE_OK },
        isError: false, auditRowCount: outcome.rows ?? null,
      }
    }
    if (outcome.status === 'failed') {
      return {
        payload: { status: 'failed', reason: 'pipeline_failed', ...where, ...timing, ...(outcome.error === undefined ? {} : { error: outcome.error }), note: NOTE_FAILED },
        isError: true, auditRowCount: null,
      }
    }
    return { payload: { status: 'running', ...where, note: NOTE_RUNNING }, isError: false, auditRowCount: null }
  } catch (err) {
    if (err instanceof SandboxUnreachableError) {
      return {
        payload: { status: 'unknown', reason: 'sandbox_unreachable', detail: err.message, runId, note: '执行面没接上（网络/鉴权/非 JSON）：**不知道跑没跑**，不是拒绝。' },
        isError: true, auditRowCount: null,
      }
    }
    throw err
  } finally {
    inFlight = false
  }
}
