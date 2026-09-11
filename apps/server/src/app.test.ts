// app.test.ts — 宿主装配（Task 16）的启动期 fail-fast 传播。
//
// 只锁一件事，但它是 runbook「已知陷阱 2」与 spec §3.4 的机检面：**某个租户 org 的
// upsertPermission 抛错 ⇒ 原样上抛 ⇒ 宿主起不来**（"启动期连不上 Casdoor 就起不来"）。
// 这条契约全仓只有这里直接断言：loader.test.ts 的用例只覆盖 happy path / 零租户 / 无工厂
// 三个分支，没有一条断言 upsert 失败会上抛；smoke 只跑可达 mock 的绿路径。
//
// 历史（避免后来者误删）：本文件曾另有一条「未配 admin 凭据 ⇒ 只 warn 跳过、服务照常启动」
// 的用例，锁的是当时的"凭据闸门"。R2 把凭据改为 config 必填后该行为**已被否决**（缺凭据时
// 无人能登录，见 spec §3.5 的更正），那条用例与它依赖的 db.closePools 一并删除。
// 留下这条与凭据有无无关、至今成立的契约——**别再连它一起删掉**。
//
// 真 PG（同 migrate/tenant/loader.test.ts 约定）：未提供 DATABASE_URL 时整体跳过。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL

function configWith(casdoorUrl: string, adminPwd: string): AppConfig {
  return {
    port: 13000,
    databaseUrl: dbUrl!,
    tenantMode: 'single',
    platformOrg: 'acme',
    sessionSecret: 'test-secret-test-secret-test-secret!',
    casdoor: {
      url: casdoorUrl,
      clientId: 'test-client',
      clientSecret: '',
      application: 'app-built-in',
      adminUser: 'admin',
      adminPwd,
    },
    publicOrigin: 'http://127.0.0.1:13000',
    // 必需：platform.tenant 为空时供给循环不执行、压根不取 client，这条契约就变成空转
    // ——那正是 issue #3 第二节"结构性失明"的形状
    seedDemo: true,
  }
}

describe.skipIf(!dbUrl)('buildApp：启动期 fail-fast 传播', () => {
  const mock = new MockCasdoor()

  beforeAll(async () => { await mock.start() })
  afterAll(async () => {
    await mock.stop()
    // buildApp 用的是 db.ts 里按 databaseUrl 缓存的模块级单例池；getPool 返回同一实例，
    // 在此关掉它，否则 vitest 会因未释放的连接报 open handle
    await getPool({ databaseUrl: dbUrl! }).end().catch(() => {})
  })

  it('★ 权限码供给抛错 → 原样上抛 → buildApp 拒绝（宿主起不来）', async () => {
    // admin 口令故意配错：管理会话登不上 ⇒ upsertPermission 抛 ⇒ 该错误必须一路传出 buildApp
    // （运维契约：Casdoor 不可用时容器就反复重启，见 deploy/openship-adopt.md 陷阱 2）
    //
    // 断言锁在具体错误来源上，不用裸 rejects.toThrow()：裸写法下任何原因抛错都算过，
    // 那样"seed 顺序错了 / 模块没找到"之类的无关失败会被误读成本条契约成立
    await expect(
      buildApp({ config: configWith(mock.origin, 'wrong-password') }),
    ).rejects.toThrow(/casdoor admin login failed/)
  })
})
