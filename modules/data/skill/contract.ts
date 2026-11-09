// contract.ts — 静态工具契约的唯一事实源读取层（contract.json）。
// 为什么用 readFileSync 而不是 JSON import：本文件被 registry.ts 经 tsx 直接拉起，
// 要同时兼容 tsx / vitest / Node ESM（JSON import attributes 在三种环境下行为不一致）。
// ⚠️ 路径用 node:path + fileURLToPath，不要用 new URL(rel, import.meta.url)
//    （happy-dom 会替换 import.meta.url，见 domain/pipelines/defs.ts 的教训）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SkillChannel = 'mcp' | 'openclaw'

export interface ChannelToolFace {
  /** 该通道暴露的工具名（MCP 2025-11-25 合法名）。 */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export interface ContractTool {
  /** 逻辑 id：只用于正文占位符与测试，不暴露给 agent。 */
  id: string
  group: 'guide' | 'discovery' | 'query' | 'health'
  title: string
  /** true = 属于 ANALYST_TOOLS（data_harness_catalog 可见）；false = 静态附加工具。 */
  analyst: boolean
  requiredScope: string | null
  mutating: boolean
  annotations: { readOnlyHint: boolean }
  channels: Partial<Record<SkillChannel, ChannelToolFace>>
}

export interface SkillContract {
  version: number
  tools: ContractTool[]
}

const HERE = dirname(fileURLToPath(import.meta.url))

const CONTRACT_PATH = join(HERE, 'contract.json')

function loadContract(): SkillContract {
  let raw: string
  try {
    raw = readFileSync(CONTRACT_PATH, 'utf8')
  } catch (err) {
    throw new Error(`skill contract 读取失败：${CONTRACT_PATH}`, { cause: err })
  }
  try {
    return JSON.parse(raw) as SkillContract
  } catch (err) {
    throw new Error(`skill contract 不是合法 JSON：${CONTRACT_PATH}`, { cause: err })
  }
}

export const CONTRACT: SkillContract = loadContract()

export function toolsFor(channel: SkillChannel): ContractTool[] {
  return CONTRACT.tools.filter((t) => t.channels[channel] !== undefined)
}

export function faceOf(tool: ContractTool, channel: SkillChannel): ChannelToolFace {
  const face = tool.channels[channel]
  if (face === undefined) throw new Error(`工具 ${tool.id} 没有 ${channel} 通道`)
  return face
}
