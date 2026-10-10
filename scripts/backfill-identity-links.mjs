// @ts-nocheck —— CLI 薄壳：纯核（planBackfill/shouldBackfillWrite/normalizePhone/maskPhone）
// 有同名 .test.ts 兜底；tsc 根工程解析不到 apps/server 的 pg 类型，不为此给根加依赖
//（provision-tenant.mjs 同款头注）
// backfill-identity-links.mjs — 存量员工身份绑定回填（账户统一 Phase 1 · Task 11）
// 用法：DATABASE_URL=postgresql://… npx tsx scripts/backfill-identity-links.mjs [--apply]
//
//   默认 dry-run：读源 + 读现有绑定 + 打印计划，【零写入、零 Casdoor 调用】；确认无误再加
//   --apply 真跑。幂等可重跑：同号重跑产出同一计划；已写的行走「跳过」分支不再改写。
//
//   源：aftersales.employee（approve_status='approved' 且手机号有效才回填；无有效手机号 →
//   invalid 清单转人工；非 approved 全忽略）。
//   写：platform.identity_link —— provider='wechat-oa'、status='active'、bound_via='manual'、
//   casdoor_name=open_id（与 matchOnApplication 草稿路径同口径：Casdoor user 名 = external_id）；
//   写前逐条 ensureUser(openId)（getUser 已存在则跳过——ensureUser 的幂等由调用方保证）。
//
// 安全语义（比 brief 多出的两道闸，均在纯核可测）：
//   · 已 active 的绑定一律跳过——绝不覆盖已生效绑定；revoked/disputed 同样不碰——那是人工
//     状态决定，批量回填无权翻案（只写 无行/pending）。
//   · 同 (org, openId) 多行不同手机号 → phone_conflict 转人工，绝不静默 last-write-wins。
//   · 输出（日志/失败清单）手机号一律掩码（前 3 后 2）；失败信息里若带手机号原文先遮再打。
//
// ⚠️ B1 边界：宿主【运行时】绝不读 aftersales schema（apps/server 零触碰）；本脚本读它属
//   一次性迁移性质（与 M2b 数据迁移同先例），运行时路由绝不读。
import { createRequire } from 'node:module'

// —— 归一/掩码：与 apps/server/src/identity-links.ts 的 normalizePhone/maskPhone 逐字同口径。
// Task 11 约束本脚本不 import 仓 src（脚本自带实现），故独立放一份；identity-links.ts 是
// 语义正典，此处是迁移脚本的随行副本，双侧改动需同步。

/** 手机号归一：取数字；「86 + 11 位」共 13 位时去国家码；恰好 11 位才返回（其余不匹配）。 */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2)
  return d.length === 11 ? d : null
}

/** 掩码：前 3 后 2、中间 `****`。短于 6 位时「前3后2」会把整串露出来 ⇒ 全遮；null 透传。 */
export function maskPhone(phone) {
  if (phone === null) return null
  const s = String(phone)
  if (s.length < 6) return '****'
  return `${s.slice(0, 3)}****${s.slice(-2)}`
}

/**
 * 回填计划纯核：
 *   binds   = approved 且手机号有效（同 (org,openId) 多行同号去重成一个；phone 为归一后全号
 *             ——写库必需，日志层另行掩码）
 *   invalid = approved 但不可机绑的行，转人工。reason ∈
 *               openid_empty   open_id 为空（external_id 无从谈起）
 *               phone_empty    手机号空白
 *               phone_invalid  归一失败（原文只以掩码出清单）
 *               phone_conflict 同 (org,openId) 多行不同号——写库会静默 last-write-wins，宁转人工
 *   非 approved（pending/rejected）全忽略：不进 binds 也不进 invalid。
 * @param {{org: string, openId: string, phone: string, approveStatus: string}[]} rows
 * @returns {{binds: {org: string, openId: string, phone: string}[],
 *            invalid: {org: string, openId: string, phoneMasked: string, reason: string}[]}}
 */
