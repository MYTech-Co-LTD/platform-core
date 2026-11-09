// gen-openclaw-skill.mjs — 构建期渲染 openclaw 产物（零依赖，只用 Node 标准库）。
// 来源：modules/data/skill/{contract.json,content/**}。
// 产物：<out>/generated/tools.js + <out>/skills/data-query/SKILL.md。
// 用法：
//   node scripts/gen-openclaw-skill.mjs --plugin-dir deploy/openclaw/data-query-plugin
//   node scripts/gen-openclaw-skill.mjs --out /tmp/skill-out
// 两个参数必须且只能给一个；都不给直接报错（不默认写插件目录，避免误改 tracked 产物）。
// 规则与 modules/data/skill/render.ts 保持一致；两份实现由 gen-openclaw-skill.test.ts 的
// 同一组 golden 用例钉住。残留占位符检查与 render.ts 的「替换 today 后仍含 {{」等价：
// openclaw 内容没有 {{today}}，故直接检查任意剩余 {{（未解析/未闭合/空占位符都须炸）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(REPO_ROOT, 'modules/data/skill')
const CONTENT_DIR = join(SKILL_DIR, 'content')
const CONTRACT_PATH = join(SKILL_DIR, 'contract.json')
// 产物目录名与 content/openclaw.frontmatter.md 的 `name: data-query` 对应（openclaw 按 name 发现 skill）。
const SKILL_NAME = 'data-query'
const USAGE = '用法：node scripts/gen-openclaw-skill.mjs (--out <dir> | --plugin-dir <dir>)'

let out
let pluginDir
try {
  ;({ values: { out, 'plugin-dir': pluginDir } } = parseArgs({
    options: {
      out: { type: 'string' },
      'plugin-dir': { type: 'string' },
    },
    strict: true,
  }))
} catch (err) {
  console.error(`gen-openclaw-skill: ${err instanceof Error ? err.message : String(err)}`)
  console.error(USAGE)
  process.exit(2)
}

/** @type {string} */
let target
if (out !== undefined && pluginDir !== undefined) {
  console.error('gen-openclaw-skill: --out 与 --plugin-dir 只能给一个')
  console.error(USAGE)
  process.exit(2)
} else if (out !== undefined) {
  target = out
} else if (pluginDir !== undefined) {
  target = pluginDir
} else {
  console.error('gen-openclaw-skill: 必须给 --out 或 --plugin-dir')
  console.error(USAGE)
  process.exit(2)
}
const outDir = resolve(target)

/** contract.json 读取/解析失败都带绝对路径（与 render.ts 的 loadContract 同风格）。 */
function loadContract() {
  let raw
  try {
    raw = readFileSync(CONTRACT_PATH, 'utf8')
  } catch (err) {
    throw new Error(`gen-openclaw-skill: skill contract 读取失败：${CONTRACT_PATH}`, { cause: err })
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`gen-openclaw-skill: skill contract 不是合法 JSON：${CONTRACT_PATH}`, { cause: err })
  }
}

const contract = loadContract()
const cache = new Map()

/**
 * 读 content 相对路径的文本（进程内缓存）；缺文件报错带绝对路径。
 * @param {string} rel
 * @returns {string}
 */
function read(rel) {
  const cached = cache.get(rel)
  if (cached !== undefined) return cached
  const file = join(CONTENT_DIR, rel)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`gen-openclaw-skill: content 读取失败：${file}`, { cause: err })
  }
  cache.set(rel, text)
  return text
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
  // 任意剩余 {{ 都算错（含未闭合 `{{tool:query` 与空 `{{}}`）——与 render.ts 等价。
  const left = text.indexOf('{{')
  if (left >= 0) {
    throw new Error(`gen-openclaw-skill: 未解析/未闭合/空占位符 ${text.slice(left, left + 30)}`)
  }
  return text
}

const frontmatter = read('openclaw.frontmatter.md').trimEnd()
const body = renderFile('openclaw.md').replace(/\n+$/, '')
// 末尾补换行：与旧生产文件（14232 bytes，有尾换行）保持一致。
const skill = `${frontmatter}\n\n${body.trimStart()}\n`

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
mkdirSync(join(outDir, 'skills', SKILL_NAME), { recursive: true })
writeFileSync(join(outDir, 'generated/tools.js'), toolsJs)
writeFileSync(join(outDir, 'skills', SKILL_NAME, 'SKILL.md'), skill)
console.log(`gen-openclaw-skill: OK → ${outDir}`)
