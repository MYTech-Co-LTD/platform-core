// scripts/check-shell-cjk-vars.mjs — #212 守卫：shell 里未收口的 `$VAR` 紧跟非 ASCII ⇒ 变量名被吃。
//
// ## 它防的是什么
//
// 本仓 shell 脚本里中文注释与文案极多，而 **bash 3.2（macOS `/bin/sh`）把 0x80 以上的字节也当成
// 变量名的合法字符**：`echo "失败（$PL）"` 会被解析成变量 `PL）`（未定义 ⇒ `set -u` 下
// `unbound variable` 当场退出）。dash/Ubuntu 不复现 ⇒ 本地 mac 开发 + Ubuntu 运行这个组合里，
// 它专挑**失败路径**炸：那句话本来就是用来报错的，结果报错的自己先崩了（#208 `$AGI_URL`、
// #211 `$wrc` 两次真机前实测，都在失败路径上）。
//
// ## 判据（精确，不一刀切）
//
// 报错形态：`\$[A-Za-z_][A-Za-z0-9_]*` **紧跟**一个非 ASCII 字节（`>= 0x80`）。
// 正确写法 = `${VAR}` 收口。纯 ASCII 邻接（`$H"`、`$rc )`、`$VAR;`）**不受影响**——所以不能
// 一刀切要求「所有变量都加大括号」（那会把全仓脚本改写一遍，且掩盖了真正的判据）。
//
// **只判可执行行**：整行以 `#` 开头（允许前导空白）的**注释**豁免——它不执行，且**陷阱自身的
// 文档必须写得出来**（`scripts/lemeng/sync-data-plane.sh` 头注就在示范坏形态，那是刻意保留的）。
//
// 用法：`pnpm exec tsx scripts/check-shell-cjk-vars.mjs [rootDir]`（rootDir 默认仓根，测试用）。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** `$VAR` 紧跟非 ASCII 字节（u 标志下 `.` 与字符类按码点，`[^\x00-\x7f]` 即非 ASCII）。 */
const VIOLATION = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])/u

/**
 * @typedef {object} Finding
 * @property {string} file 仓内相对路径
 * @property {number} line 1-based 行号
 * @property {string} name 该变量名（未收口的）
 * @property {string} snippet 命中行（去首尾空白，截断）
 */

/**
 * 扫一批文件，返回违规点。
 *
 * @param {readonly string[]} files 仓内相对路径（调用方保证存在）
 * @param {string} [root] 仓根（默认 cwd）
 * @returns {Finding[]}
 */
export function scanShellCjkVars(files, root = process.cwd()) {
  /** @type {Finding[]} */
  const out = []
  for (const rel of files) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n')
    lines.forEach((raw, i) => {
      const line = raw.replace(/\r$/, '')
      if (line.trimStart().startsWith('#')) return // 注释不执行:豁免(含陷阱自身的文档)
      const m = VIOLATION.exec(line)
      if (m) out.push({ file: rel, line: i + 1, name: m[1], snippet: line.trim().slice(0, 100) })
    })
  }
  return out
}

/**
 * 找出「该扫的 shell 文件」：受版本控制、且（后缀 `.sh` 或首行 shebang 指向 sh/bash）。
 * 用 `git ls-files` 而非遍历目录：**受版本控制 + 不含被忽略物**，与门禁的语义一致。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function shellFiles(root = process.cwd()) {
  const all = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  return all.filter((f) => {
    if (f.endsWith('.sh')) return true
    try {
      return /^#!.*\b(?:ba)?sh\b/.test(readFileSync(join(root, f), 'utf8').split('\n', 1)[0] || '')
    } catch { return false } // 二进制/不可读:不猜
  })
}

function main() {
  const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const files = shellFiles(root)
  const findings = scanShellCjkVars(files, root)
  if (findings.length === 0) {
    console.log(`✓ shell-CJK 邻接检查通过（${files.length} 个 shell 文件，0 处未收口变量）`)
    return
  }
  console.error(`✗ 发现 ${findings.length} 处未收口的 $VAR 紧跟非 ASCII（bash 3.2 会把中文吃进变量名）：`)
  for (const f of findings) console.error(`  ${f.file}:${f.line}  \$${f.name}  ← ${f.snippet}`)
  console.error('修法：写成 ${VAR}（花括号收口）。注释行豁免，其余一律要收口。')
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
