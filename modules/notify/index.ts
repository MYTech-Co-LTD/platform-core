// index.ts — notify 模块入口（issue #889；正典 docs/architecture.md §2.6）。
//
// 接入姿势照 modules/forms：manifest.yaml 单一事实源——启动时读同目录 yaml 经 ManifestSchema
// 校验后交给 defineModule，不在 TS 里维护第二份副本（防漂移）。路由只写业务：身份由宿主注入
// c.get('identity')，权限门禁由宿主按 manifest.api.internal 声明施加（模块零认证代码），
// DB 连接从 createRouter 的 ctx.pool 拿——模块零连接代码。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import { novuFromEnv } from './domain/novu'
import { createNotifyRouter } from './routes'

// ⚠️ manifest 路径用 node:path 取（不 new URL(rel, import.meta.url)）：happy-dom 环境下
// 全局 URL 被换成分辨不出 file: 方案的实现，组件测试会整文件炸（#718 实测）。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manifest.yaml'), 'utf8')),
)

// §2.6 方案 A：凭据**按 org** 在每次 emit 时解析（`NOVU_API_KEY__<ORG>` → 全局回落）。
// 缺 env / 该 org 未开通 ⇒ null ⇒ 逐条回执记 failed，但**不阻塞业务**（fail-open）。
const novu = (org: string) => novuFromEnv(process.env, org)

export default defineModule({
  manifest,
  createRouter: ({ pool }) => createNotifyRouter({ pool, novu }),
})
