// index.ts — forms 模块骨架（架构正典 §2.4「采集底座：受管数据集（表单+字典）」，issue #708）。
//
// 接入姿势照 modules/demo：manifest.yaml 单一事实源——启动时读同目录 yaml 经
// ManifestSchema 校验后交给 defineModule，不在 TS 里维护第二份副本（防漂移）。
// 本 PR 只落骨架：**零权限码、零路由**（api.internal 不声明 = 不可达，声明↔注册双向核对
// 平凡通过）。M1.2 表单/字典业务端点落地时：路由与 api.internal 声明**同步加**（任一方向
// 差集 = 装载失败，进程起不来）；身份由宿主注入 c.get('identity')，门禁由宿主按声明施加，
// DB 连接从 createRouter 的 ctx.pool 拿——模块零认证、零连接代码。
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'

const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  // 骨架期空路由：无声明 ⇒ 该模块 API 子树全 403（fail-closed），无匿名面
  createRouter: () => new Hono(),
})
