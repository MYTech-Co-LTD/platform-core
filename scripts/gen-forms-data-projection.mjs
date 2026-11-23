#!/usr/bin/env node
// scripts/gen-forms-data-projection.mjs — dataPlane 表单字段契约 → 摊平模型生成器（件① #2706）。
//
// 读库（声明了 `dataPlane.analytics.enabled=true`（v2）或 `dataPlane.enabled=true`（legacy）的
// 已发布表单）→ 生成两份产物，逐表单一份：
//   ① 字段契约   `contracts/forms/data-plane/<slug>.json`
//                （field→column/type 映射；生成模型与 L1 引用的唯一事实源）
//   ② 摊平模型   `dbt/models/forms/data_plane/stg_forms_submission__<relationSlug>.sql`
//                （DuckDB 段只碰 parquet：同一 forms/submission 湖按 form_def_id 过滤 +
//                payload 逐字段提取；**无任何 join**——join PG 关系拆 PG 原生模型，B1 合规）
//
// ## 生成物纪律（照 scripts/gen-data-projection.mjs：生成物 == committed）
//
//   · 默认     写文件（产出动作；同时删除「清单里已无此表单」的孤儿产物——只删本生成器
//              自己的命名空间，绝不碰别人的文件）
//   · `--check` 重新生成全部产物并与 committed 逐字节比对，任一差异（内容漂移 / 孤儿产物）
//              ⇒ 打印文件名、exit 1（CI 用）
//   · 无 DATABASE_URL，或 forms schema 不在（CI gates 挂的是裸 service 库，迁移没跑）
//              ⇒ 打印一行跳过说明、exit 0——本门禁只在「有真 forms 库」的环境（本地 /
//              ops 机）有牙齿，与 notify-reconcile 的缺库即 exit 2 不同（那是 job，跑不成了
//              就该响；这是门禁，CI 里恒无库，响等于全 PR 恒红）
//
// ## 与 modules/forms/storage.ts 的关系（两份实现，注释互指）
//
// 本脚本必须在**裸 node** 下跑（CI gates 是 `node scripts/…`，无 tsx）⇒ 不能 import TS 的
// `storage.listDataPlaneForms` ⇒ SQL 与 kind 映射在此内联一份。判据必须与
// `storage.listDataPlaneForms` 逐字同构（published + active_version + analytics/legacy enabled
// + kind 映射）——改任一侧必须同步另一侧；契约闸（compileGate 的 dataPlane 分支）保证
// 入库形状，这里只做映射。
//
// ## 用法
//
//   node scripts/gen-forms-data-projection.mjs [--check] [rootDir]
//   DATABASE_URL=<平台库> node scripts/gen-forms-data-projection.mjs            # 写
//   DATABASE_URL=<平台库> node scripts/gen-forms-data-projection.mjs --check    # 比对

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 字段契约目录（仓根相对）。⚠️ 这批 JSON **不是**湖列契约（无 schemaVersion/layout）——
 *  湖契约三处扫描面（check-data-contract / gen-data-projection / check-column-scope-monotonicity）
 *  都按 `NON_LAKE_CONTRACT_PREFIXES` 排除了本目录（scripts/lib/data-contract.mjs）。 */
export const CONTRACT_REL_DIR = 'contracts/forms/data-plane'
/** 摊平模型目录（仓根相对）。落 `forms` 域**非 staging** 子目录：staging 一对一（check-data-models
 *  规则 ④）是「源 ↔ staging 模型」的配对闸，摊平模型与 stg_forms_submission 同读一个已声明源、
 *  不是新源 ⇒ 放 staging/ 会把一对一打红。目录即域：仍在 forms 域内，域开关照常生效。 */
export const MODEL_REL_DIR = 'dbt/models/forms/data_plane'
/** 模型文件名前缀（本生成器的命名空间；孤儿产物识别按它圈定，不越界删别人的）。 */
export const MODEL_STEM = 'stg_forms_submission__'

/** 摊平列名前缀（避开 batch_id/bizday/submission_id/form_def_id/submitted_at/org/payload 保留列）。 */
export const FIELD_COLUMN_PREFIX = 'f_'

