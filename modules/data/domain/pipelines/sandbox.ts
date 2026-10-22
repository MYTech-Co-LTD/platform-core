// sandbox.ts —— run_pipeline_sandbox：**校验闸**，本轮不执行（D-W3-4）。
//
// 为什么不执行：真机实测 server 容器内既无 duckle 二进制也无 runner 入口；而 spec 红线是
// 「产物写 __sandbox 前缀、不入正式湖」——没有「确实只写 __sandbox」的执行面，宁可不跑，
// 也不给一个看起来成功的结果。执行侧待沉淀（需要一条真机验证过的运行通道 + CLI 形态）。
//
// 本文件是纯校验闸：不读盘、不写盘、不起进程、不联网。写闸（mutatingAllowed(env)）由路由片
// 统一做，不在这里；可选参数 `note` 由审计单点处理，本文件只读 args.pipeline。
import { sandboxViolations, validatePipelineDraft } from './validate'
import type { PipelineImpl } from './types'

const NOTE = '待沉淀：本服务容器内没有 duckle 运行面（实测无 duckle / duckle-runner 二进制），'
  + '故只做结构校验与沙箱前缀断言，**没有执行任何管线**。执行通道需真机验证后另案接入。'

export const runPipelineSandboxImpl: PipelineImpl = async (_deps, args) => {
  const structure = validatePipelineDraft(args.pipeline)
  if (structure.length > 0) {
    return { payload: { status: 'refused', reason: 'invalid_draft', issues: structure }, isError: true, auditRowCount: null }
  }
  const violations = sandboxViolations(args.pipeline)
  if (violations.length > 0) {
    return {
      payload: {
        status: 'denied', reason: 'sandbox_prefix_violation',
        violations,
        note: '沙箱试跑不得写正式湖、不得对外发数据——改了再试。',
      },
      isError: true, auditRowCount: null,
    }
  }
  return {
    payload: {
      status: 'not_executed', reason: 'sandbox_runner_unavailable',
      checked: { structure: true, sandboxPrefix: true }, note: NOTE,
    },
    isError: false, auditRowCount: null,
  }
}
