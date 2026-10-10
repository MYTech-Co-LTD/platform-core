# shanhai 租户 OpenClaw 企微 bot（问数通道 C 部署面）设计

> 日期：2026-10-10 · 状态：设计稿（已评审定稿，待实施计划）
> 前置正典：`2026-09-21-data-query-channels-design.md` §4（通道 C 身份模型与链路，平台侧 #146 已落地）
> 实测基线：企微插件 `@wecom/wecom-openclaw-plugin` 源码通读（2026.9.15）、OpenClaw 核心流式文档
> （npm 包 2026.9.2 内置 docs/concepts/streaming.md）、npm/ghcr/GitHub releases 三处版本实查（2026-10-10）。

---

## 0 一句话

**为 shanhai 租户新起一个自营 OpenClaw 企微 bot**（智能机器人 WebSocket 长连接接入），
native plugin 把可信企微 userid 送到平台问数 API，走既有授权核心实现「对话识别用户约束权限、
消费数据」；**流式输出显式配置开启**，根治老 bot「全量生成完才吐、一等一分钟+」的体验问题。
**data-analysis 仓及其现网零接触**。

## 1 拓扑决策（已拍板）

| 决策点 | 结论 | 落选项 |
|---|---|---|
| OpenClaw 实例 | **新起自营**，归 platform-core-shanhai 项目（openship 管理），113.249.104.181 | 复用 data-analysis 实例（跨仓耦合、遗留手工 SSH 面）；迁移接管（动现网风险大） |
| 部署单元 | **进单元 A compose**（`deploy/docker-compose.yml` 新增 `openclaw` 服务），B7 白名单不动 | 第三份 compose（改 B7 流程重）；openship 服务启停矩阵控制「仅 shanhai 启用」 |
| 企微接入 | **智能机器人 Bot 模式 WebSocket 长连接**（出站连 `wss://openws.work.weixin.qq.com`，无需公网回调 URL/域名/证书） | 自建应用 XML 回调（data-analysis 老模式，且无法享受流式） |
| data-analysis | **零接触**（不动代码、不动部署面、不装任何东西到那个容器） | — |

## 2 链路

```
企微用户 ──私聊/群聊──▶ 企微「智能机器人」（管理后台 API 模式创建，长连接配置）
                          ▲ 出站 WebSocket 长连接（无公网入站）
                          │
        OpenClaw Gateway（deploy/docker-compose.yml 新服务，与 server 同 compose 网络）
          channels.wecom: connectionMode=websocket, botId + secret
                     │  native plugin data-query（factory 形式）
                     │  读 toolContext.requesterSenderId（可信企微 userid）
                     ▼
        POST http://server:13000/api/modules/data/query（同 compose 网络，服务名直连，不出公网）
             x-channel-key: <DATA_WECOM_CHANNEL_KEY>   x-wecom-userid: <userid>
             body: { metricId, args }
                     ▼
        平台（#146 已在线上）：Casdoor getUser(userid) → 实时 scopes
          → 授权核心（词表裁剪/主体钉死/fail-closed）→ pg_duckdb
                     │
             200 {subject,…} │ 403 denied │ 401 WECOM_USER_NOT_LINKED │ 502 仓库侧
```

**平台侧零新增代码**——山海实例（当前 #530，2026-10-09 部署）已含通道 C 中间件，
本次只配 `DATA_WECOM_CHANNEL_KEY` 开闸。

## 3 版本钉死（2026-10-10 实查）

| 项 | 值 | 事实源 |
|---|---|---|
| OpenClaw | **v2026.9.9**（2026-10-08 发布） | **GitHub releases 为准**（npm `latest` 停在 2026.9.2，滞后 5+ 版） |
| 镜像 | `ghcr.io/openclaw/openclaw@sha256:7f10d5cc975a90b65192eaa099454fe33ce8ce2390806c61c65cd868e9ef730d`（tag `2026.9.9`，OCI 多架构，实测存在） | ghcr 实查；服务器拉取走 smart-proxy（ADR-0010，不配 mirror） |
| 企微插件 | `@wecom/wecom-openclaw-plugin@2026.9.15` | npm（该插件分发渠道即 npm）；peerDep `openclaw>=2026.3.28` ✓ |