/** 表单 head 六件套列（所有摊平模型共有；与 stg_forms_submission 的头列一致）。 */
const HEAD_COLUMNS = [
  "  r['batch_id']::varchar as batch_id,",
  '  {{ subject_org() }} as org,',
  "  r['bizday']::date as bizday,",
  "  r['submission_id']::bigint as submission_id,",
  "  r['form_def_id']::varchar as form_def_id,",
  "  r['submitted_at']::timestamptz as submitted_at,",
]

/** @typedef {(c: string, p: string) => string} ExtractFn */

/** kind → DuckDB SQL 类型（单一事实源；契约 json 的 sql_type 与模型 cast 目标都从这取）。
 *  @type {Record<string, string>} */
export const SQL_TYPE = {
  string: 'varchar',
  enum: 'varchar',
  date: 'date',
  number: 'decimal(18,4)',
  integer: 'bigint',
  boolean: 'boolean',
}

/** kind → payload 字段提取表达式（`c` = 摊平列名，`p` = 契约字段名）。⚠️ DuckDB 段只碰
 *  parquet：json_extract_string 对 varchar 的 payload 做 schema-on-read 提取（ADR-0005 §13.1 ①）。
 *  @type {Record<string, ExtractFn>} */
export const EXTRACT = {
  string: (c, p) => `json_extract_string(r['payload'], '$.${p}') as ${c}`,
  enum: (c, p) => `json_extract_string(r['payload'], '$.${p}') as ${c}`,
  date: (c, p) => `cast(json_extract_string(r['payload'], '$.${p}') as date) as ${c}`,
  number: (c, p) => `cast(json_extract_string(r['payload'], '$.${p}') as decimal(18,4)) as ${c}`,
  integer: (c, p) => `cast(json_extract_string(r['payload'], '$.${p}') as bigint) as ${c}`,
  boolean: (c, p) => `(json_extract_string(r['payload'], '$.${p}') in ('true','1')) as ${c}`,
}

/** 基础四类型 → kind（date/enum 在 kindOf 里特判）。与 domain/contract.ts 的闸白名单同构。
 *  @type {Record<string, string>} */
export const DATA_PLANE_KINDS = { string: 'string', number: 'number', integer: 'integer', boolean: 'boolean' }

/**
 * relation 名规则：assetId（slug）里的 `-` 转 `_`——连字符进不了 SQL 标识符。
 * 模型文件名、relation 名、L1 expression 引用三处同用本函数归一。
 * @param {string} slug
 * @returns {string}
 */
export function relationSlug(slug) {
  return String(slug).replace(/-/g, '_')
}

/**
 * 单个字段定义 → kind（与 storage.listDataPlaneForms / compileGate 的 dataPlane 闸同构）。
 * date = string+format:date 优先；enum = string 枚举次之；其余按四类型直映；白名单外 = null
 * （闸保证发布的契约映不出 null，这里是生成器侧的同构守卫）。
 * @param {Record<string, unknown> | undefined} def
 * @returns {string | null}
 */
export function kindOf(def) {
  const t = typeof def?.type === 'string' ? def.type : ''
  if (t === 'string' && def?.format === 'date') return 'date'
  if (t === 'string' && Array.isArray(def?.enum)) return 'enum'
  return DATA_PLANE_KINDS[/** @type {keyof typeof DATA_PLANE_KINDS} */ (t)] ?? null
}

/**
 * 契约 body → fields（`f_` 前缀列名；映不出 kind 的字段剔除）。
 * v2（件④ #2755）：优先取显式 `dataPlane.fields`（发布门已校验 field∈schema、kind 与 schema 一致）；
 * legacy：从 `schema.properties` 派生（存量 goal/ops 表单的产物逐字节不变）。
 * @param {unknown} body
 * @returns {Array<{ field: string, column: string, kind: string }>}
 */
