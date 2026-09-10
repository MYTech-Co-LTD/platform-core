// loader.ts — 模块装载器（Task 15）：扫描 modules/*/manifest.yaml → 校验 → 迁移 →
// 权限码 upsert → 动态 import index.ts → createRouter 收集；ModulesRuntime 暴露
// modules / mount / enabledFor。整个底座架构的心脏：模块接入协议（@platform/sdk
// ManifestSchema）唯一的运行时消费方（scripts/check-manifests.mjs 是静态消费方）。
//
// 失败语义：manifest 缺失/不合法、id 重复、index.ts 非 defineModule 产物——全部抛错
// 带绝对路径，宿主（Task 16）启动即死（fail-fast），绝不带病挂半个模块。
//
// 权限 upsert 的 org 策略（M0 简化）：manifest 权限码是平台级的（每个 Casdoor org
// 都要有），但本装载器只接受单个可选 CasdoorClient——宿主装配时按"主 org"构造传入
// （single 模式 = platformOrg；multi 模式 = PLATFORM_ORG env，缺省则不传、装载器
// warn 跳过）。Task 21 冒烟里 demo 模块权限由 MockCasdoor 种子承担，不依赖此处 upsert。
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { CasdoorClient } from '@platform/auth-core'
import { ManifestSchema, type ModuleDefinition, type ModuleManifest } from '@platform/sdk'
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import { runMigrations } from './migrate'

/** 装载完成的模块：manifest（协议）+ router（createRouter 产物） */
export interface LoadedModule {
  manifest: ModuleManifest
  router: Hono
}

/**
 * 装载结果。mount 前中间件链由宿主负责（租户解析 → 会话中间件 → 模块自加
 * requireScope），mount 只做挂载；enabledFor 按「无行=启用默认」求租户可见集。
 */
export interface ModulesRuntime {
  modules: LoadedModule[]
  mount(app: Hono): void
  enabledFor(tenantId: number): Promise<Set<string>>
}

export interface LoadModulesDeps {
  pool: Pool
  /** 主 org 的 CasdoorClient（admin 凭据）；缺省 → 权限 upsert warn 跳过（见文件头） */
  casdoor?: CasdoorClient
}

/** 内部形态：LoadedModule + 模块目录（userApp dist 相对它解析，不外露） */
interface ModuleEntry extends LoadedModule {
  dir: string
}

export async function loadModules(
  modulesDir: string,
  deps: LoadModulesDeps,
): Promise<ModulesRuntime> {
  // readdir 失败（如 modules/ 目录不存在）自然抛错——宿主启动 fail-fast
  const entries = await readdir(modulesDir, { withFileTypes: true })

  const loaded: ModuleEntry[] = []
  const seen = new Map<string, string>() // id → 首见模块目录（重复 id 报错带两个路径）

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.resolve(modulesDir, entry.name)
    const manifestPath = path.join(dir, 'manifest.yaml')

    // ① 读 + YAML 解析 + ManifestSchema 校验（失败抛错带绝对路径）
    let manifest: ModuleManifest
    try {
      manifest = ManifestSchema.parse(parseYaml(await readFile(manifestPath, 'utf8')))
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new Error(`manifest 校验失败 ${manifestPath}: ${err.message}`, { cause: err })
      }
      // readFile ENOENT（消息自带绝对路径）/ YAML 语法错 —— 原样抛
      throw err
    }

    // ② id 去重：模块 id 是权限/路由命名空间，撞车即协议事故
    const firstDir = seen.get(manifest.id)
    if (firstDir) {
      throw new Error(`模块 id 重复 "${manifest.id}"：${firstDir} 与 ${dir}`)
    }
    seen.set(manifest.id, dir)

    // ③ 模块迁移（目录不存在静默跳过——migrate.ts 约定）
    await runMigrations(
      deps.pool,
      manifest.id,
      path.join(dir, manifest.migrations?.dir ?? 'migrations'),
    )

    // ④ 权限码 upsert（幂等）；无 casdoor 实例 → warn 跳过（M0 见文件头）
    if (deps.casdoor) {
      for (const p of manifest.permissions) {
        await deps.casdoor.upsertPermission(p.code, p.name)
      }
    } else if (manifest.permissions.length > 0) {
      console.warn(
        `[modules] 无 CasdoorClient，跳过权限 upsert：${manifest.id} → `
          + manifest.permissions.map((p) => p.code).join(', '),
      )
    }

    // ⑤ 动态 import index.ts（tsx / vitest 运行时都按 TS 转译）→ defineModule 产物校验
    const entryPath = path.join(dir, 'index.ts')
    const mod = (await import(pathToFileURL(entryPath).href)) as { default?: unknown }
    const def = mod.default as Partial<ModuleDefinition> | undefined
    if (
      !def
      || typeof def !== 'object'
      || !def.manifest
      || typeof def.createRouter !== 'function'
    ) {
      throw new Error(
        `${entryPath} 的 default 导出不是 defineModule 产物（缺 manifest/createRouter）`,
      )
    }

    loaded.push({ manifest, router: def.createRouter({ pool: deps.pool }), dir })
  }

  return {
    modules: loaded,

    // ⑥ API 挂 /api/modules/<id>；userApp 静态目录存在才挂（dist 绝对路径，mount 路径来自 manifest）
    mount(app: Hono): void {
      for (const m of loaded) {
        app.route('/api/modules/' + m.manifest.id, m.router)

        const userApp = m.manifest.frontend?.userApp
        if (!userApp) continue
        const dist = path.resolve(m.dir, userApp.dist)
        if (!existsSync(dist)) continue // 目录不存在静默跳过（模块未构建前端）
        const mountPath = userApp.mount.replace(/\/+$/, '') // 去尾斜杠，统一拼 /* 后缀
        // serveStatic 以 root+完整请求路径拼文件名，须剥掉挂载前缀还原 dist 内相对路径
        app.use(
          mountPath + '/*',
          serveStatic({
            root: dist,
            rewriteRequestPath: (p) => p.slice(mountPath.length) || '/',
          }),
        )
      }
    },

    // ⑦ 租户已启用模块集（Task 12 /config 的闸门）。简报基线 SQL 是
    //    `where tenant_id=$1 and enabled`（只回显式启用行）——「无行=启用默认」要求
    //    把无行模块也并入集合（消费方 routes/platform.ts 直接 .filter(has) 消费），
    //    故取该租户全行后在内存按默认值判定：显式 enabled=true 落集合、false 剔除、
    //    无行视为启用；只回已装载模块的 id（磁盘上已删的模块不在任何租户可见集里）。
    async enabledFor(tenantId: number): Promise<Set<string>> {
      const { rows } = await deps.pool.query<{ module_id: string; enabled: boolean }>(
        'select module_id, enabled from platform.tenant_module where tenant_id = $1',
        [tenantId],
      )
      const explicit = new Map(rows.map((r) => [r.module_id, r.enabled]))
      const enabled = new Set<string>()
      for (const m of loaded) {
        if (explicit.get(m.manifest.id) ?? true) enabled.add(m.manifest.id)
      }
      return enabled
    },
  }
}
