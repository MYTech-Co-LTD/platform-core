#!/usr/bin/env node
// gen-console-registry.mjs —— console registry 生成器（Task 18）。
//
// 「模块不再有自己的管理后台」的构建期落地：扫描 <root>/modules/*/manifest.yaml 的
// frontend.console，聚合成 apps/web/src/console-registry.gen.ts（生成物，进 git，勿手改）。
// Console 壳按 /api/platform/config 的运行时清单过滤菜单，本文件只负责「有哪些页可挂」。
//
// 用法：node scripts/gen-console-registry.mjs [rootDir]
//   rootDir 缺省 = 脚本自身位置上溯的仓根（import.meta.url，不受调用方 cwd 影响——
//   web 包 build 脚本从 apps/web 以相对路径调用）；测试传临时 fixture 目录。
// 输出恒为 <rootDir>/apps/web/src/console-registry.gen.ts；无模块/无 console 项 → 空数组（合法）。
// manifest 合法性由 scripts/check-manifests.mjs 门禁兜底，这里只做生成所需的最小形状校验
// （形状不对直接失败——宁可 build 红也不生成半份 registry）。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const rootDir = resolve(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))))
const modulesDir = join(rootDir, 'modules')
const outFile = join(rootDir, 'apps', 'web', 'src', 'console-registry.gen.ts')

/** 单个 manifest → registry 项；console 缺失/为空返回 []（合法），形状不对抛错 */
function entriesFor(moduleId, manifest) {
  const consoleItems = manifest?.frontend?.console
  if (consoleItems === undefined) return []
  if (!Array.isArray(consoleItems)) {
    throw new Error(`modules/${moduleId}/manifest.yaml: frontend.console 必须是数组`)
  }
  return consoleItems.map((item, i) => {
    const where = `modules/${moduleId}/manifest.yaml frontend.console[${i}]`
    for (const key of ['path', 'title', 'scope', 'entry']) {
      if (typeof item?.[key] !== 'string' || item[key] === '') {
        throw new Error(`${where}: ${key} 必须是非空字符串`)
      }
    }
    return {
      path: item.path,
      title: item.title,
      // icon 可选；字符串透传（AntD 图标名，Console 壳负责名→组件映射）
      ...(typeof item.icon === 'string' ? { icon: item.icon } : {}),
      scope: item.scope,
      // entry 形如 ./console/main.tsx —— import 说明符只需去掉 ./ 前缀
      entry: item.entry.replace(/^\.\//, ''),
    }
  })
}

const entries = []
const moduleDirs = await readdir(modulesDir, { withFileTypes: true })
  // modules/ 不存在（空仓）→ 空数组注册表同样合法
  .catch(() => [])

for (const dir of moduleDirs) {
  if (!dir.isDirectory()) continue
  const manifestFile = join(modulesDir, dir.name, 'manifest.yaml')
  let raw
  try {
    raw = await readFile(manifestFile, 'utf8')
  } catch {
    continue // 无 manifest 的目录（脚手架/文档）不参与
  }
  let manifest
  try {
    manifest = parseYaml(raw)
  } catch (e) {
    throw new Error(`modules/${dir.name}/manifest.yaml: YAML 解析失败：${e.message}`)
  }
  if (typeof manifest?.id !== 'string' || manifest.id === '') {
    throw new Error(`modules/${dir.name}/manifest.yaml: id 必须是非空字符串`)
  }
  if (manifest.id !== dir.name) {
    throw new Error(`modules/${dir.name}/manifest.yaml: id "${manifest.id}" 与目录名不一致`)
  }
  entries.push(...entriesFor(manifest.id, manifest).map((e) => ({ moduleId: manifest.id, ...e })))
}

// 确定性输出：按模块 id 排序；同一 manifest 内保持声明序（sort 稳定）——菜单顺序跟着 manifest 走
entries.sort((a, b) => a.moduleId.localeCompare(b.moduleId))

// path 重复（跨模块撞路由）直接失败——静默丢弃会让菜单与路由对不上
const seen = new Map()
for (const e of entries) {
  const owner = seen.get(e.path)
  if (owner !== undefined) {
    throw new Error(`console path "${e.path}" 重复：${owner} 与 ${e.moduleId} 都声明了`)
  }
  seen.set(e.path, e.moduleId)
}

const relModuleImport = (e) => {
  // 生成物在 apps/web/src/ 下，import 说明符相对它计算（fixture 根同构，深度一致）
  const spec = relative(join(rootDir, 'apps', 'web', 'src'), join(modulesDir, e.moduleId, e.entry))
  return JSON.stringify(spec.split('\\').join('/')) // windows 分隔符归一
}

const header = `// @generated —— scripts/gen-console-registry.mjs 生成物，勿手改（build 前置自动重生成）。
// 来源：modules/*/manifest.yaml 的 frontend.console。无模块/无 console 项 → 空数组（合法）。
import type { ComponentType } from 'react'

export interface ConsoleRegistryEntry {
  /** 模块 console 页路由（全路径，以 /console/ 开头），与 manifest frontend.console.path 一致 */
  path: string
  title: string
  /** AntD 图标名（字符串透传；Console 壳按名映射，未知名不渲染图标） */
  icon?: string
  /** 访问该页所需权限 scope（session.scopes 成员判定） */
  scope: string
  /** 构建期聚合的懒加载器：模块 console 页模块的 default 导出（组件） */
  load: () => Promise<{ default: ComponentType }>
}

export const consoleRegistry: ConsoleRegistryEntry[] = [`

const body = entries
  .map((e) => {
    const iconLine = e.icon === undefined ? '' : `\n    icon: ${JSON.stringify(e.icon)},`
    return `  {
    path: ${JSON.stringify(e.path)},
    title: ${JSON.stringify(e.title)},${iconLine}
    scope: ${JSON.stringify(e.scope)},
    load: () => import(${relModuleImport(e)}),
  },`
  })
  .join('\n')

const file = `${header}${body === '' ? ']' : `\n${body}\n]`}
`

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, file, 'utf8')
console.log(`gen-console-registry: ${entries.length} 项 → ${relative(rootDir, outFile)}`)
