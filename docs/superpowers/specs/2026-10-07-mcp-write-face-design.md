# 指标口径写面（MCP）：把「本租户口径」交给外部 agent

> 2026-10-07。上游决策见 `2026-09-28-report-authoring-design.md` §7「已定：agent 承载方式」——
> **框架在门外，门内做 MCP 工具面**；本稿把 manifest 里那句「MCP 工具面…另题，本轮不实现」做掉。
> 现状断言全部带**生产实测**（§2），不是读代码推的。

## 0 一句话

在 MCP 上开一个**声明为 `data:manage` 的写面端点** `/mcp-manage`，暴露三个工具
（`list_metrics` / `customize_metric` / `delete_custom_metric`），让持有该档位凭据的外部 agent
能像人一样**基于已有口径裁剪出本租户口径**——门禁、隔离、判定全部沿用既有那条链，本设计**不新增授权代码**。

## 1 为什么需要这份设计

三条已定的前提汇到这里：

1. **问数（读）面已经在 MCP 上了**，且只读。agent 能查，不能定义。
2. **L2 的写入面只有 HTTP**（`POST/PUT/DELETE /metrics`）。agent 走 HTTP 也能用，但那意味着
   每个 agent 侧都要自己实现一套「带 PAT 的 HTTP 客户端 + 重试 + 错误码翻译」；
   MCP 把这件事变成协议面。
3. **上层的路已经选好**：§7 的决策是「**框架在门外，门内做 MCP 工具面**」——
   pi / DeepSeek Harness / 通用 SDK 都不进产品运行时，产品只把门按 MCP 协议开好。
   **本设计就是那扇门。**

## 2 现状（2026-10-07 生产实测，platform-core-shanhai）

| 验的什么 | 结果 |
|---|---|
| 读面 MCP 握手 | `initialize` → 200，`serverInfo.name = platform-data-mcp`，protocolVersion `2025-06-18` |
| 读面工具集 | `tools/list` → **2 个工具**，且**每个指标一个**（工具名 = 指标 id，如 `lemeng:retail:net_sales`） |
| 读面调用与审计 | `tools/call` → `isError:false`、`status:ok`、28 行、`subject=shanhaiyiguo-org`；审计表落行（`channel=pat`、rows=28、verdict=ok） |
| **写面是否存在** | `POST /mcp-manage` → **404**（不存在）；写路径目前只有 HTTP 三件 |

**一条没验到的（如实标注）**：本设计依赖「宿主按声明施加门禁」，而这在生产上**未做单档凭据的实证**
（手上只有一张双档凭据）。它的证据是**机制层测试**：`apps/server/src/loader.test.ts` R2 节的三条
——「注册了未声明的路由 ⇒ 装载失败」「声明了却未注册（幽灵声明）⇒ 装载失败」
「匿名 401 / scope 不符 403 / scope 命中 200」。

## 3 不变量（本设计的硬核）

### ① 门禁只由**声明**施加，写面不写一行授权代码

新端点在 manifest 的 `api.internal` 里声明 `scope: data:manage`，宿主按声明施加门卫。
本模块的既有口径就是「**本模块不自己写 `requireScope`，门卫由宿主按本清单施加**」——
写面沿用同一条，**不新开绕过清单的入口**（manifest 预留段的原话即此告诫）。

### ② 写路径的判定只有**一份**

`routes/metrics.ts` 里的 `writeL2` 与 DELETE 的判定链（撞 L1 保留 / 基底必须是 L1 / 未知维度 /
源接入闸 …）**抽到域层**，HTTP 路由与 MCP 写面共用（形态同 `query-service.runQuery`）。
不许复制一份到 MCP 路由里——两个事实源是本仓明令禁止的形态，且这条链每加一条闸就会分叉。

### ③ 工具面比 HTTP 面**窄**（有意收窄）

`customize_metric` 的入参**不含 `op`**：v1 只有 `refine` 一个算子，由工具面固定。
理由：让 agent 去写 `op` 只会多一个「它可能写错、而错法在 HTTP 面被 zod 拦成 400」的噪音。
⇒ 工具面与 HTTP 声明**不是逐字同一形状**，这是取舍不是疏漏（见 §6 的代价）。

### ④ 主体钉死，不入参

org 一律取租户（`c.get('tenant').casdoor_org`），与读面、`/query`、`chat` 同一口径。
工具入参里**不出现**主体/组织字段，agent 连「能不能填」都不该知道。

