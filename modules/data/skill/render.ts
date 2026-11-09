// render.ts — 平台侧 skill 渲染（读取 content/*.md + contract.json）。
// openclaw 构建期渲染器在 Task 4 引入，接线后由对应 golden 钉住与这里的逐字一致。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT, faceOf, toolsFor, type ContractTool, type SkillChannel } from './contract'

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'content')
const cache = new Map<string, string>()
const MAX_INCLUDE_DEPTH = 5

/** content 相对路径 → 文本。生产用真实文件读取；测试注入桩文本。 */
export type ContentReader = (rel: string) => string

function read(rel: string): string {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(CONTENT_DIR, rel), 'utf8'))
  return cache.get(rel)!
}

/** 四个硬约束行（从 shared.md 取，供 GUIDE_INVARIANTS 兼容层）。 */
export function guideInvariants(): readonly string[] {
  const lines = read('shared.md')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('· '))
  // 防静默丢硬约束：shared.md 被改成非「· 」前缀时必须炸，而不是悄悄少几行。
  if (lines.length !== 4) {
    throw new Error(`render: shared.md 硬约束应为 4 行，实际 ${lines.length} 行`)
  }
  return lines
}

export interface RenderOptions { today?: string }

/**
 * 渲染核心（纯函数）：文本 + 通道 + 日期 + 可注入的 content 读取器。
 * 处理 include（递归、去 partial 尾部换行）与 tool 占位符；caller 负责尾部换行裁剪。
 */
export function renderText(
  text: string,
  channel: SkillChannel,
  opts: RenderOptions,
  reader: ContentReader,
  depth = 0,
): string {
  let out = text.replace(/\{\{include:([^}]+)\}\}/g, (_, inc: string) => {
    const target = inc.trim()
    if (!/^[a-z0-9/_-]+\.md$/.test(target)) throw new Error(`render: 非法 include ${target}`)
    if (depth >= MAX_INCLUDE_DEPTH) throw new Error(`render: include 深度超限（${target}）`)
    // 去掉 partial 的尾部换行：拼接点由调用方控制，否则会多出一个空行（golden 会红）。
    return renderText(reader(target), channel, opts, reader, depth + 1).replace(/\n+$/, '')
  })
  out = out.replace(/\{\{tool:([a-z0-9_-]+)\}\}/g, (_, id: string) => {
    const tool = CONTRACT.tools.find((t) => t.id === id)
    const face = tool?.channels[channel]
    if (face === undefined) throw new Error(`render: 通道 ${channel} 没有工具 ${id}`)
    return face.name
  })
  if (out.includes('{{today}}')) {
    // 日期缺失不能静默渲染成空串——那会让 agent 看到「今天是 （Asia/Shanghai）」。
    if (opts.today === undefined) throw new Error('render: 正文含 {{today}} 但未注入 opts.today')
    out = out.replaceAll('{{today}}', opts.today)
  }
  // 替换 today 后仍含 {{：未解析/未闭合/空占位符（如 {{tool:query、{{}}）。
  if (out.replaceAll('{{today}}', '').includes('{{')) {
    const at = out.replaceAll('{{today}}', '').indexOf('{{')
    throw new Error(`render: 未解析占位符 ${out.slice(at, at + 40)}`)
  }
  return out
}

/** 通道完整正文。mcp 侧 = content/mcp.md（include shared）；openclaw 侧 = content/openclaw.md。 */
export function renderSkill(channel: SkillChannel, opts: RenderOptions = {}): string {
  // 去尾部换行：与旧 GUIDE_TEXT_BUILDER 的 join('\n') 输出逐字对齐（golden 兜底）。
  return renderText(read(`${channel}.md`), channel, opts, read).replace(/\n+$/, '')
}

/** 契约里该通道的工具（含 analyst 与静态工具）——直接复用 contract.ts 的过滤。 */
export function contractView(channel: SkillChannel): ContractTool[] {
  return toolsFor(channel)
}

/** MCP initialize.instructions：只放指针 + 四条硬约束，不放整份工作流。 */
export function renderInstructions(): string {
  const guide = toolsFor('mcp').find((t) => t.id === 'guide')
  if (guide === undefined) throw new Error('render: 契约缺 guide 的 mcp 通道')
  return [
    `本服务是平台数据 MCP。开始任何数据任务前先调用 ${faceOf(guide, 'mcp').name} 获取工作流与硬约束。`,
    ...guideInvariants(),
  ].join('\n')
}
