// index.ts — forms 模块入口（issue #708 骨架 → #710 内核）。
//
// 接入姿势照 modules/demo：manifest.yaml 单一事实源——启动时读同目录 yaml 经
// ManifestSchema 校验后交给 defineModule，不在 TS 里维护第二份副本（防漂移）。
// 路由只写业务：身份由宿主注入 c.get('identity')，权限门禁由宿主按 manifest.api.internal
// 声明施加（模块零认证代码），DB 连接从 createRouter 的 ctx.pool 拿——模块零连接代码。
// 声明↔注册双向核对：路由与 api.internal 任一方向差集 = 装载失败（进程起不来）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import { makeEnvEngineResolver } from './domain/engine-client'
import { llmFromEnv, openAiCompatModel } from './domain/llm'
import { createFormsRouter } from './routes'

// ⚠️ manifest 路径用 node:path 取（不 new URL(rel, import.meta.url)）：happy-dom 环境下
// 全局 URL 被换成分辨不出 file: 方案的实现，组件测试会整文件炸（#718 实测）。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manifest.yaml'), 'utf8')),
)

// AI 起草的模型（#724）：`FORMS_LLM_*` 优先、缺省回落 `DATA_LLM_*`；都没配 ⇒ null
// ⇒ /generate 回可解释的 503（不是 500，也不是启动失败）。在模块加载期解析一次。
const chatModel = (() => {
  const cfg = llmFromEnv()
  return cfg === null ? null : openAiCompatModel(cfg)
})()

// 租户 → OA 引擎解析器：装载期构造一次（读 env，不读请求）。
// 未配置任何映射 ⇒ 每次解析返回 null ⇒ 审批提交/代理回 409 OA_NOT_ENABLED（fail-closed，
// 既有的 forms/collection 行为逐字不变——它们根本不走这条通路）。
const engineFor = makeEnvEngineResolver(process.env)

export default defineModule({
  manifest,
  // 组织查询面与通知端口由宿主注入（OA P1）：审批编译必须有 org（查不了 ⇒ 503，不是「没人」）；
  // 回调事件经 notify 投递（未注入 ⇒ 事件静默，宿主装配面另有报告）。
  createRouter: ({ pool, org, notify }) => createFormsRouter({
    pool, chatModel, orgPort: org ?? null, notify: notify ?? null, engineFor,
  }),
})
