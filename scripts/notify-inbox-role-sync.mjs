#!/usr/bin/env node
// scripts/notify-inbox-role-sync.mjs — 把 `notify:inbox` 广授全员的收敛 job（N5 收件箱权限模型）。
//
// 为什么需要它：收件箱是自助面，权限码 `notify:inbox` 不能靠逐个用户手工挂——
// 新员工入租户（控制台建号 / 企微同步 / Casdoor 后台直建 / 登录 JIT）都会漏。
// 本 job 每轮把角色成员对齐到「该 org 全部未禁用用户」，覆盖所有建号路径。
//
// 语义：
//   - 角色 `notify-inbox-readers` 是**派生角色**：成员 = 全部 active 用户；不要手工改它。
//   - 只碰这个角色与 `notify:inbox` 的挂接，不碰任何其他权限。
//   - 权限码不存在（模块未部署/未装载）⇒ 跳过该 org 并报错，不静默创建空壳。
//
// 退出码：0 全部收敛；1 有 org 失败；2 缺凭据 / 查询失败。

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const ROLE_NAME = 'notify-inbox-readers'
export const PERMISSION_CODE = 'notify:inbox'

/**
 * 用户列表 → 角色成员短名（去 org 前缀、去禁用、去重）。
 * @param {ReadonlyArray<{ name: string, isForbidden?: boolean }>} users
 * @param {string} org
 * @returns {string[]}
 */
export function desiredRoleMembers(users, org) {
  const prefix = `${org}/`
  return [...new Set(users
    .filter((u) => u.isForbidden !== true)
    .map((u) => (u.name.startsWith(prefix) ? u.name.slice(prefix.length) : u.name))
    .filter((n) => n !== ''))].sort()
}

/**
 * 两个成员集合是否一致（顺序无关；短名/全形双认）。
 * @param {ReadonlyArray<string>} a
 * @param {ReadonlyArray<string>} b
 */
export function sameMembers(a, b) {
  if (a.length !== b.length) return false
  const set = new Set(a.map((x) => x.replace(/^[^/]+\//, '')))
  return b.every((x) => set.has(x.replace(/^[^/]+\//, '')))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-inbox-role-sync: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  if (!process.env.CASDOOR_URL || !process.env.CASDOOR_ADMIN_USER || !process.env.CASDOOR_ADMIN_PWD) {
    console.error('notify-inbox-role-sync: 缺 CASDOOR_URL / CASDOOR_ADMIN_USER / CASDOOR_ADMIN_PWD')
    process.exit(2)
  }

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    // 跨包相对引用：scripts/ 测试与 ops 脚本的既有写法（同 notify-preflight）。
    const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
    const { rows } = await pool.query('select casdoor_org from platform.tenant order by id')

    let failed = 0
    const out = []
    for (const { casdoor_org: org } of rows) {
      const client = new CasdoorClient({
        origin: String(process.env.CASDOOR_URL),
        clientId: process.env.CASDOOR_CLIENT_ID ?? '',
        clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
        org,
        adminUser: String(process.env.CASDOOR_ADMIN_USER),
        adminPwd: String(process.env.CASDOOR_ADMIN_PWD),
      })
      try {
        const perms = await client.getPermissions()
        if (!perms.some((p) => (p.resources ?? []).includes(PERMISSION_CODE))) {
          throw new Error(`权限码 ${PERMISSION_CODE} 不存在（模块未装载？）`)
        }
        await client.createRole({ name: ROLE_NAME, displayName: '收件箱读者（全员）' })
        const desired = desiredRoleMembers(await client.listUsers(), org)
        const current = (await client.listRoles()).find((r) => r.name === ROLE_NAME)?.users ?? []
        const changed = !sameMembers(current, desired)
        if (changed) await client.setRoleMembers(ROLE_NAME, desired)
        await client.grantPermissionToRole(PERMISSION_CODE, ROLE_NAME)
        out.push({ org, members: desired.length, changed })
      } catch (e) {
        failed++
        out.push({ org, error: e instanceof Error ? e.message : String(e) })
      }
    }
    console.log(JSON.stringify({ tenants: rows.length, failed, out }))
    process.exit(failed > 0 ? 1 : 0)
  } catch (e) {
    console.error('notify-inbox-role-sync 查不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
