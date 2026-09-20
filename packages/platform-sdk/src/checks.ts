import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema } from './manifest'

/**
 * check-manifests 的核心逻辑（Task 8，B4/B5 门禁）。
 * scripts/check-manifests.mjs 只是一行调用；这样 CLI 层可以直接用临时 fixtures 目录测。
 *
 * 检查项：
 *  ① manifest.yaml 可被 YAML 解析且过 ManifestSchema
 *  ② 模块 id 全局唯一（modules/ 与 scaffolds/customer/ 合并看，B4 命名空间）
 *  ③ frontend.console[].entry / migrations.dir 指向的文件/目录存在（相对 manifest 所在目录）
 *  ④ bindings 键 ∈ {postgres, novu, cube}
 */
export const BINDING_KEYS = ['postgres', 'novu', 'cube'] as const

export interface CheckResult {
  /** 空数组 = 全部通过（CLI exit 0）；每条已含相对路径与错误描述 */
  errors: string[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** 遍历 modules/<模块>/manifest.yaml 与 scaffolds/customer/<客户>/modules/<模块>/manifest.yaml（存在时）。 */
async function listManifestFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []

  const collect = async (modulesDir: string): Promise<void> => {
    if (!(await isDir(modulesDir))) return
    for (const entry of await readdir(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(modulesDir, entry.name, 'manifest.yaml')
      if (await exists(file)) files.push(file)
    }
  }

  await collect(join(rootDir, 'modules'))
  const customerDir = join(rootDir, 'scaffolds', 'customer')
  if (await isDir(customerDir)) {
    for (const cust of await readdir(customerDir, { withFileTypes: true })) {
      if (!cust.isDirectory()) continue
      await collect(join(customerDir, cust.name, 'modules'))
    }
  }
  return files.sort()
}

function displayPath(rootDir: string, file: string): string {
  const rel = relative(rootDir, file)
  return isAbsolute(rel) || rel.startsWith('..') ? file : rel
}

export async function runChecks(rootDir: string): Promise<CheckResult> {
  const errors: string[] = []
  const files = await listManifestFiles(rootDir)
  const seenIds = new Map<string, string>() // id → 首次出现的相对路径

  for (const file of files) {
    const relPath = displayPath(rootDir, file)

    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (e) {
      errors.push(`${relPath}: 读取失败（${(e as Error).message}）`)
      continue
    }

    let doc: unknown
    try {
      doc = parseYaml(raw)
    } catch (e) {
      errors.push(`${relPath}: YAML 解析失败（${(e as Error).message}）`)
      continue
    }

    const parsed = ManifestSchema.safeParse(doc)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const at = issue.path.length > 0 ? issue.path.join('.') : '(root)'
        errors.push(`${relPath}: schema 校验失败 [${at}]: ${issue.message}`)
      }
      continue
    }
    const m = parsed.data

    // ② id 全局唯一（B4：modules/ 与 scaffolds/customer/ 共用一个命名空间）
    const firstSeen = seenIds.get(m.id)
    if (firstSeen !== undefined) {
      errors.push(`${relPath}: 模块 id "${m.id}" 重复（首次出现在 ${firstSeen}）——B4 命名空间要求全局唯一`)
    } else {
      seenIds.set(m.id, relPath)
    }

    // ③ 文件存在性（相对 manifest 所在目录）
    for (const [i, c] of (m.frontend?.console ?? []).entries()) {
      const target = join(dirname(file), c.entry)
      if (!(await exists(target))) {
        errors.push(`${relPath}: frontend.console[${i}].entry 指向的文件不存在: ${c.entry}`)
      }
    }
    // ③b 模块管理页协议（2026-09-20 spec）：admin entry 与 console entry 同规
    for (const [i, a] of (m.frontend?.admin ?? []).entries()) {
      const target = join(dirname(file), a.entry)
      if (!(await exists(target))) {
        errors.push(`${relPath}: frontend.admin[${i}].entry 指向的文件不存在: ${a.entry}`)
      }
    }
    if (m.migrations) {
      const dir = join(dirname(file), m.migrations.dir)
      if (!(await isDir(dir))) {
        errors.push(`${relPath}: migrations.dir 指向的目录不存在: ${m.migrations.dir}`)
      }
    }

    // ④ bindings 键白名单
    for (const key of Object.keys(m.bindings ?? {})) {
      if (!(BINDING_KEYS as readonly string[]).includes(key)) {
        errors.push(`${relPath}: bindings 键 "${key}" 不在白名单 {postgres, novu, cube}`)
      }
    }
  }

  return { errors }
}
