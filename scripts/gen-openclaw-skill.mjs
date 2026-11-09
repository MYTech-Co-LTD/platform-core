#!/usr/bin/env node
// gen-openclaw-skill.mjs — 构建期渲染 openclaw 产物（零依赖，只用 Node 标准库）。
// 来源：modules/data/skill/{contract.json,content/**}。
// 产物：<out>/generated/tools.js + <out>/skills/data-query/SKILL.md。
// 用法：
//   node scripts/gen-openclaw-skill.mjs --plugin-dir deploy/openclaw/data-query-plugin
//   node scripts/gen-openclaw-skill.mjs --out /tmp/skill-out
// 规则与 modules/data/skill/render.ts 保持一致；两份实现由 gen-openclaw-skill.test.ts 的
// 同一组 golden 用例钉住。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(REPO_ROOT, 'modules/data/skill')
const CONTENT_DIR = join(SKILL_DIR, 'content')

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const pluginIndex = args.indexOf('--plugin-dir')
const outDir = outIndex >= 0
  ? resolve(args[outIndex + 1])
  : pluginIndex >= 0
    ? resolve(args[pluginIndex + 1])
    : resolve(REPO_ROOT, 'deploy/openclaw/data-query-plugin')

const contract = JSON.parse(readFileSync(join(SKILL_DIR, 'contract.json'), 'utf8'))
const cache = new Map()

/**
 * 读 content 相对路径的文本（进程内缓存）。
 * @param {string} rel
 * @returns {string}
 */
function read(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(CONTENT_DIR, rel), 'utf8'))
  return cache.get(rel)
}

/**
 * 递归解析 include 与 tool 占位符；规则与 render.ts 一致。
 * @param {string} rel
 * @param {number} [depth]
 * @returns {string}
 */
function renderFile(rel, depth = 0) {
  if (depth > 5) throw new Error(`gen-openclaw-skill: include 深度超限（${rel}）`)
  let text = read(rel)
  text = text.replace(/\{\{include:([^}]+)\}\}/g, (_, inc) => {
    const target = inc.trim()
    if (!/^[a-z0-9/_-]+\.md$/.test(target)) throw new Error(`gen-openclaw-skill: 非法 include ${target}`)
    return renderFile(target, depth + 1).replace(/\n+$/, '')
  })
  text = text.replace(/\{\{tool:([a-z0-9_-]+)\}\}/g, (_, id) => {
    const tool = contract.tools.find((/** @type {{ id: string }} */ t) => t.id === id)
    const face = tool?.channels?.openclaw
    if (face === undefined) throw new Error(`gen-openclaw-skill: openclaw 通道没有工具 ${id}`)
    return face.name
  })
  const left = text.match(/\{\{[^}]+\}\}/)
  if (left !== null) throw new Error(`gen-openclaw-skill: 未解析占位符 ${left[0]}`)
  return text
}

const frontmatter = read('openclaw.frontmatter.md').trimEnd()
const body = renderFile('openclaw.md').replace(/\n+$/, '')
const skill = `${frontmatter}\n\n${body.trimStart()}`

const defs = contract.tools
  .filter((/** @type {{ channels: { openclaw?: unknown } }} */ t) => t.channels.openclaw !== undefined)
  .map((/** @type {{ id: string, channels: { openclaw: { name: string, description: string, inputSchema: unknown } } }} */ t) => {
    const face = t.channels.openclaw
    return {
      id: t.id,
      name: face.name,
      description: face.description,
      parameters: face.inputSchema,
    }
  })

const toolsJs = `// 生成物，勿手改。来源：modules/data/skill/contract.json\n` +
  `export const TOOL_DEFS = ${JSON.stringify(defs, null, 2)}\n`

mkdirSync(join(outDir, 'generated'), { recursive: true })
mkdirSync(join(outDir, 'skills/data-query'), { recursive: true })
writeFileSync(join(outDir, 'generated/tools.js'), toolsJs)
writeFileSync(join(outDir, 'skills/data-query/SKILL.md'), skill)
console.log(`gen-openclaw-skill: OK → ${outDir}`)
