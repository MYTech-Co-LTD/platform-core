#!/usr/bin/env node
// scripts/check-job-scripts-portable.mjs — 平台调度脚本必须**容器内可跑**（#2728 教训）。
//
// ── 抓的是哪一类错 ──────────────────────────────────────────────────────────────
// 2026-11-23 我把「月度对账」建到了 openship，理由是「worker 里没有 console 凭据」——
// 实测发现凭据早就在、且三个容器同一份 ⇒ 真正的根因是**我选了一个只能在宿主机跑的脚本**
// （`/opt/lemeng-recon-preagg.sh`），于是整个 job 只能留在 openship，违背「业务定时进平台」。
//
// ⇒ 判据：`registry.ts` 里声明的每个 `script`，其**代码行**不许出现宿主专属路径/命令。
//    出现即说明这个 job 注定无法在 worker 容器里跑 ⇒ 要么改脚本（容器内可跑），
//    要么这本来就是基建 job，应当显式登记为例外（下方 HOST_ONLY_ALLOW）。
//
// 为什么只扫「代码行」：现有脚本的头注里大量出现 `docker exec` / `/opt/...` 是在讲历史
// （「原 openship job 在宿主跑」「不再 docker exec」）。扫注释会 100% 误报，门禁就废了。
//
// 纯静态：不连库、不取网络、秒级。

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = resolve(ROOT, 'apps/server/src/scheduler/registry.ts')

/** 明确允许留在宿主的 job（基建类）。新增一行 = 一次显式决定，不是默认。 */
const HOST_ONLY_ALLOW = new Map([
  // 目前为空：数据面所有 registry job 的脚本都已容器内可跑。
  // 若将来出现真正的基建 job（必须碰宿主 docker/网络），在这里登记 key + 理由。
])

const HOST_PATTERNS = [
  { re: /\/opt\/[a-zA-Z][\w.-]*/g, what: '宿主机路径 /opt/...' },
  { re: /\bdocker\s+(exec|ps|inspect|cp)\b/g, what: 'docker CLI（容器内无 docker socket）' },
]

/** 去掉行注释与块注释，只留代码（够用：本仓脚本没有把 // 写进字符串的怪用法）。 */
/** @param {string} src @returns {string} */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (/** @type {string} */ m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((/** @type {string} */ line) => {
      const i = line.indexOf('//')
      if (i < 0) return line
      // 粗略保护：// 出现在引号内则不动（脚本里的 URL 场景）
      const before = line.slice(0, i)
      const quotes = (before.match(/['"`]/g) ?? []).length
      return quotes % 2 === 0 ? before : line
    })
    .join('\n')
}

function main() {
  if (!existsSync(REGISTRY)) {
    console.error(`check-job-scripts-portable: 找不到 ${REGISTRY}`)
    process.exit(2)
  }
  const src = readFileSync(REGISTRY, 'utf8')
  const entries = [...src.matchAll(/\{\s*key:\s*'([^']+)'[\s\S]*?script:\s*'([^']+)'/g)].map((m) => ({
    key: m[1],
    script: m[2],
  }))
  if (entries.length === 0) {
    console.error('check-job-scripts-portable: 没解析到任何 key/script（registry 结构变了？）')
    process.exit(2)
  }

  const bad = []
  const missing = []
  for (const { key, script } of entries) {
    const abs = resolve(ROOT, script)
    if (!existsSync(abs)) {
      missing.push(`${key} → ${script}`)
      continue
    }
    if (HOST_ONLY_ALLOW.has(key)) continue
    const code = stripComments(readFileSync(abs, 'utf8'))
    for (const { re, what } of HOST_PATTERNS) {
      re.lastIndex = 0
      const m = re.exec(code)
      if (m) {
        const line = code.slice(0, m.index).split('\n').length
        bad.push({ key, script, line, what, hit: m[0] })
        break
      }
    }
  }

  if (missing.length) {
    console.error('check-job-scripts-portable: registry 引用的脚本不存在')
    for (const x of missing) console.error(`  ${x}`)
    process.exit(1)
  }
  if (bad.length) {
    console.error('check-job-scripts-portable: 以下 job 的脚本**只能在宿主机跑** ⇒ 注定无法在 worker 容器执行')
    for (const b of bad) {
      console.error(`  ${b.key} → ${b.script}:${b.line}  命中 ${b.what}（${b.hit}）`)
    }
    console.error('')
    console.error('处置二选一：')
    console.error('  ① 改脚本成容器内可跑（走 DSN / 服务名 HTTP，而不是宿主路径与 docker CLI）——业务 job 必须这样；')
    console.error('  ② 若确属基建 job（必须碰宿主），在 scripts/check-job-scripts-portable.mjs 的 HOST_ONLY_ALLOW 里登记 key + 理由。')
    console.error('背景：#2728 —— 业务 job 一律进平台调度；「只能宿主跑」是它被建到 openship 的唯一借口，这条门禁堵掉这个借口。')
    process.exit(1)
  }

  console.log(`check-job-scripts-portable: OK（${entries.length} 个 job 的脚本均可容器内执行）`)
}

main()
