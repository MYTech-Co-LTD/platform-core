// render.ts — 平台侧 skill 渲染（读取 content/*.md + contract.json）。
// openclaw 构建期用 scripts/gen-openclaw-skill.mjs（零依赖、规则简单到可以逐字对齐）；
// 两者由 render.test.ts / gen-openclaw-skill.test.ts 的同一组 golden 用例钉住。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT, type ContractTool, type SkillChannel } from './contract'

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'content')
const cache = new Map<string, string>()

function read(rel: string): string {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(CONTENT_DIR, rel), 'utf8'))
  return cache.get(rel)!
}

/** 四个硬约束行（从 shared.md 取，供 GUIDE_INVARIANTS 兼容层）。 */
export function guideInvariants(): readonly string[] {
  return read('shared.md')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('· '))
}

function renderFile(rel: string, channel: SkillChannel, depth = 0): string {
  if (depth > 5) throw new Error(`render: include 深度超限（${rel}）`)
  let text = read(rel)
  text = text.replace(/\{\{include:([^}]+)\}\}/g, (_, inc: string) => {
    const target = inc.trim()
    if (!/^[a-z0-9/_-]+\.md$/.test(target)) throw new Error(`render: 非法 include ${target}`)
    // 去掉 partial 的尾部换行：拼接点由调用方控制，否则会多出一个空行（golden 会红）。
    return renderFile(target, channel, depth + 1).replace(/\n+$/, '')
  })
  text = text.replace(/\{\{tool:([a-z0-9_-]+)\}\}/g, (_, id: string) => {
    const tool = CONTRACT.tools.find((t) => t.id === id)
    const face = tool?.channels[channel]
    if (face === undefined) throw new Error(`render: 通道 ${channel} 没有工具 ${id}`)
    return face.name
  })
  // {{today}} 由 renderSkill 在整篇渲染完成后注入，这里只拦其它未解析占位符。
  const left = text.match(/\{\{(?!today\}\})[^}]+\}\}/)
  if (left !== null) throw new Error(`render: 未解析占位符 ${left[0]}`)
  return text
}

export interface RenderOptions { today?: string }

/** 通道完整正文。mcp 侧 = content/mcp.md（include shared）；openclaw 侧 = content/openclaw.md。 */
export function renderSkill(channel: SkillChannel, opts: RenderOptions = {}): string {
  const text = renderFile(`${channel}.md`, channel)
  // 去尾部换行：与旧 GUIDE_TEXT_BUILDER 的 join('\n') 输出逐字对齐（golden 兜底）。
  return text.replaceAll('{{today}}', opts.today ?? '').replace(/\n+$/, '')
}

/** 契约里该通道的工具（含 analyst 与静态工具）。 */
export function contractView(channel: SkillChannel): ContractTool[] {
  return CONTRACT.tools.filter((t) => t.channels[channel] !== undefined)
}

/** MCP initialize.instructions：只放指针 + 四条硬约束，不放整份工作流。 */
export function renderInstructions(): string {
  return [
    '本服务是平台数据 MCP。开始任何数据任务前先调用 data_agent_guide 获取工作流与硬约束。',
    ...guideInvariants(),
  ].join('\n')
}
