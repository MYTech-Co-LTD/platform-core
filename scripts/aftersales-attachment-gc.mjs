#!/usr/bin/env node
// scripts/aftersales-attachment-gc.mjs — 孤儿附件 GC（spec §5 #12；#2728 判据=**业务动作** ⇒ 建在平台调度器）。
//
// 为什么不是 openship job：删的是 `aftersales` 的行 + 租户桶里的对象，判据也全在本仓模块内
// ——这是业务动作；openship 只留基建动作（AGENTS.md「调度归属」）。
//
// **判据与删除顺序的唯一实现在别处**：`modules/aftersales/domain/attachment-gc.ts`
// （行锁 → 删对象 → 删行 → COMMIT；崩溃后重跑安全，S3 delete 幂等 204）。本脚本只做三段编排：
//   ① 逐租户解析存储配置——复用宿主 `resolveTenantStorage` 的**三态判定**（全空→平台默认 /
//      部分填写→不注入 / 全填→租户配置）；绝不自己再写一份（判定漂移 = 删错桶）。
//   ② 按**行上记录的 `storage_ref`** 归桶（`storageCandidatesFor` 含平台默认——早期孤儿行
//      几乎都在平台桶里；只认当前配置会让那批行永远删不掉，或删到别的桶去）。
//   ③ 落审计（与 manage 面端点 `POST /attachments/gc` 同款 `attachment.gc` 条目，actor 标 job）。
//
// 退出码：0 = 正常（含 0 候选、含跳过的租户）；1 = 有租户报错 / 有行删除失败；2 = 缺 env / 参数非法。
// 安全缺省：**dry-run**。真删必须显式 `--apply`（与端点同款——破坏性批量操作不设「默认真删」）；
// registry 里的系统排班显式带 `--apply`，手工跑则默认只报告。
//
// 为什么不清理「解析不出 storage_ref」的行：那是**配置换过 / 凭据失效**的信号，不是垃圾
// （行保留、对象可能还在某个旧桶里）；脚本逐条报告，处置由人决定（删行 = 永久失去线索）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveTenantStorage } from '../apps/server/src/tenant-storage.ts'
import { storageCandidatesFor, storageResolverFor } from '../modules/aftersales/storage.ts'
import {
  GC_DEFAULT_LIMIT,
  GC_DEFAULT_OLDER_THAN_DAYS,
  GC_MAX_LIMIT,
  runAttachmentGc,
} from '../modules/aftersales/domain/attachment-gc.ts'
import { writeAudit } from '../modules/aftersales/domain/audit.ts'

/** 审计里的 actor：固定前缀标「job 跑的」，与真人操作（openid）区分开。 */
export const GC_JOB_ACTOR = 'job:aftersales.attachment_gc'

/**
 * 解析命令行。**未知参数一律抛**（exit 2）——静默忽略 `--aply` 这种笔误 = 以为删了其实只跑了 dry-run，
 * 或反过来（若哪天写成 `--apply` 可简写）以为没删其实删了。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ apply: boolean, org: string, olderThanDays: number, limit: number }} */
  const out = { apply: false, org: '', olderThanDays: GC_DEFAULT_OLDER_THAN_DAYS, limit: GC_DEFAULT_LIMIT }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const eq = a.indexOf('=')
    const name = eq === -1 ? a : a.slice(0, eq)
    /** 取下个参数（支持 `--x=1` 与 `--x 1` 两种写法） */
    const value = () => {
      if (eq !== -1) return a.slice(eq + 1)
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`参数 ${name} 缺值`)
      i += 1
      return v
    }
    if (a === '--apply') out.apply = true
    else if (name === '--org') out.org = value()
    else if (name === '--older-than-days') out.olderThanDays = intArg(name, value(), 1, 3650)
    else if (name === '--limit') out.limit = intArg(name, value(), 1, GC_MAX_LIMIT)
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

/**
 * 严格整数参数（`Number('') === 0` 这类宽松解析会静默变成「删 0 天前 / 删 0 条」）。
 * @param {string} name @param {string} raw @param {number} min @param {number} max
 */
