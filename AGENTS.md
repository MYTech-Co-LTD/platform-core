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
| 接采集任务 / 改采集链路 / 改调度 / 源退役（**流程执法**） | `.claude/skills/collect-source`（A→I 逐段判停门 + 开工三查；判据数值与台账的唯一事实源仍是下行正典） |
| 接采集任务 / 改采集链路 / 改调度（判据与台账） | `docs/data-platform-handbook.md`（**采集正典**：决策 / 生命周期 SOP / 四层验收 / 运维速查 / 逐源决策登记 + 数据源台账） |
| **改数据新鲜度 / 物化频率 / 10m-1h 双车道**（这条线任何东西） | **先读路线图**（唯一导航面 + 进度台账）：`docs/superpowers/plans/2026-11-24-data-freshness-lanes-roadmap.md`；开工前看 §4 台账，别重做已完成项 |
| 做 / 改任何**涉及权限接入**的功能（新模块权限码 / 路由 scope / console 页权限 / 数据按部门门）——**流程执法** | `.claude/skills/platform-permission`（选路①声明式权限→四段判停；②部门门 fail-closed；③列级=先推动 #764 不自造） |
| 做 / 改**任何数据面工件**（采集管线、判定、对账、管线节点）——**先问引擎** | `.claude/skills/duckle-native-first`（判停门：`list_components`/`get_component_schema` 查目录 → 横向试同类 → 落三档 → 登记缺口；三档判据与 E3 证成方法学在正典 §1.1 / §1.1.1；不变量见 `docs/architecture.md` §4.2「duckle 原生优先」） |
| 配告警 / 接探活 / 新增发布面 / 涉 OO 告警规则或 openship 通知（**监控执法**） | `.claude/skills/data-monitor`（三层职责判停 + 四条红线；分工定案与执行状态在正典 §1.5.3，追踪 issue #538） |
| **通知底座 / agent 自助 / 定时通知**（改这一版块任何东西） | **先读路线图**（唯一导航面 + 进度台账）：`docs/superpowers/plans/2026-11-14-notification-platform-roadmap.md`；正典 `docs/architecture.md` §2.6；调度器 `docs/superpowers/specs/2026-11-14-business-scheduler-design.md` + `docs/superpowers/plans/2026-11-14-scheduler-p1.md` |
| 改通知 / 新增通知事件 / 接投递通道 / 通知规则或模板 | `docs/architecture.md` §2.6 + `docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md`（实施计划 `docs/superpowers/plans/2026-10-27-notification-infrastructure-p1.md`） |
| 接/改**出站渠道**（企微直连、凭据、判据、可达性、飞书/钉钉预留） | `docs/superpowers/specs/2026-10-31-multi-channel-im-provider-design.md`（transport 开关、`channel_credential` 密文、`sql:{at,error}` 判据）+ `2026-10-31-recipient-identity-mapping-design.md`（地址解析三级顺序）；观测面计划 `2026-10-31-recipient-reachability-observability.md` |
| **调问答效果** / 问数 bot 表现不确定（反复尝试、用 exec/curl 翻插件源码或猜参数、同一调用原样重试、答错时间窗、拿不到数） | `.claude/skills/askdata-tuning`（测→定位→改→验的判据表 + 四个杠杆；实现与实测在 `scripts/askdata/` 与 `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`） |
| **源数据自动推导指标 / 私有测度 / 指标可信度与淘汰**（改这一版块任何东西） | **先读路线图**（唯一导航面 + 进度台账）：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`；为什么/边界见 `specs/2026-11-04-auto-metric-derivation-design.md`。**开工前先看台账确认这波到哪了，别重做** |
| **Helix 借鉴线**（答案级证据链 / 契约版本门 / 快照钉住 / 凭据代理 / 自愈审计） | `docs/superpowers/plans/2026-11-11-helix-borrow-roadmap.md`（**唯一导航面 + 进度台账**；开工前先看台账，别重做已完成项） |
| **任何视觉/UI 改动** | **根目录 `DESIGN.md`（设计正典：颜色/字体/圆角/间距/表格规格）** |
| 改控制台 UI / 新增页面 / 调菜单归属 | `docs/design/console-ui-conventions.md`（菜单归属三分法、页面骨架、列表/空态/措辞规范、提交前检查单） |
| **报表生成 / 组合语义 / 呈现层**（报表 spec、窗口与对比、模板与验收、组件与富文本） | **先读路线图**（唯一导航面 + 台账）：`docs/superpowers/plans/2026-11-13-report-platform-roadmap.md`（R0–R6、N1–N5、L0–L5 自由度阶梯）。指标定义不在这条线，见上一行 |
| 设计稿与实施计划 | `docs/superpowers/specs/`、`docs/superpowers/plans/`（按日期命名；SaaS 管理域 spec 是现行主线的正典）——**动手前先 `ls` 这两个目录、按文件名挑 2–3 份读完**（文件名语义可靠：盲测 8/8 命中正确文档；但**清单只用来定位，拿到候选必须打开读**，阴性对照 2/4 误配）。**别指望关键词检索**：`orca search` 整句自然语言 0 命中，须用 2–3 个空格分隔的关键词 |
| 部署 / 接入 / 回滚 | `deploy/openship-adopt.md`（含自动部署与控制面 API 前缀坑）、`deploy/branch-protection-runbook.md`；**换机 / 换域名**另查 `deploy/external-contracts.md`（外部契约逐项验收） |
| **想给某个服务单独部署 / 问「能不能拆成独立单元」** | `deploy/deployment-units.md`（单元边界 + 两道实测硬墙 + 定向部署的语义与失效模式，别再试探一遍） |
| Metabase 退役（证据/归档/阶段/回滚） | `docs/metabase-retirement.md` |
| 冒烟验收 | `docs/m0-smoke-checklist.md` |
| 提交纪律 / 常用命令 | `README.md`（§提交纪律 / §常用命令）——**别在别处复制** |

## 与来财（Orca bot）协作

**项目终端里的 `@来财` 只是普通文本，不会到达来财**——来财是另一个 Orca bot 进程。要让请求真的转过去，必须显式转发：

```sh
# 1) 把完整请求写进临时文件（如 /tmp/req-to-来财.md）
# 2) 转发；多行内容一律走 --body-file，不要塞进 --body
orca orchestration send --to bot:来财 --type question \
  --subject "<一句话标题>" --body-file <请求文件>
