import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ManifestSchema } from '@platform/sdk'
import mod from './index'

// 模块回归锁（#708 骨架 + #710 内核）：manifest 由宿主装载期 ManifestSchema.parse +
// 双向核对把关，这里钉的是声明自身不漂——三同 id、权限码矩阵（P4 分档）、
// 声明↔注册双向一致（装载期核对的本地版）、迁移目录在位。

const PUBLISH_PATHS = new Set([
  'POST /defs/:assetId/versions/:v/publish',
  'POST /defs/:assetId/rollback',
  'POST /defs/:assetId/versions/:v/retire',
])

describe('forms 模块声明（#708/#710）', () => {
  it('manifest.yaml 过 schema，id = forms（三同之一；DB schema 名与 API 前缀随 id，B1 门禁兜底）', () => {
    const m = ManifestSchema.parse(mod.manifest)
    expect(m.id).toBe('forms')
    expect(m.name).toBe('表单模块')
    expect(m.migrations?.dir).toBe('./migrations')
  })

  it('权限码矩阵：五码全 forms: 前缀；global-manage 在列（P4：默认无租户角色持有，授予=平台运营显式动作）', () => {
    const codes = mod.manifest.permissions.map((p) => p.code).sort()
    expect(codes).toEqual([
      'forms:fill',
      'forms:global-manage',
      'forms:manage',
      'forms:publish',
      'forms:view',
    ])
  })

  it('api.internal 声明集合与 createRouter 注册的路由集合逐条一致（双向核对的本地版）', () => {
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path}`))
    const registered = new Set(
      mod
        .createRouter({ pool: null as never })
        .routes.filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    )
    const undeclared = [...registered].filter((x) => !declared.has(x))
    const unregistered = [...declared].filter((x) => !registered.has(x))
    expect(undeclared, '注册了但未声明（装载即挂）').toEqual([])
    expect(unregistered, '声明了但未注册（永不可达）').toEqual([])
  })

  it('声明面断言：发布/回滚/退役端点必须是 forms:publish（人 gate 的 scope 落点）；写面不出现 guest', () => {
    expect(mod.manifest.api?.internal?.length).toBe(23)  // 21 + AI 起草 /generate + 管理面 /mcp-manage（#724）
    expect(mod.manifest.guest).toBeUndefined() // M1.2 无 guest 面（§14.4 防滥用随 M1.3 填报通道）
    for (const e of mod.manifest.api?.internal ?? []) {
      const key = `${e.method} ${e.path}`
      if (PUBLISH_PATHS.has(key)) expect(e.scope, key).toBe('forms:publish')
      if (e.path.startsWith('/global-dicts') && e.method !== 'GET') {
        expect(e.scope, key).toBe('forms:global-manage') // P4：全局字典编辑权收平台超管
      }
    }
  })

  it('migrations 目录在位（内核迁移 001_kernel.sql 已落）', () => {
    // node:path 取法（happy-dom 的全局 URL 分辨不出 file: 方案——与 index.ts 同款订正）
    expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_kernel.sql'))).toBe(true)
  })
})
