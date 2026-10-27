#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：与 provision-tenant.mjs 同款（scripts/ 不属于任何 workspace 包，
// 裸 import 'pg' 解析不到；pg 经 createRequire 锚到 apps/server）
// audit-permission-holders.mjs — 只读：列出各租户 org 中持有指定权限码的用户。
//
// 用途：A（JIT 全量授权）与 B（platformOnly 码）的存量复核。**绝不写 Casdoor / DB**。
// 用法：pnpm exec tsx scripts/audit-permission-holders.mjs
//         [--org <casdoor_org>] [--code tenant:admin] [--code forms:global-manage] ...
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    code: { type: 'string', multiple: true },
  },
})

const DEFAULT_CODES = ['tenant:admin', 'forms:global-manage', 'data:cost', 'data:precise']
const codes = values.code?.length ? values.code : DEFAULT_CODES

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('需要 DATABASE_URL')
if (!process.env.CASDOOR_URL) throw new Error('需要 CASDOOR_URL')
if (!process.env.CASDOOR_ADMIN_USER || !process.env.CASDOOR_ADMIN_PWD) {
  throw new Error('需要 CASDOOR_ADMIN_USER / CASDOOR_ADMIN_PWD')
}

const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
const { Pool } = requireFromServer('pg')
const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')

const pool = new Pool({ connectionString: databaseUrl })
try {
  const { rows } = values.org
    ? { rows: [{ casdoor_org: values.org }] }
    : await pool.query('select distinct casdoor_org from platform.tenant order by casdoor_org')

  if (rows.length === 0) console.log('(platform.tenant 无租户)')
  for (const { casdoor_org: org } of rows) {
    const c = new CasdoorClient({
      origin: process.env.CASDOOR_URL,
      clientId: process.env.CASDOOR_CLIENT_ID ?? '',
      clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
      org,
      adminUser: process.env.CASDOOR_ADMIN_USER,
      adminPwd: process.env.CASDOOR_ADMIN_PWD,
    })
    const perms = await c.getPermissions()
    console.log(`\n[${org}]`)
    let printed = false
    for (const code of codes) {
      const users = perms.find((p) => p.resources?.includes(code))?.users ?? []
      if (users.length === 0) continue
      printed = true
      console.log(`  ${code}: ${users.join(', ')}`)
    }
    if (!printed) console.log('  (无匹配持有者)')
  }
} finally {
  await pool.end()
}
