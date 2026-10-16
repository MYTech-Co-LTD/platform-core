import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ManifestSchema } from '@platform/sdk'
import mod from './index'

// 模块骨架回归锁（issue #708）：manifest 由宿主装载期 ManifestSchema.parse + 双向核对把关，
// 这里钉的是骨架自身不漂——三同的 id、零权限码零路由的骨架口径、迁移目录在位。
describe('forms 模块骨架（issue #708）', () => {
  it('manifest.yaml 过 schema，id = forms（三同之一；DB schema 名与 API 前缀随 id，B1 门禁兜底）', () => {
    const m = ManifestSchema.parse(mod.manifest)
    expect(m.id).toBe('forms')
    expect(m.name).toBe('表单模块')
    expect(m.migrations?.dir).toBe('./migrations')
  })

  it('骨架口径：零权限码、零路由（M1.2 业务面落地时按双向核对纪律同步加）', () => {
    expect(mod.manifest.permissions).toEqual([])
    expect(mod.manifest.api?.internal ?? []).toEqual([])
    const registered = mod
      .createRouter({ pool: null as never })
      .routes.filter((r) => r.method !== 'ALL')
    expect(registered).toEqual([])
  })

  it('migrations 目录在位（git 不跟踪空目录，.gitkeep 占位）', () => {
    expect(existsSync(new URL('./migrations', import.meta.url))).toBe(true)
  })
})