```

- **只在两种情况下转发**：主人消息里出现 `@来财`，或主人明确要求「把这件事转给来财」。日常对话不要主动外发。
- 请求文件要写全四项：**背景、目标、约束、期望产出**——缺项会让来财再问一轮。
- 来财收到后会落成 item 跟踪；结果回到本会话，不需要另做轮询。

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
12. **通知事件先声明再发**：模块必须在 manifest `notifications.events` 声明事件；`ctx.notify.emit`
    的返回**不参与业务分支**（fail-open）；通道密钥只在 env（DB 只存键名）；模板预览与投递共用
    同一渲染函数；所有写操作落 `notify.audit`。正典见 `docs/architecture.md` §2.6 与
    `docs/module-protocol.md`「通知事件声明」。

## 调度归属：业务 job 一律建在平台（#2728）

**判据（先问再建）**：这个 job 跑的是**业务动作**（采集/对账/汇总/巡检数据面），还是**基建动作**（服务器级运维、必须碰宿主 docker/网络）？

| 答案 | 建在哪 | 怎么建 |
|---|---|---|
| 业务 | **平台调度器**（`platform.job_schedule`） | 写 `scripts/**/*.mjs` → 在 `apps/server/src/scheduler/registry.ts` 登记 key（`data.*` 前缀才允许 `scope: 'data'`）→ seed 后 `enabled=false`，按 §13 四步开闸 |
| 基建 | openship job | 走 openship MCP 建，并在 `deploy/jobs.md` 登记 |

**不要因为「worker 里没有凭据」就退回 openship**——2026-11-23 我正是这么判断错的：实际 worker 容器里 `DUCKLE_TOKEN`（与两个 console 同一份）、`LEMENG_TOKEN` / `LEMENG_TOKEN_64188`、湖凭据、`DATA_WAREHOUSE_URL` **全都在**，而 compose 里只声明了 10 个 env。
**判据要以容器实测为准**（`env | cut -d= -f1`），不要读 compose 声明。

**机检兜底**：`scripts/check-job-scripts-portable.mjs`（已进 CI gates）——registry 里任何脚本的**代码行**出现 `/opt/...` 或 `docker exec|ps|inspect|cp` 即红，因为那种脚本注定无法在 worker 容器里跑，「只能放 openship」的借口就此堵死。确属基建的，在脚本的 `HOST_ONLY_ALLOW` 里登记 key + 理由（一次显式决定，不是默认）。

## 命令 / 门禁 / 部署（指针）

- 通知运维 job（`notify-health` / `notify-retention`）口径见 `deploy/notify-jobs.md`。
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
