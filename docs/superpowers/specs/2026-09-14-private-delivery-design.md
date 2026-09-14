# platform-core 私有化多实例交付：设计（spec-3）

> 本文是「5+ 家私有化客户怎么交付」的**规划稿**（spec-3）。
> **状态：设计定稿（2026-09-14 brainstorming 四问对齐 + 三节逐节确认），未落实施。**
> 工作铁律：实施中任何方向/范围调整，先改本文再动码。

## 0. 触发链与既定决策

私有化是主要卖法（5+ 家），但交付能力未成文：TENANT_MODE=single 底座在、adopt runbook §6.1
还在教 D6 之前的插表旧口径、provision CLI 欠三债（tenant:admin 不在扇出 / 无 branding 参数 /
无 tenant_domain）、M1c 端到端验收从未走过（AGENTS.md 债账）。

brainstorming 四问的答案（2026-09-14）：

1. **实例位置：混合，客户机为主**——默认每客户自己的服务器（openship 注册客户机，
   走 `cicd-project-onboarding` 阶段 A）；个别小客户/试点住我方机器。
2. **Casdoor：默认共用我方 sso.hookflow.cn**（每客户一个 org），合规等特殊情况独立部署
   Casdoor 实例——`CASDOOR_URL` 等本就是 env，代码零改造，属每客户交付决定。
3. **升级：我方实例自动 + 客户实例手动**——我方 project 维持 CI 自动部署现状；
   客户实例按维护窗口经 openship MCP 逐 project 触发（客户环境变更走窗口是常态）。
4. **验收：有真客户试点**——试点端到端走通即本 spec 的总验收。

方案取舍：**A（选定）**= CLI 补齐 + runbook 成文 + MCP 手工序列；
B = A + 批量部署脚本（引入 PAT 权限扇出的凭据维护面，3 家以上再上，列为后续项）；
C = 最小文档版不还 CLI 债（否决——每家交付都踩「挂码要重启、branding 手工 SQL」）。

## 1. 交付流水线

### 1.1 拓扑

N 个客户 = N 个 openship project：**同一 repo（platform-core）、同 branch main**、不同
`serverId`（客户机或我方机）、不同 env、不同域名。零 fork（spec-1 D4）的物理含义：所有客户
吃同一个 main，差异全部落在 project 级 env + 数据面（租户行/订阅/授权），不在代码面。

### 1.2 开通链路（runbook 骨架，六步）

1. **客户机接入**（仅客户机路径）：走 `cicd-project-onboarding` 阶段 A 既有标准
   （网络打通 → ufw → git smart-proxy → docker → 注册 server），不重造。
2. **openship 建 project**：MCP `post_projects`（repo、branch=main、composePath=
   deploy/docker-compose.yml、rootDirectory=deploy）。⚠️ **serverId 建不出来**——只能在首次
   部署的 `deployments/build/access` 里传（adopt runbook §6.2 实测坑，钉死在序列里）。
3. **env 物化**：`TENANT_MODE=single`、`PLATFORM_ORG=<客户org>`、`CASDOOR_URL`（默认我方；
   特殊情况指向客户独立实例）、**`PLATFORM_SUBSCRIPTION_SOURCE=casdoor`——新交付实例一律
   casdoor 源**，全平台单一订阅口径，不再有插表路径。
4. **CLI 开通租户**：`provision-tenant` single 形态（§2 补齐后的形态）。
5. **域名**：客户域名解析到机器公网 IP + openship edge 签证书（adopt runbook 既有模式）。
6. **冒烟**：部署后验证（容器创建时间 vs 镜像构建时间 / 新行为可观测）+ `m0-smoke-checklist`。

### 1.3 CLI 执行环境（runbook 必写的坑）

生产 pg 端口绑回环（B7）⇒ **本机直连生产库不可行**——CLI 必须在服务器侧执行（容器内或
宿主），且依赖 tsx（TS barrel 裸 node 跑不了）；镜像里没有就从宿主跑（经 openship MCP
exec）。上次迁移动作是「容器内等价客户端调用」绕的，本次把正路成文。

### 1.4 升级与回滚

- **升级**：我方 project = CI 自动（机制不动）；客户 project = 维护窗口经 openship MCP
  `post_deployments`（**必须带 serverId**）逐个触发；批量脚本列为「3 家以上」后续项。
