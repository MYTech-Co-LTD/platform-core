# Runbook：新客户接入（默认一个客户 = 一个 project）

> **适用**：给新客户做**私有化部署**（`TENANT_MODE=single`）。
> **SaaS（`multi`）不走本文**——只在平台内 provisioning（见 §8）。
>
> **本文结论经控制面真机实测**（2026-09-21，lab project `dp-lab` / `dp-lab-bi`，五项验证，
> 部署证据见 §9）。**默认模型已从「一客户两 project」改为「一客户一 project」**，两 project
> 模式降级为「一机不够时的拆缝选项」（§0 / §5 阶段 5）。
>
> 关联：`deploy/openship-adopt.md`（单客户接入的原始 runbook）、`deploy/delivery-private.md`（私有化交付）、
> `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（数据栈分层设计）

---

## 0 核心模型：一个客户 = 一个 project（一台机器）

```
一个客户（私有化）
└─ platform-core-<客户>        一个 project，一台机器
   ├─ compose：平台宿主 + 模块 + 数据栈全部服务（deploy/docker-compose.yml）
   ├─ 旋钮① 参数差异      → project env（不进 git）
   ├─ 旋钮② 服务裁剪      → 服务级 enabled 开关（控制面配置，不进 git）
   └─ 旋钮③ 客户特有代码  → customers/<客户>/ 目录（进 git，走 PR）
```

**一机不够时沿缝拆**（同仓、同分支，只换 composePath——2026-09-21 实测可行）：

```
platform-core-<客户>        composePath=deploy/docker-compose.yml   ← 平台 + 模块
platform-core-<客户>-data   composePath=deploy/data-compose.yml     ← 数据栈（duckle/dbt/pg_duckdb/BI）
```

**三条硬规则**：

1. **不开客户分支**。差异用三层 + enabled 开关表达。
   （先例：`platform-core` 与 `platform-core-shanhai` 同仓同分支 `main`；`woke` 绑
   `customer/woke-v5` 是存量例外，**别学**。）
2. **命名后缀绑客户**。控制面没有「客户」实体，project 之间只有命名关联
   ⇒ 后缀统一 `-<客户>`（小写 kebab，与 slug 规则一致）。
3. **同一 project 的服务同 compose 网络，服务名即主机名** ⇒ 默认同机时
   **平台↔数据栈不需要跨 project 接线**；只有拆缝后才有接线步骤（§5 阶段 5）。

---

## 1 仓库目标形态（单分支，模块与数据栈同居）

```
platform-core/
├─ deploy/docker-compose.yml      # 部署单元 A：平台宿主 + 模块（全客户必跑的服务才进这里）
├─ deploy/data-compose.yml        # 部署单元 B：数据栈（拆缝时才用；可选服务也建议放这）
├─ modules/<模块>/
├─ contracts/{common,customers/<客户>}/
├─ duckle/{common,customers/<客户>}/
└─ dbt/models/{common,customers/<客户>}/
```

> ⚠️ **改 canonical compose = 改所有客户**：新服务会自动出现在每个客户 project 的
> 下次部署里（实测 Test 3）。处置见 §6 运维纪律第 3 条。

---

## 2 差异放哪：三层 + 一个开关，都不靠分支

| 层 | 差异 | 放哪 | 进 git |
|---|---|---|---|
| **参数** | 客户标识、域名、对象存储、Casdoor org、会话密钥 | **project env** | ❌ |
| **配置** | 切片 / 别名 / 目标值 / 可见性 / 账套清单 | **平台 DB（L2）** | ❌ |
| **代码** | 客户特有的管线 / dbt 模型 | 同仓同分支 `customers/<客户>/` | ✅（走 PR） |
| **开关** | 客户不用某块服务（如不做数据分析） | **服务级 `enabled`**（控制面配置） | ❌ |

**判据一句话**：
> SQL/管线 ⇒ `common/` 或 `customers/<客户>/`；配置 ⇒ L2；「整个服务要不要起」⇒ enabled。

`enabled` 语义（实测 Test 2）：置 false 后**该服务不部署，且已跑的容器会被拆除**——
是「个性化裁剪」，不只是「下次不起」。

数据初始化按目录选，不靠分支：

```sh
CUSTOMER=<客户>
dbt run --select "path:models/common,path:models/customers/$CUSTOMER"
```

---

## 3 前置决策（执行前必须有人拍板）

| # | 决策 | 默认 |
|---|---|---|
| 1 | **同机还是拆缝** | **默认同机一 project**；机器不够或数据栈资源吃紧才拆（§5 阶段 5） |
| 2 | 域名 | 平台域名；智能问数入口要 HTTPS |
| 3 | PG 策略 | compose 内建 pg 还是托管库 |
| 4 | Casdoor org / application | 每客户一套（`PLATFORM_ORG` 必填） |
| 5 | 对象存储 | 该客户的桶与凭据（**只写「在哪、怎么取」，不写明文**） |
| 6 | **裁剪清单** | 该客户不启用哪些服务（决定 enabled 矩阵，见 §5 阶段 4） |

---

## 4 ⚠️ 机器与端口（实测约束）

| 场景 | 约束 |
|---|---|
| **不同客户的 project 放同一台机** | **端口撞**：compose 写死 `127.0.0.1:${HOST_PORT:-13000}`（server）与 `127.0.0.1:5432`（pg）⇒ 要么 `HOST_PORT` 错开，要么分机 |
| **拆缝后的两个 project 放同一台机** | 同上：数据栈服务端口必须与平台错开（实测 lab：18080/18081/16379 各归各） |
| 多台机器 | 每台先跑 `bootstrap-server.sh`（幂等）+ dashboard 注册，`ssh_host` 一律**私网 IP** |

---

## 5 操作单

### 阶段 1：机器
```sh
# 生产机：跑 bootstrap-server.sh（幂等），dashboard 注册 server（ssh_host=私网 IP）
# ★ 预拉基础镜像（openship MCP 的 server exec 执行，如 docker pull node:22-alpine）：
#   BuildKit 解析基础镜像元数据不走 dockerd 代理（实测 §9-基建坑），
#   本地没缓存过的新基镜像首次构建必超时；先 pull 再部署。
# ★ 巡检 registry-mirrors 残留（应无输出）——mirror 失效会直接失败且不 fallback：
docker info --format '{{range .RegistryConfig.Mirrors}}{{println .}}{{end}}'
```

### 阶段 2：建 project
```sh
POST /api/projects        # name/slug: platform-core-<客户>
                          # projectType=services, framework=docker-compose
                          # rootDirectory=deploy, composePath=deploy/docker-compose.yml
                          # ★ 部署时必须显式传 serverId（创建时拿不到，patch 会静默忽略）
