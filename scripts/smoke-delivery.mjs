#!/usr/bin/env node
// smoke-delivery.mjs — 交付冒烟（#117：山海交付实测的浏览器级验收，进仓固化）。
//
// 用法（凭据一律走 env，绝不进命令行参数——shell history / ps 都会漏；也不进仓）：
//   SMOKE_BASE=https://<客户域名> SMOKE_USER=<冒烟账号> SMOKE_PASS=<在哪取见 deploy/delivery-private.md> \
//     node scripts/smoke-delivery.mjs
// 可选 env：
//   SMOKE_BRAND            登录页品牌断言（如「山海一果」；缺省跳过该断言）
//   SMOKE_MODULE_LABEL     console 菜单断言文案（缺省「售后管理」）
//   SMOKE_MODULE_PATH      console 模块页路径（缺省 /console/aftersales）
//   SMOKE_APP_PATH         移动端壳访客路径（缺省 /app/aftersales）
//   SMOKE_OUT              截图目录（缺省 /tmp）
//   SMOKE_PLAYWRIGHT_MODULE playwright 模块的绝对路径（缺省按包名解析）
//
// 与 smoke-load.mjs 的分工：那是【CI 门禁】——本地起宿主子进程 + MockCasdoor，验装载与
// 静态托管；本脚本是【交付验收】——对着已上线的客户域名走真实浏览器（Chromium），
// 验「租户品牌 → 登录 → 会话 → 挂码菜单 → 模块页 403 面 → 移动端壳」。两层的失败面不同：
// 门禁绿不代表交付可用（env 三键 / 挂码 / 域名 DNS 都只在真实环境暴露），反之亦然。
//
// 断言集（源自 2026-09-19 山海交付现场逐一踩过/验过的点，别当成随手列的清单）：
//   ① 登录页品牌 + 企微扫码 tab —— 租户行 login_methods 与品牌字段生效的可视证据；
//   ② 表单登录（host-mediated，无 Casdoor UI 跳转）——env 三键（CASDOOR_APPLICATION/
//     CLIENT_ID/CLIENT_SECRET 指向客户 org 自己的 application）错了这步就是 401/502；
//   ③ 登录后落 **/console** + 管理菜单组可见 —— 首管理员挂了 tenant:admin 的证据
//     （没挂码 = 登录成功但菜单全空，这是交付现场最典型的「静默失败」）；
//   ④ 模块页无 403 —— 模块权限码（--module 供给 + grant）生效；
//   ⑤ 移动端壳 HTTP<500 —— 未登录访客被引导而非崩（访客链路真机验证仍归 runbook，
//     此处只守「不 5xx」）。
// 每步截图到 SMOKE_OUT，失败也会把已截的图留在原处——排障时截图比日志直接。
//
// 实现判断（留在这里，避免后来者当成疏漏）：
//   ① 凭据 fail-fast：SMOKE_BASE/USER/PASS 缺一即 exit 1 并指路（在哪、怎么取）。
//     绝不 fallback 空串——那会把配置错误表现成登录失败，误导排障方向。
//   ② playwright 不固化成本仓依赖：CI 不跑交付冒烟（对客户域名发真实登录没有 CI 语义），
//     而 playwright 包安装会拉浏览器（体积/时长都不该进 pnpm install 的公共路径）。
//     解析顺序：仓库 node_modules → SMOKE_PLAYWRIGHT_MODULE 显式路径（npx 缓存形状：
//     ~/.npm/_npx/<hash>/node_modules/playwright/index.mjs）。import 说明符**刻意**
//     用变量——TS 对非字面量说明符不做模块解析，本仓没装 playwright 时 typecheck 仍绿。
//   ③ 密码只进 fill()，不进任何 console.log/截图文件名/退出码文案。
import { mkdirSync } from 'node:fs'

const OUT = process.env.SMOKE_OUT ?? '/tmp'
const BASE = (process.env.SMOKE_BASE ?? '').replace(/\/+$/, '')
const USER = process.env.SMOKE_USER ?? ''
const PASS = process.env.SMOKE_PASS ?? ''
const BRAND = process.env.SMOKE_BRAND ?? ''
const MODULE_LABEL = process.env.SMOKE_MODULE_LABEL ?? '售后管理'
const MODULE_PATH = process.env.SMOKE_MODULE_PATH ?? '/console/aftersales'
const APP_PATH = process.env.SMOKE_APP_PATH ?? '/app/aftersales'

const missing = [
  ['SMOKE_BASE', BASE], ['SMOKE_USER', USER], ['SMOKE_PASS', PASS],
].filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`缺 env：${missing.join(', ')}。取法见 deploy/delivery-private.md（冒烟账号一节）——值不进仓、不进命令行参数。`)
  process.exit(1)
}