升级节奏：OpenClaw 迭代快，升级以 GitHub releases 为准；**每次升级重验
`requesterSenderId` 注入行为**（首次真机消息实测销账后转为例行回归项）。

## 4 仓内改动（platform-core）

| 改动 | 说明 |
|---|---|
| `deploy/docker-compose.yml` | 单元 A 新增 `openclaw` 服务：**`build:` 自建镜像**（见下行）；state 卷持久（`openclaw_state`）；gateway 端口只回环 `127.0.0.1:18789`（B7 守卫）；`restart: unless-stopped`；healthcheck 按镜像能力实施时定 |
| `deploy/Dockerfile.openclaw` | **插件投递面（实施订正 2026-10-11）**：`FROM ghcr.io/openclaw/openclaw@sha256:7f10d5cc…`（digest 钉 v2026.9.9）+ 构建期 `COPY deploy/openclaw/data-query-plugin /opt/plugins/data-query-plugin`。**原设计写的是「compose 相对 bind 只读挂载」，实测不可行**：openship services 模式按 Docker API 逐服务建容器、**不解析相对路径** ⇒ `./openclaw/…` 被当命名卷名，建容器即 400 `includes invalid characters for a local volume name`（同根因成例：`deploy/data-plane-deploy-sop.md` 坑 9）。容器内路径逐字不变 ⇒ Task 4 的注册命令不受影响。<br>**取 build 而非「宿主持久检出 + 服务级绝对路径挂载」**：后者要维护宿主侧同步面（数据面必须，因为 pipelines/dbt 要在宿主就地编辑），而本插件是**纯仓内只读源码**，构建期 COPY 让仓保持唯一事实源、且无 drift 面；同仓 `server`/`mb-proxy` 已是 build 服务，openship 下部署正常。 |
| `deploy/openclaw/data-query-plugin/` | **问数插件源码随仓分发**（**构建期 COPY 进自建镜像**，部署即插件更新，一次性 `plugins install -l` 注册）。零依赖（不用 typebox，纯 JSON schema，循 data-analysis 先例）。两个工具：<br>• `list_metrics` → `GET /api/modules/data/metrics`（同头）——回当前用户可见词表<br>• `query_data` → `POST /api/modules/data/query`（同头）——`{metricId, args}`；错误映射：401 `WECOM_USER_NOT_LINKED`→回扫码登录指引文案；403→「无权限或词表外」；502→「数据仓库暂不可用」<br>+ `openclaw.plugin.json`（manifest：factory tool 全局激活）+ `SKILL.md` + `README.md` |
| `docs/architecture.md` | 架构先行：部署单元 A 组件清单补 OpenClaw 条目（语义：**仅 platform-core-shanhai 项目启用，mytech 平台核项目显式 disabled**） |
| `.env.example` | B9：`DATA_WECOM_CHANNEL_KEY`（若未声明）/ `WECOM_BOT_SECRET` / `OPENCLAW_GATEWAY_TOKEN` 补占位声明。**LLM key 不新增**——复用已在声明的 `DATA_LLM_API_KEY`（见 §11 #6 实施订正） |

**SKILL.md 编排要点**：先 `list_metrics` 看可见词表再 `query_data`；工具调用前先回一句
「我查一下 XX」（首块文本立即可见）；不写死指标清单（词表随人变，写死必漂移）。

## 5 OpenClaw 配置（openclaw.json，state 卷）

