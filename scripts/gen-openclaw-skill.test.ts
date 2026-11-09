// gen-openclaw-skill.test.ts — 构建期渲染器与平台 render.ts 的输出必须逐字一致。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