export function fieldsOfBody(body) {
  const declared = /** @type {any} */ (body)?.['dataPlane']?.['fields']
  if (Array.isArray(declared)) {
    /** @type {Array<{ field: string, column: string, kind: string }>} */
    const out = []
    for (const entry of declared) {
      const field = entry?.field
      const kind = entry?.kind
      if (typeof field !== 'string' || typeof kind !== 'string') continue
      if (!(kind in SQL_TYPE)) continue // 白名单外 kind：闸保证不会出现，这里是生成器侧同构守卫
      out.push({ field, column: `${FIELD_COLUMN_PREFIX}${field}`, kind })
    }
    return out
  }
  const props = /** @type {any} */ (body)?.['schema']?.['properties']
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return []
  /** @type {Array<{ field: string, column: string, kind: string }>} */
  const out = []
  for (const [field, def] of Object.entries(props)) {
    const kind = kindOf(/** @type {Record<string, unknown> | undefined} */ (def))
    if (kind) out.push({ field, column: `${FIELD_COLUMN_PREFIX}${field}`, kind })
  }
  return out
}

/**
 * 字段契约 json（生成物 ①）。
 * @param {{ org: string, assetId: string, version: number, slug: string, fields: Array<{ field: string, column: string, kind: string }> }} form
 * @returns {Record<string, unknown>}
 */
export function buildContract(form) {
  return {
    form_def_id: form.assetId,
    org: form.org,
    version: form.version,
    relationSlug: relationSlug(form.slug),
    columns: form.fields.map((f) => ({
      field: f.field,
      column: f.column,
      kind: f.kind,
      sql_type: SQL_TYPE[/** @type {keyof typeof SQL_TYPE} */ (f.kind)] ?? '',
    })),
  }
}

/**
 * 摊平模型 SQL（生成物 ②）。relation 名 = `stg_forms_submission__<relationSlug>`。
 * @param {{ org: string, assetId: string, version: number, slug: string, fields: Array<{ field: string, column: string, kind: string }> }} form
 * @returns {string}
 */
export function buildModelSql(form) {
  if (form.fields.length === 0) {
    throw new Error('buildModelSql: 0 个可摊平字段（闸放行的表单至少应有 1 个；0 字段表单不入清单）')
  }
  const lines = []
  for (const f of form.fields) {
    const ex = EXTRACT[/** @type {keyof typeof EXTRACT} */ (f.kind)]
    if (!ex) throw new Error(`buildModelSql: 字段 ${f.field} 的 kind ${f.kind} 无提取形态（闸与生成器漂开？）`)
    lines.push(`  ${ex(f.column, f.field)}`)
  }
  return [
    "{{ config(materialized='table') }}",
    '-- 生成物：scripts/gen-forms-data-projection.mjs — 手改会被 --check 回写（改列集只改契约/声明源）',
    `-- 契约：${CONTRACT_REL_DIR}/${form.slug}.json`,
    `-- 件① 字段级摊平（#2706）：relation 名 = ${MODEL_STEM}${relationSlug(form.slug)}（连字符转下划线；`,
    '--   L1 expression 按此引用）。DuckDB 段只碰 parquet（无 join，B1）；取列一律 r[\'列名\'] 形态；',
    '--   payload 是整列 varchar JSON（ADR-0005 §13.1 ①），逐字段 schema-on-read 提取。',
    'select',
    ...HEAD_COLUMNS,
    lines.join(',\n'),
    'from read_parquet(',
    '  \'s3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet\'',
    ') r',
    `where r['form_def_id'] = '${form.assetId}'`,
    '',
  ].join('\n')
}

/** 契约 json 落盘路径。 @param {string} rootDir @param {{ slug: string }} form @returns {string} */
export function contractPathFor(rootDir, form) {
  return join(rootDir, CONTRACT_REL_DIR, `${form.slug}.json`)
}

/** 模型 sql 落盘路径。 @param {string} rootDir @param {{ slug: string }} form @returns {string} */
export function modelPathFor(rootDir, form) {
  return join(rootDir, MODEL_REL_DIR, `${MODEL_STEM}${relationSlug(form.slug)}.sql`)
}

/**
 * 从库读 dataPlane 表单清单（`storage.listDataPlaneForms` 的 JS 孪生——见文件头「两份实现」）。
 * @param {any} pool
 * @returns {Promise<Array<{ org: string, assetId: string, version: number, slug: string, fields: Array<{ field: string, column: string, kind: string }> }>>}
 */