```
- folder-upload 流程（首部署无 git 绑定时）：session → tarball 直传 → folder/scan →
  `projects/ensure`（services 数组原样传回 + uploadSessionId）→ build_access

### 阶段 3：env 客户化 + 首部署
```sh
PATCH .../env             # ★ 客户差异全在这里：
                          #   PLATFORM_ORG, PUBLIC_ORIGIN, CASDOOR_*,
                          #   PLATFORM_SESSION_SECRET, DATABASE_URL, 该客户的对象存储凭据
```
- **env 改了不会自动生效——必须触发一次部署**
- openship env 四层物化：**inline 覆盖 project env**；排障「回滚正常、新构建崩」先查 inline 层

### 阶段 4：按客户裁剪（对照 §3 决策 6）
```sh
PATCH .../services/<svc>  { "enabled": false }   # 客户不用哪块关哪块
→ 触发一次部署 → 验证该容器确实不在（裁剪是拆容器语义，别只看部署绿）
```

### 阶段 5：拆缝（仅当 §3 决策 1 选了拆）
```sh
POST /api/projects        # platform-core-<客户>-data：同仓同分支，composePath=deploy/data-compose.yml
                          # 显式传 serverId（可与平台同机，端口错开；或另一台机）
PATCH .../env             # 数据栈自己的 env（CUSTOMER=<客户>、对象存储凭据、域名）
# ★ 唯一的跨 project 接线点：平台侧 env 加数据栈地址 → 重新部署平台 → 验收连通
```

### 阶段 6：数据初始化
| 动作 | 验收 |
|---|---|
| 建租户行（**先于一切验收**，否则整站 500 而 `/healthz` 仍 200） | 能登录 |
| 该客户的账套/主体清单 | 能列出 |
| dbt 首次物化（`common` + `customers/<客户>` select） | 有数 |
| 语义声明（L2 进 DB，不进 git） | 词表有内容 |

### 阶段 7：验收（逐项勾，别只看部署绿）
- [ ] `/healthz` 200 **且业务端点有数**（探活发现不了租户行缺失）
- [ ] enabled 矩阵与决策一致：该关的服务**容器确实不在**
- [ ] 模块页可见、能触发数据栈；BI 打开有数
- [ ] 智能问数用声明的名字能问到；**越权调用被拒**
- [ ] **部署后验**：容器创建时间 > 镜像构建时间
- [ ] **新增 env 的每个消费方都取到值**（团队规则 `deploy-verify`）

### 阶段 8：备份与监控
| 面 | 动作 |
|---|---|
| 平台 project | `pgdata` 卷进备份（openship producer：`volume`/`pg-dump`） |
| 数据栈（同 project 内） | Metabase 应用库、dbt 目标库、duckle workspace 一并入账 |
| 拆缝时 | **两个 project 两套备份面**，互相独立，漏一面恢复时才暴露 |
| 监控 | 按 project 订阅告警（控制面没有「客户」维度） |

---

## 6 日常运维纪律

| # | 纪律 | 依据 |
|---|---|---|
| 1 | merge main = 门禁全绿**自动部署**（全量） | adopt runbook §7 |
| 2 | **例行模块修复用 serviceIds 定向部署**——全量部署会重建该 project 全部容器（把客户 pg/Metabase 全重启）；定向部署其余容器 kept running（实测 Test 4a） | 2026-09-21 |
| 3 | **改 canonical compose 前先想全体客户**：新服务会自动出现在每个客户下次部署（实测 Test 3）。三选一：全体都要 / 给不需要的客户立即 patch `enabled:false`（有时窗）/ 可选服务放 `data-compose.yml` | 2026-09-21 |
| 4 | 改 env / 改 enabled 后必须显式触发一次部署 | 实测 |
| 5 | 发版 / 回滚 / 看监控都按 project 各自操作（无客户维度批量） | 控制面结构 |

---

## 7 已知陷阱

| 陷阱 | 表现 | 处置 |
|---|---|---|
| 部署不传 `serverId` | **静默**落到默认机器 | 部署时必须传 |
| 缺租户行 | 整站 500，但 `/healthz` **仍 200** | 先跑 provision |
| 同机多 project | 端口撞 | §4 错开或分机 |
| env 改了不重新部署 | 看着配好了，实际没生效 | 显式触发 |
| **新基镜像构建超时** | BuildKit `load metadata`（auth.docker.io）**不走 dockerd 代理**，直连超时；本地缓存的基镜像不受影响（2026-09-21 实测 10.0.0.7） | 阶段 1 预拉 `docker pull`（pull 本身走代理，没问题） |
| inline env 覆盖 project env | 回滚正常 + 新构建崩 = env 层分叉 | 排障先查 inline 层 |
| compose 新服务自动出现于所有客户 | 交付客户凭空多容器 | §6 纪律 3 |
| 全量部署重建全部容器 | 客户数据库被重启 | §6 纪律 2（scoped 部署） |
| 命名后缀不一致 | project 失去关联 | 写死规范 |
| 备份面漏（拆缝时） | 恢复时才发现 | 阶段 8 显式入账 |

---

## 8 SaaS（`multi`）不走本文

| | 私有化（本文） | SaaS |
|---|---|---|
| 「客户」 | **一个 project** | **一个 tenant（平台里的一行）** |
| 新客户动作 | 起一个 project（必要时拆缝成两个） | **平台内 provisioning**（租户行 + Casdoor org + 订阅） |
| 数据侧 | 该客户自己的数据栈 | 共享数据栈里建该租户资源（桶/前缀 + 语义声明 + 物化） |
| 机器 / compose | 动 | **不动** |
| 隔离靠 | 部署单元边界 | 每租户一桶 + 一份凭据 + 一个 schema |

> ⚠️ SaaS 下「给某客户单独部署」在 openship 的模型里不存在（project 是人工接入的，
> 不是运行时按客户拉的）——这是整套设计的**结构性前提**。

---

## 9 实测依据（2026-09-21，控制面真机，lab project，未触碰存量 project）

| # | 验证 | 结论 | 证据 |
|---|---|---|---|
| 1 | build + image 混排 compose | 可行 | `dep_YZcEkXFeTpirT0Dn` ready 2/2 |
| 2 | `enabled:false` 语义 | 不部署 + **拆旧容器** | `dep_Qd36t9zt3eAy2suE`，服务清单 3→2 |
| 3 | compose 新服务自动传播 | 下次部署自动起 | `dep_dbJT3EiMMMtn6Y3H` ready 3/3 |
| 4a | serviceIds 定向部署 | 其余容器 kept running | `dep_JtcT7EsUQOnL5_lo` |
| 4b | 同源双 project 换 composePath | 沿缝拆分成立 | `dep_w8KQiIDFulVQs-wm` ready，宿主 curl 200 |
| 基建坑 | BuildKit 元数据不走代理 | 新基镜像构建必挂，pull 正常 | 两次不同 IP 超时复现；沉淀进 WeKnora |
