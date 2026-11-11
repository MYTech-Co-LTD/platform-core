// builtin.test.ts — 「事件声明 + 内置文案」这根链的静态护栏（Wave 2.3）。
//
// 为什么需要它：`forms.form.assigned` / `forms.form.due_reminder` 声明了两年却**既没有模板也没有
// 派生规则**——dispatch 的结局是 `no_rules`，静默不进任何收件箱，而没有任何门禁会红。这与
// 2026-10-27「漏跑 seed ⇒ 零投递」同型：**声明不等于开通**。
//
// 这里钉三件事（纯静态，不连库）：
//   ① 每个 manifest 里声明的事件都必须有 `defaults`（= 声明了开通链的入口）；
//   ② `defaults.template` 必须在 BUILTIN_TEMPLATES 里存在，且该模板的 eventKey 与事件同名；
//   ③ 反向：每个内置模板的 eventKey 都必须被某个模块声明（防 typo 造出永远发不出的文案）。
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATES } from './builtin'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const MODULES_DIR = join(REPO_ROOT, 'modules')

interface DeclaredEvent {
  key: string
  moduleId: string
  defaults?: { recipient: string; template: string; channels: string[] }
}

function declaredEvents(): DeclaredEvent[] {
  const out: DeclaredEvent[] = []
  for (const dir of readdirSync(MODULES_DIR)) {
    let doc: unknown
    try {
      doc = parse(readFileSync(join(MODULES_DIR, dir, 'manifest.yaml'), 'utf8'))
    } catch {
      continue // 没有 manifest 的目录（node_modules 等）
    }
    const events = (doc as { notifications?: { events?: unknown } } | null)?.notifications?.events
    if (!Array.isArray(events)) continue
    for (const ev of events) {
      out.push({ moduleId: dir, ...(ev as Omit<DeclaredEvent, 'moduleId'>) })
    }
  }
  return out
}

describe('通知事件 ↔ 内置模板的一致性（声明 ≠ 开通）', () => {
  const events = declaredEvents()

  it('至少扫到各模块的事件（避免路径写错导致空集假绿）', () => {
    expect(events.length).toBeGreaterThanOrEqual(5)
    expect(events.map((e) => e.key)).toContain('forms.form.assigned')
    expect(events.map((e) => e.key)).toContain('forms.form.due_reminder')
  })

  it('① 每个声明的事件都必须有 defaults（开通链的入口；缺了 dispatch 只会得到 no_rules）', () => {
    const missing = events.filter((e) => e.defaults === undefined).map((e) => `${e.moduleId}:${e.key}`)
    expect(missing).toEqual([])
  })

  it('② defaults.template 必须存在于 BUILTIN_TEMPLATES，且模板 eventKey 与事件同名', () => {
    const byKey = new Map(BUILTIN_TEMPLATES.map((t) => [t.key, t]))
    const problems: string[] = []
    for (const ev of events) {
      if (ev.defaults === undefined) continue
      const tpl = byKey.get(ev.defaults.template)
      if (tpl === undefined) {
        problems.push(`${ev.key} 的 defaults.template '${ev.defaults.template}' 不在 BUILTIN_TEMPLATES`)
        continue
      }
      if (tpl.eventKey !== ev.key) {
        problems.push(`模板 ${tpl.key} 的 eventKey=${tpl.eventKey} ≠ 事件 ${ev.key}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('③ 反向：内置模板的 eventKey 必须被某个模块声明（防 typo 造出永不触发的文案）', () => {
    const declared = new Set(events.map((e) => e.key))
    const orphans = BUILTIN_TEMPLATES.filter((t) => !declared.has(t.eventKey)).map((t) => `${t.key}→${t.eventKey}`)
    expect(orphans).toEqual([])
  })

  it('模板 key 不重复，且 wecom 文案里的链接是闭合 markdown（#44 教训）', () => {
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.key)).size).toBe(BUILTIN_TEMPLATES.length)
    for (const t of BUILTIN_TEMPLATES) {
      const text = t.contents.wecom_chat?.text
      if (text === undefined) continue
      // `[label](url)` 必须成对出现：出现 `[` 就必须有 `](…)`
      const opens = (text.match(/\[/g) ?? []).length
      const closedLinks = (text.match(/\]\(/g) ?? []).length
      expect(opens, `${t.key} 的链接未闭合：${text}`).toBe(closedLinks)
    }
  })
})