export async function listFormsFromDb(pool) {
  const { rows } = await pool.query(
    `select v.org, v.asset_id, v.version, v.body
       from forms.asset_version v
       join forms.asset_head h on h.org = v.org and h.kind = v.kind
        and h.asset_id = v.asset_id and h.active_version = v.version
      where v.kind = 'form_def' and v.status = 'published'
        and (v.body->'dataPlane'->'analytics'->>'enabled' = 'true'
             or v.body->'dataPlane'->>'enabled' = 'true')`,
  )
  /** @type {Array<{ org: string, assetId: string, version: number, slug: string, fields: Array<{ field: string, column: string, kind: string }> }>} */
  const out = []
  for (const r of rows) {
    const fields = fieldsOfBody(r.body)
    if (fields.length > 0) {
      out.push({ org: r.org, assetId: r.asset_id, version: r.version, slug: r.asset_id, fields })
    }
  }
  return out
}

/**
 * 解析 `pg`：pnpm 布局下 scripts/ 不是 workspace 包，`pg` 只链接在 `modules/forms/node_modules`
 * ⇒ 先按本脚本位置解析，失败再按 forms 包位置（两处都没有 = 环境缺依赖，原样抛）。
 * @param {string} rootDir
 * @returns {{ Pool: new (opts: any) => any }}
 */
function requirePg(rootDir) {
  for (const from of [import.meta.url, pathToFileURL(join(rootDir, 'modules/forms', 'package.json')).href]) {
    try {
      return createRequire(from)('pg')
    } catch {
      /* 试下一个落点 */
    }
  }
  throw new Error("解析不到依赖 'pg'（仓库没装依赖？先 pnpm install）")
}

/**
 * 连库取清单。缺 DATABASE_URL / 库还没 forms schema（CI 裸 service 库）⇒ null（调用方跳过）。
 * 其余查询错误原样上抛（fail loud，不静默当空集——那会把孤儿产物判成「该删」）。
 * @param {string} rootDir 仓根
 * @returns {Promise<{ forms: Array<{ org: string, assetId: string, version: number, slug: string, fields: Array<{ field: string, column: string, kind: string }> }> | null, skipped: string | null }>}
 */
async function collectForms(rootDir) {
  const url = process.env.DATABASE_URL
  if (!url) return { forms: null, skipped: '无 DATABASE_URL —— 跳过（生成物 == committed 不变）' }
  const { Pool } = requirePg(rootDir)
  const pool = new Pool({ connectionString: url })
  try {
    return { forms: await listFormsFromDb(pool), skipped: null }
  } catch (/** @type {any} */ e) {
    // 42P01 = undefined_table：库在但 forms 迁移没跑（CI gates 的裸 service 库）——同「无库」跳过
    if (e?.code === '42P01' || /relation .* does not exist/i.test(String(e?.message ?? ''))) {
      return { forms: null, skipped: 'forms schema 不在（迁移未跑）—— 跳过（生成物 == committed 不变）' }
    }
    throw e
  } finally {
    await pool.end()
  }
}

/**
 * 生成本生成器命名空间内**应存在**的产物清单（按**文件名**为键——契约是 `<slug>.json`、
 * 模型是 `<stem><relationSlug>.sql`，两套名字规则不同，必须各按各的键比对）。
 * @param {Array<{ org: string, assetId: string, version: number, slug: string, fields: Array<{ field: string, column: string, kind: string }> }>} forms
 * @returns {{ contractNames: Set<string>, modelNames: Set<string>, files: Map<string, string> }}
 */
function expectedArtifacts(forms) {
  /** @type {Set<string>} */
  const contractNames = new Set()
  /** @type {Set<string>} */
  const modelNames = new Set()
  /** @type {Map<string, string>} 文件名（含扩展名，不含目录）→ 内容 */
  const files = new Map()
  for (const form of forms) {
    const contractName = `${form.slug}.json`
    const modelName = `${MODEL_STEM}${relationSlug(form.slug)}.sql`
    contractNames.add(contractName)
    modelNames.add(modelName)
    files.set(contractName, JSON.stringify(buildContract(form), null, 2) + '\n')
    files.set(modelName, buildModelSql(form))
  }
  return { contractNames, modelNames, files }
}

