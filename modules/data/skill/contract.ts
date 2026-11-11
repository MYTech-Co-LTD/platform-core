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

/**
 * 运行时**支持的**契约版本（Wave 2.2 版本门）。
 *
 * 为什么要这一行：`contract.json` 的 `version` 之前**没有任何运行时消费者**（只有单测判「是正整数」），
 * 于是「改了契约形状但没改代码假设」和「改了代码但没动契约」两种漂移都只会在运行期以
 * undefined 字段的形式出现。现在装载即比对：不一致 ⇒ 模块装载失败（部署失败，不是告警）。
 * **改契约形状必须同时改这里**——这是有意的摩擦，让版本号成为一次评审点。
 */
export const SUPPORTED_CONTRACT_VERSION = 1

const GROUPS: ReadonlySet<string> = new Set(['guide', 'discovery', 'query', 'health'])
const CHANNELS: ReadonlySet<string> = new Set(['mcp', 'openclaw'])
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 契约形状/版本校验（纯函数；装载期与单测共用同一份判定）。
 *
 * 只判**运行时真的会读的字段**——不做「把 JSON Schema 抄一遍」的全量校验：抄一遍的代价是
 * 每加一个可选字段都要改两处，而收益只是更早报同一类错。
 */
export function contractViolations(raw: unknown): string[] {
  const out: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['契约根必须是对象']
  }
  const obj = raw as Record<string, unknown>
  if (!Number.isInteger(obj.version)) {
    out.push(`version 必须是整数（实际 ${JSON.stringify(obj.version)}）`)
  } else if (obj.version !== SUPPORTED_CONTRACT_VERSION) {
    out.push(`契约 version=${String(obj.version)}，运行时支持 ${SUPPORTED_CONTRACT_VERSION}——改形状必须同时改 SUPPORTED_CONTRACT_VERSION`)
  }
  if (!Array.isArray(obj.tools) || obj.tools.length === 0) {
    out.push('tools 必须是非空数组')
    return out
  }
  const seenIds = new Set<string>()
  obj.tools.forEach((t, i) => {
    const at = `tools[${i}]`
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      out.push(`${at} 必须是对象`)
      return
    }
    const tool = t as Record<string, unknown>
    if (typeof tool.id !== 'string' || tool.id === '') out.push(`${at}.id 必须是非空字符串`)
    else if (seenIds.has(tool.id)) out.push(`${at}.id '${tool.id}' 重复`)
    else seenIds.add(tool.id)
    if (typeof tool.group !== 'string' || !GROUPS.has(tool.group)) {
      out.push(`${at}.group 必须是 ${[...GROUPS].join('/')} 之一`)
    }
    if (typeof tool.analyst !== 'boolean') out.push(`${at}.analyst 必须是布尔`)
    if (typeof tool.mutating !== 'boolean') out.push(`${at}.mutating 必须是布尔`)
    if (tool.requiredScope !== null && typeof tool.requiredScope !== 'string') {
      out.push(`${at}.requiredScope 必须是字符串或 null`)
    }
    const channels = tool.channels
    if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) {
      out.push(`${at}.channels 必须是对象`)
      return
    }
    const names = Object.keys(channels as Record<string, unknown>)
    if (names.length === 0) out.push(`${at}.channels 至少要有 mcp / openclaw 之一`)
    for (const ch of names) {
      if (!CHANNELS.has(ch)) out.push(`${at}.channels.${ch} 不是已知通道`)
      const face = (channels as Record<string, unknown>)[ch]
      if (face === null || typeof face !== 'object' || Array.isArray(face)) {
        out.push(`${at}.channels.${ch} 必须是对象`)
        continue
      }
      const name = (face as Record<string, unknown>).name
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
        out.push(`${at}.channels.${ch}.name 必须匹配 ${TOOL_NAME_RE}`)
      }
    }
  })
  return out
}

function loadContract(): SkillContract {
  let raw: string
  try {
    raw = readFileSync(CONTRACT_PATH, 'utf8')
  } catch (err) {
    throw new Error(`skill contract 读取失败：${CONTRACT_PATH}`, { cause: err })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`skill contract 不是合法 JSON：${CONTRACT_PATH}`, { cause: err })
  }
  const violations = contractViolations(parsed)
  if (violations.length > 0) {
    // fail-closed：装载期抛 ⇒ 模块起不来（部署失败）。契约是工具面的唯一事实源，
    // 「形状不对但先跑着」会让 agent 拿到半张工具面，比起不来更糟。
    throw new Error(`skill contract 校验失败（${CONTRACT_PATH}）：\n${violations.map((v) => `  - ${v}`).join('\n')}`)
  }
  return parsed as SkillContract
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
