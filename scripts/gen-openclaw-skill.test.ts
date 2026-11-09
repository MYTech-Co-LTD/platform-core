// gen-openclaw-skill.test.ts — 构建期渲染器与平台 render.ts 的输出必须逐字一致。
// 另含黑盒探针：把脚本 + 最小输入复制到临时仓，验证 CLI 参数与各类错误分支。
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contractView, renderSkill } from '../modules/data/skill/render.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/gen-openclaw-skill.mjs')
const CONTENT_DIR = join(ROOT, 'modules/data/skill/content')
const out = mkdtempSync(join(tmpdir(), 'skillgen-'))

beforeAll(() => {
  execFileSync(process.execPath, [SCRIPT, '--out', out], { cwd: ROOT, stdio: 'pipe' })
  // 临时目录没有 package.json 时 .js 默认按 CJS 解析；生成物是 ESM（export const）。
  writeFileSync(join(out, 'package.json'), '{"type":"module"}\n')
})

afterAll(() => rmSync(out, { recursive: true, force: true }))

describe('生成物与平台渲染一致', () => {
  it('SKILL.md = frontmatter 前缀 + renderSkill("openclaw") 正文（含尾换行）', () => {
    const generated = readFileSync(join(out, 'skills/data-query/SKILL.md'), 'utf8')
    const frontmatter = readFileSync(join(CONTENT_DIR, 'openclaw.frontmatter.md'), 'utf8').trimEnd()
    const prefix = `${frontmatter}\n\n`
    // 分别断言前缀与正文，避免「两边同一种拼装方式」造成的 false-green。
    expect(generated.startsWith(prefix)).toBe(true)
    expect(generated.slice(prefix.length).replace(/\n+$/, '')).toBe(renderSkill('openclaw'))
    // 生成物末尾补换行（与旧生产文件一致）。
    expect(generated.endsWith('\n')).toBe(true)
  })

  it('tools.js 的 TOOL_DEFS 与 contractView("openclaw") 深等（内容 + 顺序）', async () => {
    const mod = await import(pathToFileURL(join(out, 'generated/tools.js')).href)
    const expected = contractView('openclaw').map((t) => {
      const face = t.channels.openclaw!
      return { id: t.id, name: face.name, description: face.description, parameters: face.inputSchema }
    })
    expect(mod.TOOL_DEFS).toEqual(expected)
    expect(mod.TOOL_DEFS).toHaveLength(7)
  })
})

/**
 * 把脚本 + skill 最小输入（contract.json + content/）复制到临时仓。
 * 脚本按自身位置定位 REPO_ROOT，故可在沙箱里黑盒跑失败分支。
 */
function makeSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'skillgen-sandbox-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'modules/data/skill'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts/gen-openclaw-skill.mjs'))
  cpSync(join(ROOT, 'modules/data/skill/contract.json'), join(root, 'modules/data/skill/contract.json'))
  cpSync(CONTENT_DIR, join(root, 'modules/data/skill/content'), { recursive: true })
  return root
}

function withSandbox(fn: (root: string) => void): void {
  const root = makeSandbox()
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 期望非 0 退出；返回 stderr + message 供断言错误文案。 */
function runSandboxExpectThrow(root: string, args: string[]): string {
  try {
    execFileSync(
      process.execPath,
      [join(root, 'scripts/gen-openclaw-skill.mjs'), ...args],
      { cwd: root, stdio: 'pipe' },
    )
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer }
    return `${e.message ?? ''}\n${e.stderr?.toString() ?? ''}`
  }
  throw new Error(`期望生成器失败，但它成功退出了：${args.join(' ')}`)
}

function openclawFile(root: string): string {
  return join(root, 'modules/data/skill/content/openclaw.md')
}

function appendToOpenclaw(root: string, text: string): void {
  const file = openclawFile(root)
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n${text}\n`)
}

describe('CLI 参数安全（不默认写插件目录）', () => {
  it('不给参数 → 非 0，打印用法', () => withSandbox((root) => {
    const msg = runSandboxExpectThrow(root, [])
    expect(msg).toContain('必须给 --out 或 --plugin-dir')
    expect(msg).toContain('用法：node scripts/gen-openclaw-skill.mjs')
  }))

  it('--out 与 --plugin-dir 同时给 → 非 0', () => withSandbox((root) => {
    const msg = runSandboxExpectThrow(root, ['--out', join(root, 'out'), '--plugin-dir', join(root, 'plugin')])
    expect(msg).toContain('只能给一个')
  }))

  it('未知 flag → 非 0（strict）', () => withSandbox((root) => {
    const msg = runSandboxExpectThrow(root, ['--nope'])
    expect(msg).toContain('--nope')
  }))

  it('值缺失 → 非 0（strict）', () => withSandbox((root) => {
    expect(runSandboxExpectThrow(root, ['--out'])).toMatch(/argument missing|缺/)
  }))
})

describe('残留/非法占位符必须让构建失败（与 render.ts 同判据）', () => {
  for (const [label, broken, expected] of [
    ['未闭合 {{tool:query', '{{tool:query', '未解析/未闭合/空占位符'],
    ['空 {{}}', '{{}}', '未解析/未闭合/空占位符'],
    ['非法 include ../secret.md', '{{include:../secret.md}}', '非法 include ../secret.md'],
    ['未知 tool id', '{{tool:nope}}', '没有工具 nope'],
  ] as const) {
    it(`${label} → 非 0 退出`, () => withSandbox((root) => {
      appendToOpenclaw(root, broken)
      expect(runSandboxExpectThrow(root, ['--out', join(root, 'out')])).toContain(expected)
    }))
  }

  it('include 深度超限 → 非 0 退出', () => withSandbox((root) => {
    appendToOpenclaw(root, '{{include:openclaw.md}}')
    expect(runSandboxExpectThrow(root, ['--out', join(root, 'out')])).toContain('include 深度超限')
  }))
})

describe('输入缺失/损坏的报错带绝对路径', () => {
  it('contract.json 缺失 → 读取失败 + 路径', () => withSandbox((root) => {
    rmSync(join(root, 'modules/data/skill/contract.json'))
    const msg = runSandboxExpectThrow(root, ['--out', join(root, 'out')])
    expect(msg).toContain('skill contract 读取失败')
    expect(msg).toContain(join(root, 'modules/data/skill/contract.json'))
  }))

  it('contract.json 非法 JSON → 解析失败 + 路径', () => withSandbox((root) => {
    const file = join(root, 'modules/data/skill/contract.json')
    writeFileSync(file, '{ not json')
    const msg = runSandboxExpectThrow(root, ['--out', join(root, 'out')])
    expect(msg).toContain('不是合法 JSON')
    expect(msg).toContain(file)
  }))

  it('content 文件缺失 → 读取失败 + 路径', () => withSandbox((root) => {
    rmSync(join(root, 'modules/data/skill/content/shared.md'))
    const msg = runSandboxExpectThrow(root, ['--out', join(root, 'out')])
    expect(msg).toContain('content 读取失败')
    expect(msg).toContain(join(root, 'modules/data/skill/content/shared.md'))
  }))
})
