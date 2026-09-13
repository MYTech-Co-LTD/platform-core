# case-engine AI 通路底座：设计

> 本文是「platform-core 对接 case-engine 的 AI 前端通路」的**设计稿**（spec）。
> **状态：设计已定稿记录，未排期开发**（2026-09-13 用户明确「先做记录，还不打算开发」）。
> 后续开发以此稿为起点，开工前先核对 case-engine P0 进展是否已让 §6 的「待定项」落地。
>
> 触发链：调研「最新版 Ant Design Pro 是否原生 AI 支持」→ 引出「本项目能否/是否值得采用」→
> 拍板「方向 A」（不迁 Pro/Umi，见 §2 D1）→ 确认驱动力为**对接 case-engine** → 确认第一期形态为
> **技术通路底座先行** → 确认落点为**方案 1 薄模块**。

## 1. 现状核实（全部一手来源，2026-09-13 实测）

### 1.1 Ant Design Pro v6 / @ant-design/x（外部事实）

- Ant Design Pro **v6.0.0**（2026-04-29 tag，[官方发布 issue #11734](https://github.com/ant-design/ant-design-pro/issues/11734)）内置基于
  Ant Design X 的 AI 助手页；但 Pro 本质是 **git clone 起项目的脚手架**（v6 已弃 pro-cli），不是可安装依赖。
  npm 的 `ant-design-pro@2.3.2` 是 2019 年停更的旧组件库遗留包，勿混淆。
- AI 能力的真正载体是独立组件库 **`@ant-design/x`**（v2.9.0），peer 依赖 `antd ^6.1.1` / `react >=18`，
  与构建工具无关（不绑 Umi）。配套 `@ant-design/x-markdown`（markdown 渲染）、`@ant-design/x-sdk`（useXChat 等会话状态）。
- Pro v6 的 `src/pages/chatbot`（MIT）可作聊天页参考实现：XProvider + Bubble（`<think>` 解析）+ Sender + XMarkdown + useXChat。

### 1.2 platform-core（本仓事实）

- `apps/web` 已是「Pro v6 同代」UI 层：React 19.3 + antd **6.6.3**（锁文件实测）+ pro-components 3，
  底座为 Vite 6 + react-router（非 Umi）。满足 `@ant-design/x` peer。
- 模块协议装载机制（`apps/server/src/loader.ts`）：自动扫描 `modules/*/manifest.yaml` → 校验 →
  权限码按租户 org 各建一套 → 动态 import `index.ts` → createRouter。**丢目录即被发现，宿主零改动**。
- 模块 console 页由 `scripts/gen-console-registry.mjs` 在构建期聚合进 `apps/web`（Vite 直接编译模块源码），
  模块前端依赖写模块自己的 `package.json`（`modules/demo` 范式：antd/react 在 demo 侧声明）。
- 模块页纪律（`modules/demo/console/index.tsx` 头注释）：HTTP 只走 `platformFetch`、权限只读 Outlet 注入的
  `session.scopes`、零反向依赖 apps/web。
- `platformFetch`（`packages/platform-sdk/web/platform-fetch.ts`）返回**原始 Response 不消费 body**——
  SSE 流式可直接读 `res.body`，通路成立。
- 模块后端纪律（`modules/demo/index.ts`）：manifest 单一事实源、路由只写业务、身份由宿主注入
  `c.get('identity')`、门禁由宿主按 `manifest.api.internal` 施加（模块零认证代码）、DB 从 `createRouter` 的
  `ctx.pool` 拿（模块零连接代码）。

### 1.3 case-engine（对端事实）

- P0 落地层 `core/engine`（Mastra app+worker）**仍是占位**；决策门（`core/decision-gate`）已可用。
- 设计文档 `docs/design/architecture.md` 已定案的前端形态（§18）：列表/trace=固定 UI；详情=AI 生成
  display_schema 确定性渲染；**对话式入口/复盘摘要=生成式增强层**。LLM 接入=OpenAI 兼容 API
  （DeepSeek/Qwen/GLM），身份=Casdoor（与平台同源）。
- case-engine 定位「模块 = deploy unit，客户按 customer.json 订阅」——**多客户规模化后的终局形态是其自带前端**，
  本仓第一期不做（见 D4）。

## 2. 决策

- **D1 前端底座保持 Vite + react-router，不迁 Ant Design Pro v6 / Umi Max（「方向 A」）。**
  否决「全量切换」：Pro 是一次性模板而非长期依赖（v5→v6 隔近五年），切换的真正长期绑定是 Umi Max；
  本仓核心资产是模块协议（defineModule/manifest/registry 聚合），与 Umi 约定（config/routes、
  initialState/access）叠床架屋；UI 库层已同代。Pro v6 的增量零件（@ant-design/x、React Query、Biome、
  Tailwind）全部可单拆吸收，绑 Umi 的项（utoopack、Umi 插件）不进本仓。未来公司**独立**新产品可用 Pro 当
  起项目模板。
- **D2 驱动力 = 对接 case-engine**（公司 AI Agentic 编排引擎，P0 pilot 进行中），不是泛泛的平台 AI 功能。
- **D3 第一期 = 技术通路底座先行**（组件 + SSE 通路 + mock 上游验证可行性）。
  否决「业务页面先行」：case-engine P0 垂直切片未跑通（engine 占位），先做决策门队列/case 工作台会被
  对端契约漂移反复打回。
- **D4 落点 = `modules/case-engine` 薄模块（方案 1）。**
  否决「apps/web 平台级」：AI 助手绑定 case-engine（按客户订阅的 deploy unit），长在平台核心里会造成
  平台功能依赖外部系统部署形态，且后续业务页面会被迫堆进 apps/web，模块聚合机制形同虚设。
  否决「case-engine 仓自带前端」：P0 阶段太重（跨仓前端分发/iframe/SSO 联调），与「先打通路」不匹配；
  但标注为**多客户规模化后的终局候选**，届时迁移方向是本模块整体外移。
- **D5 通路核心价值 = 前端协议稳定层。** 模块代理吐统一 SSE 事件协议，上游三态（mock / openai-compat /
  case-engine）由 env 切换，换上游前端零改动。
- **D6 YAGNI 砍单**：多会话列表（Conversations）、会话历史持久化、DB 表、display_schema 渲染、
  决策门/case 业务页面，全部不做。

## 3. 目标 / 非目标

**目标**：console 聊天页 → 平台模块代理 → 上游的 AI 流式通路全通；切上游只改 env；租户级开关 = 权限码。

**非目标**：任何业务功能（case 查看/决策门操作/复盘摘要）；真实 case-engine 端点接入（只留接口）；
生产部署调优（SSE 过 edge 见 §6）。

## 4. 设计正文

### 4.1 落点与装载

新目录 `modules/case-engine`，manifest 单一事实源（照 demo 范式，migrations 可选性实现时确认——
无 DB，若 schema 强制要求则给空迁移目录）：

```yaml
id: case-engine
name: AI 助手（case-engine 通路）
version: 0.1.0
platform: '>=0.1'
permissions:
  - { code: case-engine:chat, name: AI 助手对话 }
api:
  internal:
    - { method: POST, path: /chat/stream, scope: case-engine:chat }
frontend:
  console:
    - { path: /console/case-engine, title: AI 助手, icon: RobotOutlined, scope: case-engine:chat, entry: ./console/index.tsx }
```

租户级开关 = 按租户发不发 `case-engine:chat`（权限码由 loader 自动按 platform.tenant 各 org 供给）。

### 4.2 前端页（`console/index.tsx`）

- 模块 `package.json` 新增：`@ant-design/x@^2.9` + `@ant-design/x-markdown` + `@ant-design/x-sdk`；
  antd 声明抬 `^6.1.1`（workspace 锁 6.6.3 满足 peer；apps/web 声明不动）。
- 结构参考 Pro v6 chatbot：`XProvider` + `Bubble`（含 `<think>` 解析，验证 Think 展示）+ `Sender`
  （发送/停止）+ `XMarkdown` + `useXChat` 管理消息。单会话，只带最近 10 轮上下文。
- 权限读 `useOutletContext` 注入的 `session.scopes`（demo 同款，零反向依赖）。
- 流式消费：`platformFetch` POST → 手读 `res.body` 解析 SSE 帧。

### 4.3 SSE 代理与三态上游

统一事件协议（**前端唯一契约，稳定层**）：
`data: {"type":"delta","text":"…"}` / `{"type":"done"}` / `{"type":"error","code":"…"}`。

模块后端 handler（hono `streamSSE`），env 切上游：

| `CHAT_UPSTREAM_MODE` | 行为 | 用途 |
|---|---|---|
| `mock`（默认，仅 dev/CI） | 本地定时吐预设分片（含 markdown + `<think>` 段） | 零依赖跑通 + CI 可测 |
| `openai-compat` | 转发 OpenAI 兼容 `/chat/completions`（stream:true），SSE 转译为统一协议 | 配 DeepSeek/Qwen/GLM key 验证真实流式 |
| `case-engine` | stub，返回明确 `error` 事件 | Mastra 端点 P0 定稿后接入 |

env：`CHAT_UPSTREAM_URL / CHAT_UPSTREAM_API_KEY / CHAT_UPSTREAM_MODEL`，走 OpenShip env(isSecret)，不进 git。

### 4.4 错误处理

- 401 → `platformFetch` 既有跳登录；无 scope → 宿主门卫 403（既有）。
- 上游 30s 无首字节 abort → `error` 事件 → 前端错误 Bubble + 可重发。
- 用户停止 → AbortController → 代理感知断连同步 abort 上游。
- 输入有界（demo 同款纪律）：单条 ≤4000 字、上下文 ≤10 轮，超限 400。

## 5. 测试与验收

- 后端 vitest：mock 往返（帧格式/顺序/终止）；node 假 upstream server 测 openai-compat 转译；超限 400。
- 前端 vitest + testing-library：渲染 / 发送后流式追加 / 错误态 / `<think>` 解析。
- 既有门禁自动带上：check-manifests、console-registry 重生成及测试、全量 lint/typecheck/test。

**验收**：① 有权限账号 console 见「AI 助手」→ mock 模式流式打字机跑通；② 配任一 OpenAI 兼容 key
真实流式跑通；③ 切上游只改 env、前端与协议零改动；④ 仓 CI 全绿。

## 6. 已知边界与风险（开工前逐条核对）

1. **SSE 过 openship edge 可能被代理 buffering 卡流**——P0 本地 compose 无此问题；上生产需
   `proxyBuffering: false`（openship routingConfig 支持）。**待沉淀**（无实操案例）。
2. **case-engine 真端点契约未定**（engine 占位）——第三态只留接口不实现；开工前核对 P0 是否定稿。
3. **生产防呆**：`CHAT_UPSTREAM_MODE` 默认 mock 仅限 dev/CI，生产部署检查项必须显式设模式，防 mock 假充真。
4. `ManifestSchema` 是否强制 `migrations` 待实现时确认（本模块无 DB）。
5. 架构文档 `docs/architecture.md` 组件表届时加一行 `modules/case-engine`（文档同步，非架构变更）。

## 7. 关联

- 决策「方向 A」同步记入会话记忆（`frontend-stack-no-antdpro-migration`）。
- case-engine 侧设计：`case-engine 仓 docs/design/architecture.md` §8（垂直切片）/ §17.1（LLM）/ §18（前端形态定案）。
- 外部一手来源：[Pro v6.0.0 发布 issue #11734](https://github.com/ant-design/ant-design-pro/issues/11734) ·
  [Ant Design X](https://x.ant.design) · Pro v6 `src/pages/chatbot` 源码（MIT）。