export function planBackfill(rows) {
  const binds = []
  const invalid = []
  const byKey = new Map() // key: org\0openId → { org, openId, phones[] }
  for (const r of rows) {
    if (r.approveStatus !== 'approved') continue
    const openId = String(r.openId ?? '')
    const raw = String(r.phone ?? '')
    const masked = maskPhone(raw)
    if (openId.trim() === '') {
      invalid.push({ org: r.org, openId, phoneMasked: masked, reason: 'openid_empty' }); continue
    }
    if (raw.trim() === '') {
      invalid.push({ org: r.org, openId, phoneMasked: masked, reason: 'phone_empty' }); continue
    }
    const phone = normalizePhone(raw)
    if (phone === null) {
      invalid.push({ org: r.org, openId, phoneMasked: masked, reason: 'phone_invalid' }); continue
    }
    const key = `${r.org}\u0000${openId}`
    let e = byKey.get(key)
    if (!e) { e = { org: r.org, openId, phones: [] }; byKey.set(key, e) }
    if (!e.phones.includes(phone)) e.phones.push(phone)
  }
  for (const e of byKey.values()) {
    if (e.phones.length === 1) binds.push({ org: e.org, openId: e.openId, phone: e.phones[0] })
    else invalid.push({ org: e.org, openId: e.openId, phoneMasked: maskPhone(e.phones[0]), reason: 'phone_conflict' })
  }
  return { binds, invalid }
}

/**
 * 写前裁决（纯核）：无行（null/undefined）或 pending ⇒ 写（fresh 回填 / 扶正自动匹配留下的
 * 草稿）；active/revoked/disputed ⇒ 不写——active 是已生效绑定，revoked/disputed 是人工状态
 * 决定，批量回填无权翻案。
 * @param {string | null | undefined} existingStatus platform.identity_link 里该
 *   (provider='wechat-oa', org, external_id) 的现状；无行传 null
 * @returns {boolean} true = 应写
 */
export function shouldBackfillWrite(existingStatus) {
  return existingStatus === null || existingStatus === undefined || existingStatus === 'pending'
}

// upsert 与 identity-links.ts 的 upsertLink「active 分支」同口径（bound_at 恒 now()：回填只写
// active）；provider/bound_via/status 是本脚本的三个常量，故内联进 SQL——独立实现，不 import 仓 src。
const UPSERT_SQL = `insert into platform.identity_link
  (org, provider, external_id, casdoor_name, status, phone, bound_via, source_approval_id, bound_at)
values ($1, 'wechat-oa', $2, $2, 'active', $3, 'manual', null, now())
on conflict (provider, org, external_id) do update set
  casdoor_name = excluded.casdoor_name,
  phone = excluded.phone,
  bound_via = excluded.bound_via,
  status = excluded.status,
  source_approval_id = excluded.source_approval_id,
  bound_at = now()
returning id::int as id`

/** 打印行：org/openId + 掩码手机号——main 的所有明细输出都走这里，掩码口径只有这一处。 */
function bindLine(b, extra = '') {
  return `org=${b.org} openId=${b.openId} phone=${maskPhone(b.phone)}${extra}`
}

/**
 * casdoorFor 工厂：CASDOOR_* env 齐全 → 真 CasdoorClient（每 org 一只，照 provision-tenant
 * 的构造）；缺失 → 【假 casdoorFor 演练模式】（getUser 恒 null、ensureUser 空操作并响亮
 * 提示）——本地无真 Casdoor 时 --apply 也能全链路演练 identity_link 写入，但行会指向不存在
 * 的 Casdoor 账号（生产真跑必须配 env）。
 */
async function makeCasdoorFor() {
  const url = process.env.CASDOOR_URL
  if (!url) {
    console.log('[backfill] ⚠️ 未配 CASDOOR_URL：--apply 用【假 casdoorFor】演练——ensureUser 空操作，'
      + 'identity_link 将指向不存在的 Casdoor 账号（生产真跑必须配 CASDOOR_* env）')
    return () => ({ getUser: async () => null, ensureUser: async () => {} })
  }
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
  const orgNames = new Set()
  return (orgName) => {
    orgNames.add(orgName)
    return new CasdoorClient({
      origin: url,
      clientId: process.env.CASDOOR_CLIENT_ID ?? 'x', clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? 'x',
      org: orgName, adminUser: process.env.CASDOOR_ADMIN_USER, adminPwd: process.env.CASDOOR_ADMIN_PWD,
    })
  }
}

/** 失败信息脱敏：pg/驱动报错文案若回显了参数值，先把手机号原文换成掩码再进日志。 */
function redact(message, phone) {
  return String(message ?? '').split(phone).join(maskPhone(phone))
}

