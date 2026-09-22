# AGENTS.md — platform-core 的 agent 指令（项目专属事实的唯一来源）

> 通用约束（架构先行 / 迁移纪律 / 部署后验 / 提交纪律 / 安全基线…）在团队规则
> （`~/.claude/rules/common/`，正典 `team-harness/docs/standards/`），**本文不复制正文，只写本项目特有的事实与硬约束**。
> 公司基建速查（服务器/控制面/认证）见各 agent 的全局 CLAUDE.md，此处不重复。

## 项目是什么

多租户 SaaS 管理后台底座：Hono 宿主（apps/server）+ Vite/React console（apps/web）+
可插拔业务模块（`modules/*`，manifest 协议接入）+ 订阅真身在 Casdoor（平台超管在
Casdoor 后台运营，租户管理员在 console 自建页管理——spec D4 双层）。

## 文档地图（动手前先读对应的）

| 要做什么 | 先读 |
|---|---|
| 改架构 / 模块协议 / 任何结构性改动 | `docs/architecture.md`（架构不变量）+ `docs/module-protocol.md`（模块接入契约） |
| 新接一个业务模块 | `docs/module-onboarding.md`（接入步骤/全字段参考/验收清单/故障速查）；协议语义正典仍是 `docs/module-protocol.md` |
| 设计稿与实施计划 | `docs/superpowers/specs/`、`docs/superpowers/plans/`（按日期命名；SaaS 管理域 spec 是现行主线的正典） |
| 部署 / 接入 / 回滚 | `deploy/openship-adopt.md`（含自动部署与控制面 API 前缀坑）、`deploy/branch-protection-runbook.md` |
| 冒烟验收 | `docs/m0-smoke-checklist.md` |
| 提交纪律 / 常用命令 | `README.md`（§提交纪律 / §常用命令）——**别在别处复制** |

## 项目专属硬约束（回退任何一条前先回对应的 spec/issue）

1. **声明即授权（fail-closed）**：模块 API 的门卫由宿主按 manifest `api.internal` 施加；
   未声明的路径/方法一律 403，模块代码里的 `requireScope` 只是辅助。漏写声明 ≠ 放行。
2. **装载期双向核对**：注册的路由集合必须与声明集合完全一致，任一方向的差集都让
   **装载失败**（起不来，不是告警）。改路由不改 manifest（或反之）= 部署即挂。
3. **门卫比对基准是宿主绝对 `routePath`**：`declaredScopeGate` 收到的声明路径必须是
   挂载后的绝对路径（宿主带 `/api/modules/<id>` 前缀传入）。相对/绝对混用 ⇒ 恒 403。
4. **HEAD 按 GET 派发归一**（issue #7，勿回退）：声明 GET 的端点在 HEAD 请求下必须放行
   （Hono 派发 HEAD→GET 但 `c.req.method` 仍是 HEAD）；不归一 = 已声明端点恒 403。
5. **`enabledFor` 两消费方必须同源**（config 清单闸门 + API 启用闸门共用同一实现）；
   语义：`tenant_module` 无行 = 启用。订阅源已切 Casdoor（灰度开关
   `PLATFORM_SUBSCRIPTION_SOURCE=casdoor`），`tenant_module` 表保留为回滚兜底，**拆表是待议决定**。
6. **权限码按租户 org 扇出**：Casdoor 权限记录按 org 分桶；写侧（装载器供给，含平台内置码
   `tenant:admin`）与读侧（session scopes）必须遍历 `platform.tenant` 各 org，不能只管单 org。
7. **free 私仓无服务端分支保护**（org plan=free 没有 rulesets）：直推 main 会被 CI 拒发版 +
   main-guard 事后绊线点名——**别依赖服务端拦截，也别关掉这两道**。
8. **compose 全仓只两份**（约束 B7，白名单：`deploy/docker-compose.yml` 部署单元 A +
   `deploy/data-compose.yml` 部署单元 B/数据面，P1 起放行；第三份即违规）+ **两份**的 ports 必须
   回环 `127.0.0.1:`（`scripts/check-compose.mjs` 守卫）；`.env.example` 键齐全门禁（B9，
   `scripts/check-env-example.mjs`）：代码引用的 env 键必须在模板里声明。
9. **Casdoor 三铁律**（真机实测，详见 SaaS 管理域 spec §1.2/§4.1）：时间一律 RFC3339 UTC；
   delete 类端点一律 JSON body `{owner,name}`（query 形式静默无效）；update 类端点一律带
   `?id=<org>/<name>`（缺 id 静默 no-op，issue #50）；每次写后回读验**目标状态**。
10. **桶文件（barrel）export 纪律**（#44 生产事故）：`export` 值清单里**绝不混入 interface/type**——
    Node ESM 运行时 SyntaxError，typecheck/单测都拦不住；护栏测试在 CI 兜底（运行时加载桶文件）。
11. **测试替身必须收严到真机形状**（#50/#51 教训）：mock 接受比真机宽松的形状 = 缺陷结构性
    不可见；mock-casdoor 的端点形状以真机实测为准，别按想象放宽。

## 命令 / 门禁 / 部署（指针）

- 测试/类型/构建/守卫命令见 `README.md §常用命令`；CI = `.github/workflows/ci.yml`
  （unit/gates/web/smoke + discipline + main-guard）。
- **部署已全自动**：merge main = 门禁全绿自动部署（adopt runbook §7）。控制面 API 直调
  必须带 `/api/proxy` 前缀。运维操作一律走 openship MCP。
- 本地跑 server 测试需要 `DATABASE_URL`（本地 compose pg）。

## 债账与遗留（改动前看一眼）

- open issues（#126 manifest 预留字段清理待议、#150 数据栈 P0–P3 落地、#151 aftersales M2b
  数据迁移+孤儿附件 GC、#152 m3c BYO 试点、#153 M1c multi 验收——以 `gh issue list` 实测为准）；
  spec「已知边界」节；M1c CLI 端到端验收：single 笔已随山海试点销账
  （`deploy/delivery-private.md` §4），multi 笔未做 → issue #153。
- 长期记忆（agent 侧）：openship env 四层物化、合并只等 CI CLEAN、绝不手工补长 SHA 等——
  按各自 agent 的记忆机制加载，不在本仓维护。