/**
 * 列出磁盘上本生成器命名空间内的现存产物（孤儿识别面）。
 * @param {string} rootDir
 * @returns {{ contracts: string[], models: string[] }} 文件名（不含目录）
 */
function existingArtifacts(rootDir) {
  /** @param {string} relDir @param {(name: string) => boolean} own */
  const list = (relDir, own) => {
    const abs = join(rootDir, relDir)
    if (!existsSync(abs)) return []
    return readdirSync(abs).filter((n) => n.endsWith('.json') ? own(n) : n.endsWith('.sql') && own(n))
  }
  return {
    contracts: list(CONTRACT_REL_DIR, (n) => n.endsWith('.json')),
    models: list(MODEL_REL_DIR, (n) => n.startsWith(MODEL_STEM) && n.endsWith('.sql')),
  }
}

/**
 * 生成主流程。
 * @param {string} rootDir 仓根
 * @param {{ check?: boolean }} [opts]
 * @returns {Promise<number>} 退出码（0 = 对齐或跳过；--check 下有漂移 = 1）
 */
export async function runGenerate(rootDir, opts = {}) {
  const { forms, skipped } = await collectForms(rootDir)
  if (skipped !== null) {
    console.error(`gen-forms-data-projection: ${skipped}`)
    return 0
  }
  const expected = expectedArtifacts(/** @type {any[]} */ (forms))
  const existing = existingArtifacts(rootDir)

  /** @type {string[]} */
  const changes = []
  /** @type {string[]} */
  const stale = []
  for (const [name, content] of expected.files) {
    const abs = name.endsWith('.json')
      ? join(rootDir, CONTRACT_REL_DIR, name)
      : join(rootDir, MODEL_REL_DIR, name)
    if (!existsSync(abs) || readFileSync(abs, 'utf8') !== content) {
      changes.push(name.endsWith('.json') ? `${CONTRACT_REL_DIR}/${name}` : `${MODEL_REL_DIR}/${name}`)
    }
  }
  for (const name of existing.contracts) {
    if (!expected.contractNames.has(name)) stale.push(`${CONTRACT_REL_DIR}/${name}`)
  }
  for (const name of existing.models) {
    if (!expected.modelNames.has(name)) stale.push(`${MODEL_REL_DIR}/${name}`)
  }

  if (opts.check) {
    if (changes.length === 0 && stale.length === 0) {
      console.error(`gen-forms-data-projection: --check OK（${expected.files.size} 份产物 == committed）`)
      return 0
    }
    for (const f of [...changes, ...stale]) console.error(`gen-forms-data-projection: 生成物漂移：${f}`)
    console.error('gen-forms-data-projection: 跑 `node scripts/gen-forms-data-projection.mjs`（带 DATABASE_URL）重新生成后一并提交')
    return 1
  }

  if (changes.length === 0 && stale.length === 0) {
    console.error(`gen-forms-data-projection: 已对齐（${expected.files.size} 份产物）`)
    return 0
  }
  mkdirSync(join(rootDir, CONTRACT_REL_DIR), { recursive: true })
  mkdirSync(join(rootDir, MODEL_REL_DIR), { recursive: true })
  for (const [name, content] of expected.files) {
    const abs = name.endsWith('.json')
      ? join(rootDir, CONTRACT_REL_DIR, name)
      : join(rootDir, MODEL_REL_DIR, name)
    writeFileSync(abs, content)
  }
  for (const rel of stale) rmSync(join(rootDir, rel))
  console.error(`gen-forms-data-projection: 写 ${expected.files.size} 份产物，删 ${stale.length} 个孤儿产物`)
  return 0
}

// ── CLI 入口（被测试 import 时不执行）──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd()
  try {
    process.exit(await runGenerate(root, { check }))
  } catch (/** @type {any} */ e) {
    console.error(`gen-forms-data-projection 失败: ${e?.message ?? e}`)
    process.exit(2)
  }
}
