#!/usr/bin/env node
// 集成判据门禁（spec 2026-10-31-integration-health-design.md §2.5「声明即判据」）。
//
// 用法：tsx scripts/check-integrations.mjs [rootDir]
// 契约：干净 → exit 0，stdout 一行 `check-integrations: OK`；
//       违规 → exit 1，stderr 每条一行 `相对路径: [INT] 说明`。
//
// 为什么需要它（这是整个「集成健康」设计的牙齿）：
// 出站集成最致命的失效是「该来的没来」——没有调用方就没有调用失败，任何既有告警都覆盖不到。
// 光有探针不够：**新增一个集成的人必须回答「凭什么判它活着」**，否则探针永远只盯着老那几个。
// 本门禁把那个问题变成**合并前就必须回答**的检查项，与 `api.internal` 的「声明即授权」同构：
// **声明即判据**。
//
// 两条规则：
//   ① registry 自身合法：`integrations` 是数组、id 唯一、kind ∈ callback/token/channel、
//      source 以 sql:/http-healthz:/casdoor: 开头、slaSeconds 为正整数、covers 里的 provider 必须是
//      真 provider（拼错 = 覆盖不到还以为覆盖了）。
//   ② **provider 覆盖**：模块声明能发出的每一个 notify 通道 provider（`modules/notify/domain/providers.ts`
//      的 NOTIFY_PROVIDERS），必须要么被某条 registry 条目的 `covers` 覆盖，要么在 `exempt` 里
//      **带非空理由**豁免。既没覆盖也没豁免 ⇒ 红；豁免没写理由 ⇒ 红（无理由豁免就是静默）。
//
// 刻意不做（别扩成假门禁）：
//   · 不解析 SQL 迁移里的 check 约束（文本解析不可靠）；provider 清单以 TS 常量为准，
//     迁移漂移靠 DB 报错与评审兜底（providers.ts 头注写明）。
//   · 不检查「registry 条目是否真的能跑通」——那是运行期探针的事（`PROBE_FAILED` 会显形）。
import { readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

export const SCRIPT_NAME = 'check-integrations'

const KINDS = new Set(['callback', 'token', 'channel'])
const SOURCE_RE = /^(sql|http-healthz|casdoor):.+/

/** @typedef {{ file: string, message: string }} Violation */

/**
 * 校验 registry 内容（纯函数，fixtures 直接调）。
 * @param {unknown} raw
 * @returns {Violation[]}
 */
export function checkRegistry(raw) {
  /** @type {Violation[]} */
  const out = []
  const file = 'deploy/integration-registry.json'
  if (typeof raw !== 'object' || raw === null) return [{ file, message: '顶层必须是对象' }]
  const obj = /** @type {Record<string, unknown>} */ (raw)
  const list = obj.integrations
  if (!Array.isArray(list)) return [{ file, message: 'integrations 必须是数组' }]

  const ids = new Set()
  for (const [i, item] of list.entries()) {
    const at = `integrations[${i}]`
    if (typeof item !== 'object' || item === null) { out.push({ file, message: `${at}: 必须是对象` }); continue }
    const e = /** @type {Record<string, unknown>} */ (item)
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    if (id === '') out.push({ file, message: `${at}: id 必填` })
    else if (ids.has(id)) out.push({ file, message: `${at}: id 重复（${id}）` })
    else ids.add(id)
    if (!KINDS.has(String(e.kind))) out.push({ file, message: `${at}: kind 必须是 callback/token/channel` })
    if (typeof e.source !== 'string' || !SOURCE_RE.test(e.source)) {
      out.push({ file, message: `${at}: source 必须以 sql:/http-healthz:/casdoor: 开头` })
    }
    const sla = Number(e.slaSeconds)
    if (!Number.isInteger(sla) || sla <= 0) out.push({ file, message: `${at}: slaSeconds 必须是正整数` })
  }
  return out
}

/**
 * provider 覆盖检查（纯函数）：每个 provider 要么被 covers 覆盖，要么带理由豁免。
 * @param {unknown} raw
 * @param {readonly string[]} providers
 * @returns {Violation[]}
 */
export function checkCoverage(raw, providers) {
  const file = 'deploy/integration-registry.json'
  /** @type {Violation[]} */
  const out = []
  if (typeof raw !== 'object' || raw === null) return [{ file, message: '顶层必须是对象' }]
  const obj = /** @type {Record<string, unknown>} */ (raw)
  const known = new Set(providers)

  const covered = new Set()
  for (const [i, item] of (Array.isArray(obj.integrations) ? obj.integrations : []).entries()) {
    if (typeof item !== 'object' || item === null) continue
    const covers = /** @type {Record<string, unknown>} */ (item).covers
    if (covers === undefined) continue
    if (!Array.isArray(covers)) { out.push({ file, message: `integrations[${i}]: covers 必须是数组` }); continue }
    for (const c of covers) {
      if (typeof c !== 'string' || !known.has(c)) {
        out.push({ file, message: `integrations[${i}]: covers 里的 ${JSON.stringify(c)} 不是已知 provider（拼错=以为覆盖了其实没有）` })
        continue
      }
      covered.add(c)
    }
  }

  const exempt = new Set()
  for (const [i, item] of (Array.isArray(obj.exempt) ? obj.exempt : []).entries()) {
    if (typeof item !== 'object' || item === null) { out.push({ file, message: `exempt[${i}]: 必须是对象` }); continue }
    const e = /** @type {Record<string, unknown>} */ (item)
    const p = typeof e.provider === 'string' ? e.provider : ''
    if (!known.has(p)) { out.push({ file, message: `exempt[${i}]: ${JSON.stringify(p)} 不是已知 provider` }); continue }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      // 已声明豁免但没写理由 ⇒ 只报「理由缺失」这一条（**仍算已声明**，否则同一个根因
      // 会再叠一条「未覆盖」，两条消息指同一处改动，反而不好改）。
      out.push({ file, message: `exempt[${i}]（${p}）: 豁免必须写理由——无理由豁免就是静默` })
      exempt.add(p)
      continue
    }
    exempt.add(p)
  }

  for (const p of providers) {
    if (!covered.has(p) && !exempt.has(p)) {
      out.push({
        file,
        message: `通道 provider "${p}" 既没有活性判据（registry 条目的 covers）也没有带理由的豁免`
          + ' —— 新增通道必须回答「凭什么判它还活着」（spec §2.5）',
      })
    }
  }
  return out
}