```json5
{
  channels: { wecom: {
    enabled: true,
    connectionMode: "websocket",        // 长连接，botId + secret
    sendThinkingMessage: true,          // 秒级「思考中」占位（默认 true，显式钉死）
    // dmPolicy/groupPolicy 默认 open：企微内人人可问，平台授权核心是真门
    //（未关联 fail-closed 回扫码指引，「关联即解锁」零运营成本）
    streaming: { block: { enabled: true } }   // 非 Telegram 通道必须显式开（官方文档明说）
  }},
  agents: { defaults: {
    blockStreamingDefault: "on",        // ★ 根治「全量生成完才吐」的核心开关（默认 off！）
    blockStreamingBreak: "text_end",    // 文本段落即发，不等整条消息结束
    blockStreamingChunk: { minChars: 120, maxChars: 800, breakPreference: "paragraph" },
    blockStreamingCoalesce: { minChars: 200, idleMs: 800 },  // 更新节奏，防中间帧排队积压
    humanDelay: { mode: "off" }         // ★ 显式钉死：拟人化 800-2500ms/块停顿，问数 bot 绝不能开
  }}
  // LLM：复用山海现网 DeepSeek（OpenAI 兼容）——key 走 env，配置形状循 data-analysis 先例
  // 【实施订正 2026-10-10】原钉 wishub 自定义 provider，但组织内 12 个项目的 env 面均无
  // wishub 凭据可读；山海平台实际在用的是 DATA_LLM_BASE_URL=https://api.deepseek.com /
  // DATA_LLM_MODEL=deepseek-flash / DATA_LLM_API_KEY（isSecret，项目级）⇒ 改用同源 DeepSeek，
  // key 复用同一 env 条目（服务级 sourceId 引用，值不回显）。见 §11 待核实 #2 / #6。
}
```

- **最小权限**：**不**配 `tools.alsoAllow: ["wecom-openclaw-plugin"]`——插件自带的
  `wecom-cli` 业务工具（文档/智能表格/日历）保持不启，bot 只带我们的问数工具。
- **botId/secret**：botId 非密可进 config；secret 为敏感值——实施时核实插件是否支持 env
  注入，不支持则写入 state 卷 `openclaw.json`（= 服务器文件，安全基线允许的存放形态），
  不进仓、不进日志。

## 6 流式/提速设计（根治老病根）

**根因（源码级）**：OpenClaw `blockStreamingDefault` **默认 `"off"`** = 全量生成完才发最终一条，
与传输方式（长连接/回调）无关。企微插件的流式管道本身是通的
（`deliver` 逐块 `sendWeComReply(finish:false)` 用同一 streamId 原位更新消息），
但核心不发中间块它就没东西可发。

**修复**：§5 的配置组合。效果链：消息秒回「思考中」占位 → 模型首句（如「我查一下销售额」）
即成首块原位发出 → 工具调用期间占位持续 → 数据回来后表格/结论文本流式补全。

**前提（硬验收）**：所用 LLM 端点必须实测支持 `stream:true`——官方文档明言非流式模型
delta 稀疏，块流式形同虚设；不支持则换端点/模型。

**实施订正（2026-10-10）**：端点由 wishub 改为**山海现网同源的 DeepSeek**（`api.deepseek.com`，
项目级 `DATA_LLM_*` 三键已在用）。原定 wishub 的理由只是「配置形状循 data-analysis 先例」，
不是客户硬要求；而实施期实测确认**组织内没有任何可取到的 wishub 凭据**（12 个项目 env 面逐项查过），
硬前提因此转移到 DeepSeek 端点上（其流式支持属公开能力，仍按 §10 验收 4 实测销账）。

**顺带发现（不阻塞本期，记录在案）**：
- 插件中间帧用阻塞版发送（await ack，15s 超时），非阻塞跳帧版已实现但全仓无调用方——
  若实测更新卡顿，向上游提 PR（一行 diff 级）或 fork。
- 同会话消息串行队列（accountId:chatId 维度）：前一条未答完下一条排队，个人问数可接受。
- 流式消息 6 分钟未更新服务端拒续（errcode 846608）→ 插件自动降级主动发送，行为可接受。

## 7 openship 侧操作（实施时 MCP 完成）

1. platform-core-shanhai 项目：服务清单出现 openclaw → 启用 + 注入 env（isSecret）：
   `DATA_WECOM_CHANNEL_KEY`（**server 与 openclaw 两服务同值**，前者消费后者发送）。
   LLM key **不新增凭据**：openclaw 服务级以 `sourceId` 引用项目级 `DATA_LLM_API_KEY`
   同一条 env 条目（值不回显、不复制）。`DATA_QUERY_URL` **不设**——插件读的是 compose 给的
   `DATA_API_BASE`（`http://server:13000/api/modules/data`），原列的 `DATA_QUERY_URL` 是过时项
