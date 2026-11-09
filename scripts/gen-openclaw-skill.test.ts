// gen-openclaw-skill.test.ts — 构建期渲染器与平台 render.ts 的输出必须逐字一致。
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { contractView, renderSkill } from '../modules/data/skill/render.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/gen-openclaw-skill.mjs')
const out = mkdtempSync(join(tmpdir(), 'skillgen-'))

afterAll(() => rmSync(out, { recursive: true, force: true }))

function run(): void {
  execFileSync(process.execPath, [SCRIPT, '--out', out], { cwd: ROOT, stdio: 'pipe' })
}

describe('gen-openclaw-skill.mjs', () => {
  it('SKILL.md = 平台 renderSkill("openclaw") 逐字一致', () => {
    run()
    const generated = readFileSync(join(out, 'skills/data-query/SKILL.md'), 'utf8')
    const expected = readFileSync(join(ROOT, 'modules/data/skill/content/openclaw.frontmatter.md'), 'utf8').trimEnd()
      + '\n\n' + renderSkill('openclaw').trimStart()
    expect(generated).toBe(expected)
  })

  it('tools.js 的工具名 = contractView("openclaw") 的名字集合', () => {
    run()
    const source = readFileSync(join(out, 'generated/tools.js'), 'utf8')
    const defs = JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1))
    expect(defs.map((d: { name: string }) => d.name).sort())
      .toEqual(contractView('openclaw').map((t) => t.channels.openclaw!.name).sort())
  })
})

/**
 * 把脚本 + skill 正典复制到临时仓（脚本按自身位置定位 REPO_ROOT），
 * 便于往 openclaw.md 注入坏占位符后黑盒验证生成器退出码。
 */
function makeSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'skillgen-bad-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts/gen-openclaw-skill.mjs'))
  cpSync(join(ROOT, 'modules/data/skill'), join(root, 'modules/data/skill'), { recursive: true })
  return root
}

/** 期望非 0 退出；返回 stderr+message 供断言错误文案。 */
function runSandboxExpectThrow(root: string): string {
  try {
    execFileSync(
      process.execPath,
      [join(root, 'scripts/gen-openclaw-skill.mjs'), '--out', join(root, 'out')],
      { cwd: root, stdio: 'pipe' },
    )
  } catch (err) {
    const e = err as { message?: string; stderr?: Buffer }
    return `${e.message ?? ''}\n${e.stderr?.toString() ?? ''}`
  }
  throw new Error('期望生成器失败，但它成功退出了')
}

describe('残留占位符必须让构建失败（与 render.ts 同判据）', () => {
  for (const [label, broken] of [
    ['未闭合 {{tool:query', '{{tool:query'],
    ['空 {{}}', '{{}}'],
  ] as const) {
    it(`${label} → 非 0 退出`, () => {
      const root = makeSandbox()
      try {
        const file = join(root, 'modules/data/skill/content/openclaw.md')
        writeFileSync(file, `${readFileSync(file, 'utf8')}\n${broken}\n`)
        expect(runSandboxExpectThrow(root)).toContain('未解析/未闭合/空占位符')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
