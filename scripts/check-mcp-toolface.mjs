#!/usr/bin/env node
// check-mcp-toolface.mjs — MCP 工具面门禁（spec 2026-10-21 §8；第一档门禁，跑在 gates）。
//
// 用法：pnpm exec tsx scripts/check-mcp-toolface.mjs
// 契约：干净 → exit 0 + `check-mcp-toolface: OK`；违规 → exit 1，stderr 每条一行（[TOOLFACE] 标签）。
//
// 四断言（spec §8）：① 分析师面工具数 ≤14；② tools/list 静态序列化 ≤10KB；
// ③ 工具名 [A-Za-z0-9_.-]；④ mutating 工具必须有注解与 scope。
// 四个面都判：分析师面（ANALYST_TOOLS，≤14）+ manage 代理面（MANAGE_TOOLS，≤11 =
// 提案 9 + 需求台账 2，清单见 modules/data/domain/manage-face.ts）+ 通知面（NOTIFY_TOOLS）
// + **合并 manage 面**（MANAGE_FACE_TOOLS，≤20 = 口径 5 + 报表 4 + 提案/需求 11——P1 Task 6
// 扩面，销缓办⑤：P0 实证代理测不到真合并面，10308 字节漏过；预算断言按合并面计，代理保留）。
// 事实源 = registry.ts 的 ANALYST_TOOLS 与 modules/data/routes/mcp-manage-face.ts 的
// MANAGE_FACE_TOOLS（显式 .ts import；两者都是纯文件——import 链不拉 pool/框架，
// 否则门禁会连坐运行时依赖）。
import { ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS, ANALYST_TOOLS } from '../modules/data/domain/toolbox/registry.ts'
import { MANAGE_FACE_MAX_TOOLS, MANAGE_TOOLS } from '../modules/data/domain/manage-face.ts'
import { NOTIFY_MAX_TOOLS, NOTIFY_TOOLS } from '../modules/notify/mcp-tools.ts'
import { MANAGE_FACE_COMBINED_MAX_TOOLS, MANAGE_FACE_MAX_LIST_BYTES, MANAGE_FACE_TOOLS } from '../modules/data/routes/mcp-manage-face.ts'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 判据纯函数（单测直接喂桩清单）。
 * @param {readonly { name: string, mutating: boolean, annotations?: unknown, requiredScope: string | null, wire?: unknown }[]} metas
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
  // 体积量的是 tools/list 的**真实形状**：合并面元数据带 `wire`（该片在 tools/list 上的
  // 完整对象，P1 Task 6）⇒ 量 wire 投影；不带 wire 的旧清单照旧量整条元数据（字节不变）。
  const bytes = JSON.stringify(metas.map((m) => m.wire ?? m)).length
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
    ...checkToolface(MANAGE_TOOLS, { maxTools: MANAGE_FACE_MAX_TOOLS }),
    ...checkToolface(NOTIFY_TOOLS, { maxTools: NOTIFY_MAX_TOOLS }),
    // 合并面（真 tools/list 的并集）：字节量 wire 投影（9997/10240 现状）——这条才是
    // P0 漏过的那个断言；上面的 MANAGE_TOOLS 代理断言保留（治理字段齐全性照旧盯）。
    ...checkToolface(MANAGE_FACE_TOOLS, { maxTools: MANAGE_FACE_COMBINED_MAX_TOOLS, maxBytes: MANAGE_FACE_MAX_LIST_BYTES }),
  ]
  if (violations.length > 0) {
    for (const v of violations) console.error(v)
    process.exit(1)
  }
  console.log('check-mcp-toolface: OK')
}