### ⑤ 协议面也只有一份

JSON-RPC 壳（initialize / ping / tools-list / tools-call / 通知回 202 / 错误码分层）
与读面**同一份实现**：拆成「共享 rpc 壳 + 每端点一个工具集」。协议细节复制一份，
下次规范升版就会只改一处。

## 4 设计

### 4.1 端点与声明

```yaml
- { method: POST, path: /mcp-manage, scope: data:manage }   # 写面：本租户口径的定义
```

读面 `/mcp`（`data:query`）**一行不动**。两个端点各自只有一个职责，客户端按需配置。

### 4.2 三个工具

| 工具 | 入参 | 回什么 | 描述要点（中文，写进 inputSchema 的 description） |
|---|---|---|---|
| `list_metrics` | 无 | 可用 **L1 基底**（id / 标题 / 说明 / 源系统 / **可用维度**）+ 本租户已有 **L2**（id / 别名 / 基底 / 过滤 / 可见维度） | 先查再定；可用维度决定你能裁剪出什么 |
| `customize_metric` | `{ id, baseMetric, alias?, visibility?, filters? }` | 落库结果（与 HTTP 面同码的拒因），**不回编译后的 SQL** | **只能基于已有口径裁剪，不能凭空造新指标**；基底必须是 `list_metrics` 里出现的 id |
| `delete_custom_metric` | `{ id }` | 同上 | **只能删本租户自定义的**；平台口径删除会被拒 |

**为什么要 `list_metrics`**：让 agent **先查再建**（防重名、防「以为自己能造指标」）。
这条**不能只写在提示词里**——它得是工具面的结构（上游 spec §4.3 的同一条口径）。

两处口径写死，免得实施时自由发挥：

- **「可用维度」= 基底的 `groupBy` 维度**（L2 拿不到基底没有的新维度，这是 v1 的表达力边界）。
  `list_metrics` 必须把它显式列出来，否则 agent 只能靠试错撞「未知维度」的拒绝。
- **`customize_metric` 不回编译后的 SQL**：上游稿 §4.4 的落点就在这里——**给人/给 agent 看的是口径，
  不是 SQL**。回 SQL 等于把「L2 本来就写不了 SQL」这条边界从后门打开，还会诱使 agent 去调字符串。

### 4.3 复用边界（三种做法，取①）

| 做法 | 评估 |
|---|---|
| **① 抽到域层**（本设计） | `domain/metric-write.ts` 返回判别式结果（`{status:'ok'} \| {status:'refused', code}`），HTTP 路由与 MCP 写面共用。改一处两边都变 |
| ② MCP 路由转调 HTTP 路由 | 不可行：要带身份自己发请求，等于绕自己一圈，还多一层凭据处理 |
| ③ MCP 路由复制一份判定 | 两个事实源，本仓明令禁止 |

### 4.4 授权与隔离

- 鉴权：宿主按 `scope: data:manage` 施加；**写面不写判定代码**（§3①）。
- 隔离：租户取 `casdoor_org`；`tenant_source` 源接入闸照旧（未接入源的基底会被拒）。
- L1 只读不变：`delete_custom_metric` 打 L1 的 id ⇒ 沿用既有的只读拒码；改平台口径仍走仓内
  dbt + PR（`2026-09-28` 稿 §4.1 的落点表不变）。

### 4.5 错误形态（沿用读面）

- **工具级**（业务拒绝/失败）→ `result` + `isError:true`，内容里带既有判定码。
- **协议级**（不可解析 / 形状非法 / 未知方法）→ JSON-RPC error 信封（HTTP 200）。
- 分级理由与读面同：协议错误不是服务端故障，工具级拒绝不是协议错误。

## 5 非目标（写清楚，免得后面被当漏做）

1. **不做 L1 写入**：平台口径的变更走仓内声明 + PR + 我方评审（上游稿 §4）。
2. **不做报表工具面**：上游 spec §8 步骤 5，等报表底座（渲染器 / 发布路径 / 页门）落地。
3. **不给写操作新增审计表**：现有审计面只覆盖查询。这是**已知缺口**（§6），不在本次扩。
4. **不改读面**：`/mcp` 的工具集、协议面、裁剪口径全部不动。

## 6 已知边界（如实记账）