/**
 * 读 modules/notify/domain/providers.ts 的 NOTIFY_PROVIDERS（唯一代码事实源）。
 * @param {string} root
 */
async function loadProviders(root) {
  const mod = await import(pathToFileURL(join(root, 'modules/notify/domain/providers.ts')).href)
  const list = mod.NOTIFY_PROVIDERS
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('providers.ts 的 NOTIFY_PROVIDERS 读不到（门禁无法回答覆盖问题 ⇒ 响亮失败）')
  }
  return /** @type {readonly string[]} */ (list)
}

/**
 * 读某模块 manifest 的 notifications 声明（只为把「谁声明了通知能力」列出来，不参与判红）。
 * @param {string} root
 */
async function declaredEventModules(root) {
  const { readdir } = await import('node:fs/promises')
  const mods = await readdir(join(root, 'modules'), { withFileTypes: true })
  const out = []
  for (const d of mods) {
    if (!d.isDirectory() || d.name === 'node_modules') continue
    try {
      const raw = await readFile(join(root, 'modules', d.name, 'manifest.yaml'), 'utf8')
      const m = parseYaml(raw)
      if (Array.isArray(m?.notifications?.events) && m.notifications.events.length > 0) out.push(d.name)
    } catch { /* 无 manifest / 读不到：不属本门禁职责 */ }
  }
  return out
}

async function main() {
  const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..')
  const registryPath = join(root, 'deploy/integration-registry.json')
  let raw
  try {
    raw = JSON.parse(await readFile(registryPath, 'utf8'))
  } catch (e) {
    console.error(`${relative(process.cwd(), registryPath)}: [INT] 读不到或不是合法 JSON：${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  const providers = await loadProviders(root)
  const violations = [...checkRegistry(raw), ...checkCoverage(raw, providers)]
  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.file}: [INT] ${v.message}`)
    process.exit(1)
  }
  const emitters = await declaredEventModules(root)
  console.log(
    `check-integrations: OK（${/** @type {any} */ (raw).integrations.length} 条判据 / `
    + `${providers.length} 个 provider 全覆盖或带理由豁免 / 声明通知能力的模块：${emitters.join(',') || '无'}）`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