2. `DATA_WECOM_CHANNEL_KEY` 开闸后 server 服务 env-only refresh 重启
3. **mytech `platform-core` 项目：openclaw 服务行显式 `enabled=false`**——compose 新增服务
   在下次部署会被 openship 启动（2026-09-29 crash loop 教训），合入后立即设置并验证
4. 部署验证按 deploy-verify 规则：容器创建时间 vs 镜像构建时间 + 新行为在线可观测
   （通道 C 探针，非 HTTP 探活——宿主鉴权在路由匹配前 401，进容器验证）

## 8 企微侧（客户配合）

- 客户在企微管理后台：**管理工具 → 智能机器人 → API 模式创建 → 通过长连接配置**，交付
  `botId` + `secret`
- 用户入口 = 新机器人的会话（与 data-analysis 老自建应用完全无关）
- **核对项**：智能机器人所在企业 == shanhai 租户 Casdoor 企微扫码 provider 的企业
  （不一致则 userid 反查恒 401）
- 既有闭环依赖：用户至少一次企微扫码登录 platform.shanhaiyiguo.com（Casdoor 落
  userid↔账号关联）；未关联用户 bot 回扫码指引

## 9 词表分档（实测后定档）

验收第一步用 admin 会话 `GET /api/modules/data/metrics` 实测山海词表：
- 非空且覆盖零售核心 → 只补漏
- 空/不够 → 本次登记首批乐檬零售日粒度指标（销售额/订单量/客单价等，从湖 L1/L2 物化表接，
  走既有 metric-write 面），登记走 issue + 台账

## 10 验收

1. **平台探针**（curl 直打模块 API）：`POST /query` 正确 key+userid → 200 且回包带 subject；
   错 key → 401；未关联 userid → 401 `WECOM_USER_NOT_LINKED`；词表外 metric → 403；
   `GET /metrics` 同头 → 200 且只含该用户可见词表（list_metrics 工具的数据源）
2. **端到端（真机）**：私聊问数全链路（流式观察）；未关联账号被拒且回指引；群聊按 sender
   逐条鉴权（requesterSenderId 每次工具调用注入）；`data.query_audit` 落 `channel=wecom` 审计行
3. **流式体验硬指标**：占位 ≤2s；首块文本 = 模型首响 + ~1s；生成期间消息持续原位更新
4. **LLM 流式实测**：所用端点（山海 DeepSeek，`api.deepseek.com/v1`）`stream:true` 出 delta
5. **部署面**：shanhai 项目 openclaw 服务 healthy；mytech 项目 openclaw 行 disabled 实证
6. 首条真机消息核对 `requesterSenderId` 形状 == Casdoor name（待核实项销账）

## 11 风险与待核实

| # | 项 | 处置 |
|---|---|---|
| 1 | `requesterSenderId` 注入跨版本稳定性 | 首条真机消息实测销账；绑进升级回归项 |
| 2 | LLM 端点流式支持（**实施期已换端点：wishub → 山海 DeepSeek**，理由见 §6 实施订正） | 实施期实测 `stream:true` 出 delta；硬前提，不支持即换端点/模型 |
| 3 | 智能机器人企业与租户 provider 同 corp | 实施时核对 corpId |
| 4 | mytech 项目新服务行未 disable ⇒ 下次部署 crash loop | 合入后立即设置（openship §7.3），验收实证 |
| 5 | 中间帧阻塞发送可能卡顿 | 实测；必要时上游 PR/局部 fork |
| 6 | LLM key / secret 取值 | 「在哪、怎么取」：**LLM key 复用 shanhai 项目级 `DATA_LLM_API_KEY`（2026-10-10 实测：组织内无 wishub 凭据可取；山海现网 LLM 实为 `api.deepseek.com` + `deepseek-flash`）**；企微 secret 从客户后台取；一律进 openship env isSecret 或 state 卷 config，不进仓不进日志 |

## 12 明确不做

- data-analysis 仓**零接触**（不 clone 部署面、不改 compose、不动其容器）；老 bot 不迁移不关停，
  并存期用户引导走运营（另账）
- 新 bot 不带 `wecom-cli` 业务工具、不带 notify/push 插件——只做问数
- 不建绑定码子系统（身份模型循 #146 正典：企微 userid 即身份）