async function main() {
  const apply = process.argv.includes('--apply')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  // pg 经 createRequire 锚到 apps/server 解析（scripts/ 不属于任何 workspace 包，裸 import
  // 'pg' 处处解析不到——与 provision-tenant.mjs 同坑同修）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool: P } = requireFromServer('pg')
  const pool = new P({ connectionString: dbUrl })
  try {
    // ① 读源（aftersales.employee——迁移性质读，见头注 B1 边界）
    const { rows } = await pool.query(
      'select org, open_id, phone, approve_status from aftersales.employee order by id',
    )
    const records = rows.map((r) => ({
      org: r.org, openId: r.open_id, phone: r.phone, approveStatus: r.approve_status,
    }))
    const plan = planBackfill(records)
    console.log(`[backfill] 源 aftersales.employee 共 ${records.length} 行 → binds ${plan.binds.length} / invalid ${plan.invalid.length}`)
    for (const i of plan.invalid) {
      console.log(`  invalid org=${i.org} openId=${i.openId} phone=${i.phoneMasked} reason=${i.reason}（转人工）`)
    }
    // ② 同 org 同号多身份预警（自动匹配遇同号会走 multi→转人工；摸底细节见 audit 脚本）
    const shared = new Map()
    for (const b of plan.binds) {
      const k = `${b.org}\u0000${b.phone}`
      shared.set(k, (shared.get(k) ?? 0) + 1)
    }
    const sharedGroups = [...shared.values()].filter((n) => n > 1).length
    if (sharedGroups > 0) console.log(`[backfill] ⚠️ binds 内同 org 同号 ${sharedGroups} 组——这些号日后自动匹配会走 multi→转人工（不阻断回填）`)
    // ③ 读现有绑定现状（provider 只看 wechat-oa；同 provider 键唯一）
    const { rows: existing } = await pool.query(
      "select org, external_id, status from platform.identity_link where provider = 'wechat-oa'",
    )
    const statusByKey = new Map(existing.map((r) => [`${r.org}\u0000${r.external_id}`, r.status]))
    let toWrite = 0
    const skips = []
    for (const b of plan.binds) {
      const st = statusByKey.get(`${b.org}\u0000${b.openId}`) ?? null
      if (shouldBackfillWrite(st)) toWrite++
      else skips.push({ org: b.org, openId: b.openId, phone: b.phone, status: st })
    }
    console.log(`[backfill] 计划：写 ${toWrite} / 跳过 ${skips.length}（active/revoked/disputed 不碰）`)
    for (const s of skips) console.log(`  skip ${bindLine(s, `（原状态 ${s.status}）`)}`)
    if (!apply) {
      console.log('[backfill] dry-run（默认）：以上为计划，零写入、零 Casdoor 调用。确认后加 --apply 真跑。')
      return
    }
    // ④ --apply：逐条 ensureUser → upsert；单条失败收集续跑（不中断整批）
    const casdoorFor = await makeCasdoorFor()
    let written = 0
    const failures = []
    for (const b of plan.binds) {
      const st = statusByKey.get(`${b.org}\u0000${b.openId}`) ?? null
      if (!shouldBackfillWrite(st)) continue
      try {
        const cas = casdoorFor(b.org)
        if ((await cas.getUser(b.openId)) === null) await cas.ensureUser(b.openId) // 已存在则跳过建号
        await pool.query(UPSERT_SQL, [b.org, b.openId, b.phone])
        written++
        console.log(`  ✓ ${bindLine(b)}`)
      } catch (e) {
        failures.push({ org: b.org, openId: b.openId, phoneMasked: maskPhone(b.phone), message: redact(e?.message ?? e, b.phone) })
        console.log(`  ✗ ${bindLine(b)} —— ${redact(e?.message ?? e, b.phone)}`)
      }
    }
    console.log(`[backfill] 完成：成功 ${written} / 跳过 ${skips.length} / 失败 ${failures.length}（${apply ? '--apply' : 'dry-run'}）`)
    for (const f of failures) console.log(`  failed org=${f.org} openId=${f.openId} phone=${f.phoneMasked} —— ${f.message}`)
    if (failures.length > 0) {
      console.log('[backfill] 失败清单如上（掩码）；修复后重跑本脚本即可续跑（已成功者走 skip/幂等分支）。')
      process.exitCode = 1
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('backfill-identity-links.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
