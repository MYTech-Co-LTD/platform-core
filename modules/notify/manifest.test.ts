// manifest.test.ts — 收件箱权限边界（N5 收件箱权限模型决策）
//
// 收件箱是「自助」面：所有成员都应能读自己的行，但**不能**因此获得 notify:view
// （后者还管规则/模板/通道/全部投递）。这条测试钉住 manifest，避免以后图省事把
// inbox 路由改回 notify:view。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))

type Decl = { method: string; path: string; scope: string }
type Manifest = {
  permissions: Array<{ code: string }>
  api?: { internal?: Decl[] }
  frontend?: { console?: Array<{ path: string; scope: string }> }
}

const manifest = parse(readFileSync(join(dir, 'manifest.yaml'), 'utf8')) as Manifest

describe('notify manifest — 收件箱权限', () => {
  it('存在 notify:inbox 权限码', () => {
    expect(manifest.permissions.map((p) => p.code)).toContain('notify:inbox')
  })

  it('/inbox 三个端点都只要求 notify:inbox，不得回退到 notify:view', () => {
    const inbox = (manifest.api?.internal ?? []).filter((d) => d.path.startsWith('/inbox'))
    expect(inbox.map((d) => `${d.method} ${d.path}`).sort()).toEqual([
      'GET /inbox',
      'POST /inbox/:id/read',
      'POST /inbox/read-all',
    ])
    expect(inbox.every((d) => d.scope === 'notify:inbox')).toBe(true)
  })

  it('console 收件箱入口用 notify:inbox（其他通知页仍是 notify:view）', () => {
    const entries = manifest.frontend?.console ?? []
    expect(entries.find((e) => e.path === '/console/notify/inbox')?.scope).toBe('notify:inbox')
    expect(entries.find((e) => e.path === '/console/notify/deliveries')?.scope).toBe('notify:view')
  })
})
