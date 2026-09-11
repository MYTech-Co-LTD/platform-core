// loader.ts — 模块装载器（Task 15）：扫描 modules/*/manifest.yaml → 校验 → 迁移 →
// 权限码 upsert → 动态 import index.ts → createRouter 收集；ModulesRuntime 暴露
// modules / mount / enabledFor。整个底座架构的心脏：模块接入协议（@platform/sdk
// ManifestSchema）唯一的运行时消费方（scripts/check-manifests.mjs 是静态消费方）。
//
// 失败语义：manifest 缺失/不合法、id 重复、index.ts 非 defineModule 产物——全部抛错
// 带绝对路径，宿主（Task 16）启动即死（fail-fast），绝不带病挂半个模块。
//
// 权限码供给的 org 策略（M1）：权限码是平台级能力，但 Casdoor 的权限记录按 org（owner=）
// 存储，而读侧按租户 org 读（session-middleware.ts 的 casdoor(p.org)）——故装载器遍历
// platform.tenant 的每个 casdoor_org 各建一套码（provisionModulePermissions）。
// 权威租户清单来自 DB，**不是 PLATFORM_ORG 环境变量**（后者只服务 single 的租户解析）。
// 只写一个 org 的旧策略会让其余租户 effectiveScopes 恒空 ⇒ 模块 API 全线 403 而宿主全绿。
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { parse as parseYaml } from 'yaml'
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
  /**
   * 按 org 返回 CasdoorClient 的工厂（宿主传 casdoorFactory，内部按 org 缓存实例）。
   *
   * 可选**只服务 loader 测试与注入式用法**：宿主 `app.ts` 无条件传工厂，生产上不存在缺省
   * 路径（`config.ts` 已把 admin 凭据设为必填）。缺省时按 warn 跳过供给。
   *
   * 注意别把这里的可选读成「存在一种不配凭据也能用的部署形态」——**没有那种形态**：
   * 登录签发前必调 getUser + getPermissions，两者都走 admin 会话，缺凭据时无人能拿到会话。
   */
  casdoorFor?: (org: string) => CasdoorClient
}

/** 待供给的权限码（manifest.permissions 的元素形状） */
export interface ProvisionPermission {
  code: string
  name: string
}

/**
 * 把模块权限码供给到【每个租户各自的 Casdoor org】。
 *
 * 为什么必须遍历租户：权限码是平台级能力，但 Casdoor 的权限记录按 org（owner=）存储，
 * 读侧又按租户 org 读（session-middleware.ts 的 casdoor(p.org)）。只写一个 org ⇒
 * 其余租户 effectiveScopes 恒空 ⇒ 模块 API 全线 403 而宿主全绿（issue #3 第一节）。
 *
 * 权威租户清单来自 platform.tenant，**不是 env**：PLATFORM_ORG 只服务 single 的租户解析。
 * 返回实际供给到的 org 列表——调用方据此区分「没有租户可供给」与「没有权限码可供给」。
 */
export async function provisionModulePermissions(
  pool: Pool,
  casdoorFor: (org: string) => CasdoorClient,
  permissions: ReadonlyArray<ProvisionPermission>,
): Promise<string[]> {
  if (permissions.length === 0) return []
  const { rows } = await pool.query<{ casdoor_org: string }>(
    'select distinct casdoor_org from platform.tenant order by casdoor_org',
  )
  for (const { casdoor_org: org } of rows) {
    // 批量接口：每 org 只拉一次 get-permissions（单码版是每码一次，租户扩张下是乘法开销）
    await casdoorFor(org).upsertPermissions(permissions)
  }
  return rows.map((r) => r.casdoor_org)
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
      let parsed: unknown
      try {
        parsed = parseYaml(await readFile(manifestPath, 'utf8'))
      } catch (err) {
        // readFile ENOENT（消息自带绝对路径）原样抛；YAML 语法错包一层带绝对路径
        // （Task 15 评审 M-1：yaml.parse 原始错误只有行号列号，无文件定位）
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
        throw new Error(`${manifestPath}: ${(err as Error).message}`, { cause: err })
      }
      manifest = ManifestSchema.parse(parsed)
    } catch (err) {
      // err?.name 而非 instanceof：manifest 可能来自不同 zod 实例（跨包解析），
      // instanceof 判定会静默退化为"原样抛"（Task 15 评审 M-2）；ZodError.name 是稳定标识
      if ((err as { name?: string } | null)?.name === 'ZodError') {
        throw new Error(`manifest 校验失败 ${manifestPath}: ${(err as Error).message}`, { cause: err })
      }
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

    // ④ 动态 import index.ts（tsx / vitest 运行时都按 TS 转译）→ defineModule 产物校验
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

  // ⑤ 权限码供给：全部模块的权限码一次性供给到每个租户各自的 org（见 provisionModulePermissions）。
  //    放在循环之后而非之内：租户清单只需查一次，且 manifest 全部校验通过后才产生副作用
  const allPermissions = loaded.flatMap((m) => m.manifest.permissions)
  if (deps.casdoorFor) {
    const orgs = await provisionModulePermissions(deps.pool, deps.casdoorFor, allPermissions)
    if (orgs.length === 0 && allPermissions.length > 0) {
      console.warn('[modules] platform.tenant 无租户，权限码未供给任何 org（先跑租户 seed）')
    }
  } else if (allPermissions.length > 0) {
    // warn 说清后果，但**不替调用方断言 HTTP 状态**：这些租户的用户拿不到任何模块权限是
    // 确定的；至于它表现为 403 还是"根本登录不了"，取决于宿主有没有配 admin 凭据（登录
    // 本身就要管理端点）——装载器无从知道，写死 403 就是在许一个自己证明不了的承诺
    const { rows } = await deps.pool.query<{ casdoor_org: string }>(
      'select distinct casdoor_org from platform.tenant order by casdoor_org',
    )
    console.warn(
      '[modules] 未提供 CasdoorClient 工厂，跳过权限码供给：'
        + `${allPermissions.map((p) => p.code).join(', ')} → 租户 org `
        + `[${rows.map((r) => r.casdoor_org).join(', ') || '(无租户)'}]（这些租户的用户将拿不到任何模块权限）`,
    )
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