- **回滚**：openship 原生 per-project rollback，每客户独立回滚窗互不牵连——project-per-customer
  拓扑的回报。

## 2. provision-tenant CLI 补齐（三债）

1. **`tenant:admin` 进扇出**：权限扇出清单 = 各模块 manifest permissions **∪
   `PLATFORM_BUILTIN_PERMISSIONS`**（直接 import `loader.ts` 既有导出拼进数组，不重抄第二份
   清单防漂移）。效果：开通完成即可挂管理员码，不依赖宿主下次重启。`tenantProvisionSteps`
   纯核测试同步更新。
2. **branding 参数（最小集）**，写进建行 upsert（与 `seed.ts` 口径对齐）：
   - `--product-name <名>`：登录页/控制台标题，缺省用 slug；
   - `--login-methods password,wecom-qr`：逗号分隔，**CLI 侧白名单校验、坏值拒绝退出**——
     login_methods 坏值前端静默丢弃的坑在入口拦掉；
   - 不做：logo / primary_color / background（需要时 SQL 补，YAGNI）。
3. **`--domain <host>`**：写 `platform.tenant_domain` 行（`on conflict(domain) do nothing`，
   域名被别租户占时明确报错，不静默）。

## 3. runbook 与订正

- **新 `deploy/delivery-private.md`**（私有化交付 runbook）：① 适用与前置（混合策略 +
  每客户三决策点：机器 / Casdoor 归属 / 域名）② 六步开通链路含 **MCP 调用序列**（调一步验
  一步）③ CLI 执行环境（§1.3）④ 升级 SOP（含回滚序列）⑤ 冒烟——指针到 `deploy/README`
  与 `m0-smoke-checklist`，不复制正文。
- **`openship-adopt.md` §6.1 订正**：删 `tenant_module` 插表 SQL → 「跑 provision CLI 建订阅」；
  `PLATFORM_SUBSCRIPTION_SOURCE` 口径钉死（新交付一律 casdoor，platform 源仅我方实例临时
  回滚兜底）；login_methods 白名单坑保留提示（CLI 已拦，手工路径仍在）。
- **SaaS 管理域 spec §6.4 回改**：删「或届时建租户管理页」旧话——M3 页已上线，私有化客户
  管理员 = `tenant:admin` + console 自管页；独立 Casdoor 一句边界。

## 4. 落地物与验收

| # | 物 | 性质 |
|---|---|---|
| 1 | 本 spec | 文档 |
| 2 | `deploy/delivery-private.md`（新） | 文档 |
| 3 | `openship-adopt.md` §6.1 订正 | 文档 |
| 4 | SaaS 管理域 spec §6.4 回改（修订记录） | 文档 |
| 5 | `provision-tenant.mjs` 三债 + 纯核测试 | 代码 |
| 6 | AGENTS.md 债账行——**保留**，标注「待试点销账」 | 文档 |

**验收**：

1. 试点客户（single、客户机）六步全流程走通 + 部署后验证（容器时间戳 / 新行为可观测）；
2. multi 测试租户在我方实例端到端（登录→菜单→模块页），销 M1c 债；
3. CLI 幂等重跑无差异（含新参数）；
4. 文档引用即路径，无漂移。

## 5. 已知边界

1. **试点未完成前 M1c 债账不销**——真案例才立标准。
2. 批量部署脚本、独立 Casdoor 交付细则、计费对接——不在本期。
3. spec-2（壳层主题/布局系统）立项时机 = 第一个真实壳层需求到达前（spec-1 §6.1 已立此照）。

## 6. 关联

- spec-1（`2026-09-14-customization-tiering-design.md`）：个性化四级口径与零 fork 收录规则
  ——本 spec 是其「自托管车道」的交付落地。
- SaaS 管理域 spec（`2026-09-13-saas-admin-domain-design.md`）：订阅模型（D2 plan 按 org
  扇出）与 M3 租户管理员页是交付链路的机制底座。
- `deploy/openship-adopt.md`：我方实例的部署接入（本 spec 订正其 §6.1）。
- `cicd-project-onboarding` 标准（team-harness）：客户机接入的阶段 A 流程。

## 7. 修订记录

- 2026-09-14：初版。brainstorming 四问定方向（§0），三节设计（流水线 / CLI 三债 /
  runbook 与订正）逐节确认后落盘。