// playwright 解析（头注判断②）：缺省按包名；装在别处（如 npx 缓存）用 SMOKE_PLAYWRIGHT_MODULE 指路。
const playwrightSpec = process.env.SMOKE_PLAYWRIGHT_MODULE ?? 'playwright'
// 显式 any（而非结构描摹）：本仓不装 playwright ⇒ JSDoc 里 import('playwright') 的类型解析
// 同样会失败；把 Page/Browser 的形状抄一份在这里只会漂移。断言全在运行时，类型不承载。
/** @type {any} */
let chromium
try {
  ;({ chromium } = await import(playwrightSpec))
} catch {
  console.error(`playwright 未解析到（尝试：${playwrightSpec}）。二选一：
  ① 仓库内临时装：npm i --no-save playwright && npx playwright install chromium
  ② 用 npx 缓存：先 npx playwright@<ver> --version，再
     ls ~/.npm/_npx/*/node_modules/playwright/index.mjs 找到路径，
     SMOKE_PLAYWRIGHT_MODULE=<该路径> 重跑（2026-09-19 山海交付即此形状）`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
/** @type {string[]} */
const fails = []
/** @param {string} name */
const ok = (name) => console.log('  ✓ ' + name)
/**
 * @param {string} name
 * @param {string} why
 */
const bad = (name, why) => { fails.push(name + ': ' + why); console.log('  ✗ ' + name + ' — ' + why) }

// 1. 登录页（品牌可配断言；企微 tab 是租户行 login_methods 的可视证据）
await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
await page.screenshot({ path: OUT + '/smoke-1-login.png' })
if (BRAND) {
  const brand = await page.locator('text=' + BRAND).first().isVisible().catch(() => false)
  brand ? ok('登录页品牌「' + BRAND + '」') : bad('登录页品牌', '未找到品牌文字')
} else {
  console.log('  - 品牌断言跳过（未设 SMOKE_BRAND）')
}
const tabWecom = await page.locator('.ant-tabs-tab', { hasText: '企业微信扫码' }).isVisible().catch(() => false)
tabWecom ? ok('企微扫码 tab 存在') : bad('企微 tab', '未见 tab（租户行 login_methods 未含 wechat-oa/wecom?）')

// 2. 表单登录（host-mediated，无 Casdoor UI 跳转）
await page.getByPlaceholder('用户名').fill(USER)
await page.getByPlaceholder('密码').fill(PASS)
await page.screenshot({ path: OUT + '/smoke-2-filled.png' })
await page.getByRole('button', { name: /登\s*录/ }).click()

// 3. 等 console 落地 + 挂码菜单（tenant:admin + 模块码的证据）
try {
  await page.waitForURL('**/console**', { timeout: 15000 })
  ok('登录后跳转到 ' + new URL(page.url()).pathname)
} catch {
  bad('登录跳转', '15s 后仍在 ' + page.url())
}
await page.waitForLoadState('networkidle')
await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/smoke-3-console.png', fullPage: true })

const labelVis = await page.locator('text=' + MODULE_LABEL).first().isVisible().catch(() => false)
labelVis ? ok('console 可见「' + MODULE_LABEL + '」') : bad('console 菜单', '未见「' + MODULE_LABEL + '」')
const adminMenu = await page.locator('text=管理').first().isVisible().catch(() => false)
adminMenu ? ok('console 管理菜单组可见（tenant:admin 生效）') : bad('管理菜单组', '未见（首管理员未挂 tenant:admin?）')

// 4. 模块页（无 403 = 模块权限码生效）
await page.goto(BASE + MODULE_PATH, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/smoke-4-module.png', fullPage: true })
const mod403 = await page.locator('text=403').first().isVisible().catch(() => false)
mod403 ? bad(MODULE_PATH, '出现 403') : ok(MODULE_PATH + ' 打开（无 403）')

// 5. 移动端壳（访客入口：未登录应是引导/重定向，不是 5xx/空白）
const m = await browser.newPage({ viewport: { width: 390, height: 844 } })
const resp = await m.goto(BASE + APP_PATH, { waitUntil: 'domcontentloaded' }).catch(() => null)
const status = resp ? resp.status() : 0
status > 0 && status < 500 ? ok(APP_PATH + ' HTTP ' + status + '（未登录引导；访客链路真机验证归 runbook）')
  : bad(APP_PATH, 'HTTP ' + status)
await m.waitForTimeout(1500)
await m.screenshot({ path: OUT + '/smoke-5-app.png', fullPage: true })
await m.close()

await browser.close()
console.log(fails.length === 0 ? '\n=== 全部通过 ===' : '\n=== 失败 ' + fails.length + ' 项 ===\n' + fails.join('\n'))
process.exit(fails.length === 0 ? 0 : 1)