1. **工具名与租户可自取的指标 id 理论上可能撞名**：写面工具叫 `list_metrics` 等，而 L2 的 id 由租户取
   （≤64 字、无保留前缀约束）⇒ 某个租户起名成 `list_metrics` 时，同一个 MCP 客户端会看到两个同名
   不同义的工具。**MCP 客户端按 server 命名空间隔离**，后果是「可能用错那一个」，不是安全面。
   **本设计选择「把名字取成人话」而不是「保留前缀」**——前者对租户管理员更可读（2026-10-07 人裁）。
2. **写路径无审计**：创建/删除本租户口径目前不落任何审计行（查询有）。排查「谁把口径改了」时
   **只能靠数据库行上的时间戳**。这是既有缺口，本次不扩（§5.3）。
3. **工具面比 HTTP 面窄**（§3③）：`op` 不暴露 ⇒ 将来若出现第二个算子，工具面要跟着长，
   那一刻两者会再次分叉——**那时必须回来改本节**，别让「窄」变成「缺」。

## 7 测试与验收

| # | 断言 | 为什么它值得存在 |
|---|---|---|
| 1 | 协议面一批（initialize / ping / 通知 202 / 未知方法 -32601 / parse error -32700 / invalid request -32600） | 与读面同形；协议壳是共享实现，两端点都要过 |
| 2 | `list_metrics` 回 L1 基底 + 本租户 L2，且**不含未接入源的基底** | 裁剪口径与读面同源（`visibleMetrics` + 源闸） |
| 3 | `customize_metric` 成功 ⇒ 落库可读回；`list_metrics` 再查能看到 | 端到端 |
| 4 | 三条拒绝：撞 L1 保留 id / 基底不存在（或指向 L2）/ 未知维度 | 判定链复用后**两端点行为必须一致** |
| 5 | `delete_custom_metric` 删自己的 ⇒ 成功；打 L1 id ⇒ 沿用只读拒码 | 同上 |
| 6 | **写面路由的声明 scope 必须是 `data:manage`** | **本次的承重断言**：它是「门禁来自声明」这条安全属性的唯一可机检落点。变异确认 = 把它改成 `data:query` 时恰有一条用例变红 |
| 7 | 清单声明 ↔ 注册路由双向核对（既有测试自动覆盖新路由） | 幽灵声明 / 未声明注册都会让装载失败 |

## 8 落地物

| 文件 | 动作 |
|---|---|
| `modules/data/manifest.yaml` | 加 `/mcp-manage` 声明；改掉「预留，本轮不实现」那段注释 |
| `modules/data/routes/mcp.ts` | 拆成共享 rpc 壳 + 读面工具集 |
| `modules/data/routes/mcp-manage.ts` | 新增：写面路由 + 三个工具 |
| `modules/data/domain/metric-write.ts` | 新增：从 `routes/metrics.ts` 抽出的写/删判定链 |
| `modules/data/routes/metrics.ts` | 改为调域层（判定链不再内联） |
| `modules/data/README.md` | 写面说明 + §6 的两条已知边界 |
| 测试 | `routes/mcp-manage.test.ts`（新）+ `manifest` 一致性（既有） |

## 9 未验（诚实边界，别当已验）

1. **真实 MCP 客户端**（Claude / pi / 任意 SDK）对本端点的兼容性**未验**：本设计只按
   `2025-06-18` 版协议手写壳，读面在规范层是这样写的，但**没有拿真客户端连过**。
2. **单档凭据被门禁拒**在生产上未实证（§2 末）。
3. **并发写**：两个 agent 同时 `customize_metric` 抢同一个 id 的时序行为未验
   （既有 HTTP 面同样未验，本设计不新增也不缩小这个缺口）。

---

## 附：证据出处（2026-10-07）

- 生产实测：`platform.shanhaiyiguo.com` 上打 `/api/modules/data/mcp` 的
  `initialize` / `tools/list` / `tools/call`，以及 `/mcp-manage` 的 404 探测；
  审计行在 `data.query_audit`（`channel=pat`）。
- 机制证据：`apps/server/src/loader.test.ts` R2 节（声明即授权：包裹层门卫 + 装载期双向核对）。
- 上游决策：`docs/superpowers/specs/2026-09-28-report-authoring-design.md` §7「已定：agent 承载方式」。
- 既有实现：`modules/data/routes/mcp.ts`（读面）、`modules/data/routes/metrics.ts`（HTTP 写入面）。