function intArg(name, raw, min, max) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`参数 ${name} 必须是 ${min}–${max} 的整数，收到 ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * 取要处理的租户行。`--org` 给定时只处理那一个（不存在 = 报错，不静默 0 租户）。
 * @param {any} pool
 * @param {string} org casdoor_org（= 模块里的 identity.orgId）
 */
export async function selectTenants(pool, org) {
  const sql = org === ''
    ? 'select * from platform.tenant order by casdoor_org'
    : 'select * from platform.tenant where casdoor_org = $1'
  const { rows } = await pool.query(sql, org === '' ? [] : [org])
  return rows
}

/**
 * 主流程：逐租户 GC。单租户失败不拖累其他租户（记录后继续），最终以退出码汇总。
 * @param {any} pool
 * @param {{ apply: boolean, org: string, olderThanDays: number, limit: number }} opts
 * @returns {Promise<{ processed: number, skipped: number, failed: number }>}
 */
export async function runGcJob(pool, opts) {
  const tenants = await selectTenants(pool, opts.org)
  const tally = { processed: 0, skipped: 0, failed: 0 }
  if (tenants.length === 0) {
    // `--org` 指向不存在的租户 = 调用方写错了 ⇒ 判红（静默 0 租户是「跑成功了」的假绿）；
    // 不指定 org 且表为空 = 真的无事可做（新环境/刚清空）⇒ 不判红，只记一行。
    if (opts.org !== '') throw new Error(`platform.tenant 里没有租户 --org=${JSON.stringify(opts.org)}`)
    console.warn('aftersales-attachment-gc: platform.tenant 为空——无事可做')
    return tally
  }

  for (const row of tenants) {
    const org = row.casdoor_org
    try {
      const cfg = resolveTenantStorage(row)
      // undefined = 部分填写（不注入，**绝不回落平台桶**）。这是配置错误、不是「没配」：
      // 显式告警跳过，而不是替租户把附件写/删到平台桶里（删错了是不可逆的）。
      if (!cfg) {
        console.warn(
          `[skip] org=${org} 存储配置不可用：租户五个存储字段只填了一部分`
            + '（或五个都没填、而平台默认 env 也不全）'
            + ' —— 平台不替它签名/删对象，请先把它补齐或清空。',
        )
        tally.skipped += 1
        continue
      }
      const cands = storageCandidatesFor(cfg)
      if (cands.all.length === 0) {
        console.warn(`[skip] org=${org} 没有任何可用存储配置（ZOS_NOT_CONFIGURED 同义）。`)
        tally.skipped += 1
        continue
      }

      const report = await runAttachmentGc(
        {
          pool,
          org,
          resolver: storageResolverFor(cands),
          deleter: (s, key) => s.deleteObject(key),
        },
        { olderThanDays: opts.olderThanDays, dryRun: !opts.apply, limit: opts.limit },
      )

      // 审计：dry-run 也记（扫描结果本身是运维证据；与端点同款）
      await writeAudit(pool, {
        org,
        actor: GC_JOB_ACTOR,
        action: 'attachment.gc',
        target: '',
        detail: {
          dryRun: report.dryRun,
          olderThanDays: opts.olderThanDays,
          limit: opts.limit,
          scanned: report.scanned,
          eligible: report.eligible,
          deletedObjects: report.deletedObjects,
          deletedRows: report.deletedRows,
          unresolved: report.skippedUnresolved.length,
          errors: report.errors.length,
          unresolvedIdsSample: report.skippedUnresolved.slice(0, 20).map((x) => x.id),
        },
      })

      console.log(
        `aftersales-attachment-gc: org=${org} dryRun=${report.dryRun} scanned=${report.scanned} `
          + `deletedRows=${report.deletedRows} unresolved=${report.skippedUnresolved.length} `
          + `errors=${report.errors.length}（olderThan=${opts.olderThanDays}d limit=${opts.limit}）`,
      )
      // 解析不出桶的行：**保留**，只报告——那是「配置换过/凭据失效」的信号，处置由人决定
      for (const u of report.skippedUnresolved.slice(0, 20)) {
        console.warn(`  [unresolved] org=${org} id=${u.id} storage_ref=${JSON.stringify(u.storageRef)}`)
      }
      for (const e of report.errors.slice(0, 20)) {
        console.warn(`  [error] org=${org} id=${e.id}: ${e.error}`)
      }
      if (report.errors.length > 0) tally.failed += 1
      else tally.processed += 1
    } catch (err) {
      console.error(`[error] org=${org}: ${err instanceof Error ? err.message : String(err)}`)
      tally.failed += 1
    }
  }
  return tally
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('aftersales-attachment-gc: 缺 DATABASE_URL（从平台 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`aftersales-attachment-gc: ${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    const tally = await runGcJob(pool, opts)
    // 有租户失败 ⇒ 非 0：调度器/告警面按退出码判红，而不是靠人翻日志
    process.exit(tally.failed > 0 ? 1 : 0)
  } catch (e) {
    console.error('aftersales-attachment-gc 失败:', e instanceof Error ? e.message : e)
    process.exit(1)
  } finally {
    await pool.end()
  }
}
