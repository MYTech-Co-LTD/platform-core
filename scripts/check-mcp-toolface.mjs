#!/usr/bin/env node
// check-mcp-toolface.mjs — MCP 工具面门禁（spec 2026-10-21 §8；第一档门禁，跑在 gates）。
//
// 用法：pnpm exec tsx scripts/check-mcp-toolface.mjs
// 契约：干净 → exit 0 + `check-mcp-toolface: OK`；违规 → exit 1，stderr 每条一行（[TOOLFACE] 标签）。
//
// 四断言（spec §8）：① 分析师面工具数 ≤14；② tools/list 静态序列化 ≤10KB；
// ③ 工具名 [A-Za-z0-9_.-]；④ mutating 工具必须有注解与 scope。
// 两面都判（Wave 3 扩面）：分析师面（ANALYST_TOOLS，≤14）+ 提案面（PIPELINE_TOOLS，≤8，
// 清单见 modules/data/domain/pipelines/tools.ts）。
// 事实源 = modules/data/domain/toolbox/registry.ts 的 ANALYST_TOOLS（显式 .ts import；
// registry 是纯的——这条 import 链不拉 pool/框架，否则门禁会连坐运行时依赖）。
import { ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS, ANALYST_TOOLS } from '../modules/data/domain/toolbox/registry.ts'
import { PIPELINE_FACE_MAX_TOOLS, PIPELINE_TOOLS } from '../modules/data/domain/pipelines/tools.ts'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 判据纯函数（单测直接喂桩清单）。
 * @param {readonly { name: string, mutating: boolean, annotations?: unknown, requiredScope: string | null }[]} metas
 * @param {{ maxTools?: number, maxBytes?: number }} [opts]
 * @returns {string[]} 违规项（空 = 干净）
 */
export function checkToolface(metas, opts = {}) {
  const maxTools = opts.maxTools ?? ANALYST_FACE_MAX_TOOLS
  const maxBytes = opts.maxBytes ?? ANALYST_FACE_MAX_LIST_BYTES
  const out = []
  if (metas.length > maxTools) {
    out.push(`[TOOLFACE] 工具面 ${metas.length} 个 > 上限 ${maxTools}（spec §8 ①）`)
  }
  const bytes = JSON.stringify(metas).length
  if (bytes > maxBytes) {
    out.push(`[TOOLFACE] tools/list 静态序列化 ${bytes} 字节 > 上限 ${maxBytes}（spec §8 ②）`)
  }
  for (const m of metas) {
    if (!TOOL_NAME_RE.test(m.name)) {
      out.push(`[TOOLFACE] 工具名 '${m.name}' 不匹配 [A-Za-z0-9_.-]（MCP 2025-11-25 命名，spec §8 ③）`)
    }
    if (m.mutating === true && (m.annotations === undefined || m.annotations === null)) {
      out.push(`[TOOLFACE] mutating 工具 '${m.name}' 缺注解（readOnlyHint 必须显式，spec §8 ④）`)
    }
    if (m.mutating === true && (m.requiredScope === null || m.requiredScope === '')) {
      out.push(`[TOOLFACE] mutating 工具 '${m.name}' 缺 requiredScope（写工具必须声明 scope，spec §8 ④）`)
    }
  }
  return out
}

// main：真仓清单判定（argv 守卫——被单测 import 时不触发，e2e-data-cross-tenant.mjs 同款先例）
if (process.argv[1]?.endsWith('check-mcp-toolface.mjs')) {
  const violations = [
    ...checkToolface(ANALYST_TOOLS),
    ...checkToolface(PIPELINE_TOOLS, { maxTools: PIPELINE_FACE_MAX_TOOLS }),
  ]
  if (violations.length > 0) {
    for (const v of violations) console.error(v)
    process.exit(1)
  }
  console.log('check-mcp-toolface: OK')
}
