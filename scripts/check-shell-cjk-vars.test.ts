// scripts/check-shell-cjk-vars.test.ts — #212 守卫的 fixtures 测试（混合式：纯函数 + 黑盒 CLI）。
//
// 三层：
//   ① 判据本体（`scanShellCjkVars`，纯函数）——注入必红 / 三种正确写法不得误伤 / 注释豁免；
//   ② `shellFiles` 的选取面（需 git 夹具：无 `.sh` 后缀但有 sh shebang 的文件也要扫）；
//   ③ 黑盒 CLI 跑**真实仓**必须 exit 0（钉「守卫落了、仓里却还有未收口变量」这条漂移）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { scanShellCjkVars, shellFiles } from './check-shell-cjk-vars.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const GUARD = join(repoRoot, 'scripts/check-shell-cjk-vars.mjs')
const tmpRoots: string[] = []

/** 建一个临时目录夹具（files: 相对路径 → 内容）；afterAll 统一删。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-cjkvars-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

afterAll(() => { for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }) })

describe('scanShellCjkVars：判据本体', () => {
  it('注入用例：`$VAR` 紧跟全角括号 ⇒ 命中并给出 file:line:name', () => {
    const root = fixture({ 'x.sh': '#!/bin/sh\nset -eu\necho "发送失败（$PL）"\n' })
    const f = scanShellCjkVars(['x.sh'], root)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ file: 'x.sh', line: 3, name: 'PL' })
  })

  it('不误伤：`${VAR}（`、`$H"`、`$rc )`、`$VAR;` 四种正确/无害邻接一律不报', () => {
    const root = fixture({
      'ok.sh': [
        '#!/bin/sh',
        'echo "成功（${PL}）"',      // 收口
        'echo "$H"',                 // ASCII 邻接
        'echo "$rc )"',
        'echo "$VAR;done"',
        'echo "（$VAR 前缀中文）"',   // 非 ASCII 在**前**，无害
      ].join('\n') + '\n',
    })
    expect(scanShellCjkVars(['ok.sh'], root)).toEqual([])
  })

  it('注释行豁免（陷阱自身的文档必须写得出来）', () => {
    const root = fixture({ 'doc.sh': '#!/bin/sh\n# 坏形态：`$SHA（` 会被解析成变量名的一部分\n' })
    expect(scanShellCjkVars(['doc.sh'], root)).toEqual([])
  })

  it('缩进注释同样豁免；但注释标记在代码行中段不算注释', () => {
    const root = fixture({
      'a.sh': '#!/bin/sh\n   # 缩进注释 $VAR（\n',
      'b.sh': '#!/bin/sh\necho ok  # 行尾注释 $VAR（\n',
    })
    expect(scanShellCjkVars(['a.sh'], root)).toEqual([])
    expect(scanShellCjkVars(['b.sh'], root)).toHaveLength(1) // 行尾注释不豁免:该行是代码
  })
})

describe('shellFiles：该扫谁', () => {
  it('取受版本控制的 `.sh`，并含「无 .sh 后缀但有 sh shebang」的文件；其余不扫', () => {
    const root = fixture({
      'a.sh': '#!/bin/sh\necho a\n',
      'entrypoint': '#!/bin/sh\necho b\n',   // 无后缀、有 shebang ⇒ 扫
      'notes.txt': 'echo "$VAR（"\n',        // 非 shell ⇒ 不扫
      'py.py': '#!/usr/bin/env python3\n',
    })
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    const files = shellFiles(root)
    expect(files.sort()).toEqual(['a.sh', 'entrypoint'])
  })
})

describe('黑盒 CLI：真实仓必须干净', () => {
  it('跑真实仓 exit 0 且输出通过行（防「守卫落了、仓里还有未收口变量」）', () => {
    const out = execFileSync('pnpm', ['exec', 'tsx', GUARD], { cwd: repoRoot, encoding: 'utf8' })
    expect(out).toContain('✓ shell-CJK 邻接检查通过')
  })
})
