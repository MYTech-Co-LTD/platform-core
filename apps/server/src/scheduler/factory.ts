// factory.ts — 宿主调度器端口工厂（W6-P3）。**唯一装配点**：app.ts 与测试共用这一份。
//
// 为什么是「工厂」而不是装载期绑定的端口（审阅 I1 订正）：`ModuleContext` 在装载期只构造
// 一次（loader.ts 阶段 3），没有请求期会话。固定 actor 会让**所有租户的 agent 排班落进
// 同一个 owner_org/namespace**，`SchedulerPort` 的「归属只来自身份」在最外层被抹平。
// 故宿主交出去的是 `(actor) => SchedulerPort`：调用方（notify 工具面 / Task 3）用**请求
// 身份**造端口。端口是薄对象（闭包 + pool 引用），每次调用新建的成本可忽略。
//
// namespace 口径：**v1 一个 org 一个 namespace**（`actor.namespace || actor.org`）。
// 先查过 `channel-address.ts` 与 `modules/notify`，没有既有的 `owner_namespace` 约定。
//
// 抽成可导出纯函数的理由：app.ts 里的内联 lambda 在测试中不可达 ⇒ 「改回固定 actor 仍
// 全绿」的结构性盲区（审阅 I1）。测试直接调本函数，变异（忽略入参恒用固定 actor）必红。
import type { SchedulerPortFactory } from '@platform/sdk'
import type { Pool } from 'pg'
import { buildSchedulerPort } from './port'

export function makeSchedulerFactory(pool: Pool): SchedulerPortFactory {
  return (actor) => buildSchedulerPort({
    pool,
    actor: {
      userId: actor.userId,
      org: actor.org,
      namespace: actor.namespace || actor.org,
    },
  })
}
