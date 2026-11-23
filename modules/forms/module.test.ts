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

  it('权限码矩阵：全 forms: 前缀；global-manage / data-plane 在列（P4：platformOnly）；OA P1 审批三档 + 回调码', () => {
    const codes = mod.manifest.permissions.map((p) => p.code).sort()
    expect(codes).toEqual([
      'forms:approval:manage',
      'forms:approval:publish',
      'forms:approval:view',
      'forms:case:callback',
      'forms:data-plane',
      'forms:fill',
      'forms:global-manage',
      'forms:manage',
      'forms:publish',
      'forms:view',
    ])
  })

  it('全局字典管理码 / 分析面审批码标记 platformOnly（租户管理员授权宇宙不含它们）', () => {
    for (const code of ['forms:global-manage', 'forms:data-plane']) {
      const p = mod.manifest.permissions.find((x) => x.code === code)
      expect(p?.platformOnly, code).toBe(true)
    }
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

  it('mcpFaces（2026-11-16 能力网关）：read→/mcp forms:view、manage→/mcp-manage forms:manage；发布类不在任何 face', () => {
    const faces = mod.manifest.mcpFaces ?? []
    expect(faces.map((f) => `${f.face} ${f.method} ${f.path} ${f.scope}`)).toEqual([
      'read POST /mcp forms:view',
      'manage POST /mcp-manage forms:manage',
    ])
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path} ${e.scope}`))
    for (const f of faces) {
      expect(declared.has(`${f.method} ${f.path} ${f.scope}`), `${f.face} 未在 api.internal 声明`).toBe(true)
      expect(f.scope).not.toBe('forms:publish')
    }
  })

  it('声明面断言：发布/回滚/退役端点必须是 forms:publish（人 gate 的 scope 落点）；写面不出现 guest', () => {
    // 24 + OA P1 审批 12 条 + /mcp（2026-11-16 能力网关）+ OA P2 标准审批绑定 6 条
    // + OA P2 Task 7 标准审批镜像列表/导出 2 条 + 收集轮次 5 条（件③ #2707）
    // + 运营实时统计 1 条（件④ #2755：POST /stats）
    expect(mod.manifest.api?.internal?.length).toBe(51)
    expect(mod.manifest.guest).toBeUndefined() // M1.2 无 guest 面（§14.4 防滥用随 M1.3 填报通道）
    for (const e of mod.manifest.api?.internal ?? []) {
      const key = `${e.method} ${e.path}`
      if (PUBLISH_PATHS.has(key)) expect(e.scope, key).toBe('forms:publish')
      if (e.path.startsWith('/global-dicts') && e.method !== 'GET') {
        expect(e.scope, key).toBe('forms:global-manage') // P4：全局字典编辑权收平台超管
      }
      // OA P1：审批模板发布是人 gate；审批动作/回调各自有专属 scope（不混用 forms:publish）
      if (key === 'POST /approval-defs/:assetId/versions/:v/publish') {
        expect(e.scope).toBe('forms:approval:publish')
      }
      if (key === 'POST /approval-callback') expect(e.scope).toBe('forms:case:callback')
      // OA P2：绑定资产全端点 = 平台管理员；发布门绝不能落到普通 forms:publish / approval:publish
      if (e.path.startsWith('/approval-bindings')) {
        expect(e.scope, key).toBe('forms:global-manage')
      }
      // OA P2 Task 7：镜像列表/导出是只读面（org 由身份钉死），与 /export/submissions 同档
      if (e.path.startsWith('/standard-approvals')) {
        expect(e.method, key).toBe('GET')
        expect(e.scope, key).toBe('forms:view')
      }
      // 件④ #2755：实时统计是只读面（org 由身份钉死），与读面同档
      if (key === 'POST /stats') expect(e.scope).toBe('forms:view')
      // 件③ #2707：轮次读面 forms:view；写面（建轮/开轮/关轮）forms:manage
      if (e.path === '/rounds' || e.path === '/rounds/:id') {
        if (e.method === 'GET') expect(e.scope, key).toBe('forms:view')
        else expect(e.scope, key).toBe('forms:manage')
      }
      if (e.path === '/rounds/:id/open' || e.path === '/rounds/:id/close') {
        expect(e.scope, key).toBe('forms:manage')
      }
    }
  })

  it('OA P2：标准审批绑定页是独立 console 条目，scope=forms:global-manage（platformOnly）', () => {
    const entry = (mod.manifest.frontend?.console ?? []).find((e) => e.path === '/console/forms-bindings')
    expect(entry).toBeDefined()
    expect(entry?.scope).toBe('forms:global-manage')
    expect(entry?.title).toBe('标准审批绑定')
    const permission = mod.manifest.permissions.find((p) => p.code === 'forms:global-manage')
    expect(permission?.platformOnly).toBe(true)
  })

  it('OA 事件声明（P1 两个）：awaiting 由外部生产者产生，decided 由本模块产生', () => {
    const events = mod.manifest.notifications?.events ?? []
    const awaiting = events.find((e) => e.key === 'forms.approval.awaiting')
    const decided = events.find((e) => e.key === 'forms.approval.decided')
    expect(awaiting?.producer).toBe('external:case-engine')
    expect(awaiting?.payload.assignee?.required).toBe(true)
    expect(decided?.producer).toBeUndefined()
    expect(decided?.recipients.submitter).toEqual({ kind: 'field', field: 'submitter' })
    // P1 不提前占坑
    expect(events.map((e) => e.key)).not.toContain('forms.task.assigned')
  })

  it('migrations 目录在位（内核迁移 001_kernel.sql 已落）', () => {
    // node:path 取法（happy-dom 的全局 URL 分辨不出 file: 方案——与 index.ts 同款订正）
    expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_kernel.sql'))).toBe(true)
  })
})
