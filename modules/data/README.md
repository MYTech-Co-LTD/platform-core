# modules/data — 数据问数域

三条消费通道、一个授权核心。设计见
`docs/superpowers/specs/2026-09-21-data-query-channels-design.md`，
实施见 `docs/superpowers/plans/2026-09-21-data-query-channels.md`。

- 授权核心：`domain/authz.ts`（纯函数，三通道共用，**不得**在别处再判一次权限）
- 通道差别只在鉴权中间件层：会话（宿主既有）/ PAT（`apps/server/src/pat-auth.ts`）/
  企微（`apps/server/src/wecom-channel-auth.ts`）
- env 键见根 `.env.example`（真值只在 openship env，本仓不写明文）
- 租户隔离键 = `org text not null`（值 = `identity.orgId`），三张表一律如此；机器判据见
  `scripts/check-tenant-isolation.mjs`（正典 `docs/module-protocol.md`「租户数据隔离」）

## 三通道怎么验（e2e 回归锁在哪）

三通道「一个授权核心」的端到端验证在 `apps/server/src/data-query.e2e.test.ts`
（真装配：buildApp + MockCasdoor + 双租户 + 真 pg 仓库；需 `DATABASE_URL`）：

| 用例 | 锁的不变量 |
|---|---|
| 1 | PAT 往返契约：模块路由（`POST /keys`）建的 key，宿主中间件**经模块端口**认下来——端口装配端到端 |
| 2/3/4 | 三通道（会话/PAT/企微）同一指标同一数据：subject 钉死 acme、行集**逐行一致**——任何通道拿到不同结果 = 授权核心被绕过 |
| 4 后半 | 企微未关联用户 → 401 `WECOM_USER_NOT_LINKED`（fail-closed 可解释拒绝） |
| 5 | 主体钉死：三通道在 `args` 里塞 `org` → 403 `subject_pinned_by_platform`，回包无 beta 数据 |
| 6 | 词表裁剪：`data:finance` 指标在 GET /metrics（A/C）与 tools/list（B）都不出现 |
| 7 | 审计三通道统一：ok 记录共写一张表、org 全为 acme——参数里的 beta 从未变成审计主体 |
| 8 | 宿主声明门卫仍然生效（`/metrics/all` 要 `data:manage`，403 带 `need`；差分 200） |
| 9 | 空身份打 `/query` 与 `/mcp` tools/call → fail-closed 401 可解释拒绝 |

改授权核心、三通道中间件、manifest 声明或宿主装载器门卫时，这份文件是回归底线；
其中用例 8 同时锁着 issue #145（param 门卫误伤静态兄弟路径）的修复。

## 报表面（Metabase 嵌入；issue #150 / T7）：`tenant` 参数约定

报表本体在 Metabase、登记在平台（双写面）⇒ 平台是**唯一的鉴权与定租户点**
（AI 侧的语义层自身不带权限，spec §11.3.1）。嵌入走的 signed embedding，权限**双门分开**：

| 门 | 管什么 | 落在哪 |
|---|---|---|
| 页门 | 「谁**能看**」 | 本模块的 platform scope（宿主按 manifest 施加）：制作/登记/对账 `data:manage`，观看面 `data:query` |
| 数据门 | 「看**哪个租户的数据**」 | 嵌入 JWT 里 `locked` 的参数值，由 `GET /reports/:id/embed-url` **现签** |

### Metabase 侧的名称 = `<org>/<title>`（**命名空间**，跨租户串味的结构性防线）

平台的 Metabase 是**单实例多租户共用**的，dashboard 在那边只有 `name` 这一个身份。
两个租户用**同一个 title** 建报表时，若名字不带 org，`GET /api/search` 会按名命中**同一张**
dashboard ⇒ B 的 `setEmbedding` 覆盖 A 的 `embedding_params`、B 的 `DELETE` **归档 A 的报表**
（跨租户**破坏性**操作，实测复现）。故平台的规范名是 **`<org>/<title>`**：

- **只体现在 Metabase 侧的名字上**：`data.reports.title` 恒为用户可见的原标题，
  `unique (org, title)` 语义不变（⇒ 本约定**不需要迁移**）。
- 查找（`GET /api/search`）、创建（`POST /api/dashboard`）、发布（`setEmbedding`）、
  归档（`DELETE` 路径上的 `archiveDashboard`）**四处口径必须一致**——后两处按 id 走，
  id 就是创建时那次规范名 upsert 的返回值。少一处就留一条串味路径。
- **运维 / AI 去 Metabase 里找报表时**：按 `<org>/<title>` 搜，或按 org 前缀认归属。
- 部署注记：本约定之前建的 dashboard **没有**前缀 ⇒ 首次重跑 `POST /reports` 会新建一张带
  前缀的；老那张会出现在对账的 `unregistered.needsHuman` 里（需人归档）。

**★ 建 Metabase dashboard 的人必须遵守的约定**：把租户过滤写成**名为 `tenant`**的
参数（仪表盘过滤器或原生查询变量皆可）。

- 平台在 `POST /reports` 时会把 `tenant` 与报表自己声明的 `lockedParams` 一并写进 Metabase 的
  `embedding_params`（值恒为 `"locked"`）；
- 签名时 `tenant` 的值恒 = **调用者身份里的 org**（`requester.orgId`），
  **入参一律不可覆盖**（`POST /reports` 的 `lockedParams` 里带 `tenant` ⇒ 400 `TENANT_PARAM_RESERVED`）；
- ⇒ 若 dashboard 的租户参数不叫 `tenant`，JWT 里的锁定值**绑不到任何东西**，页面会显示未经
  租户过滤的数据。
- ⚠️ **机械防线在 `reconcile`，不在本文**：`POST /reports/reconcile` 会回读
  `GET /api/dashboard/{id}` 并断言 `embedding_params.tenant === "locked"`，不满足的行落进
  响应的 `tenantUnlocked`（并 `ok:false` + 落 warn 日志）。**上面这条人侧约定只是给 T10 真机
  核对的备忘，别把它当唯一防线**——靠人记得的约定失效时是静默的（页面照常显示未过滤数据）。

env 三键（`DATA_METABASE_URL` / `_API_KEY` / `_SECRET_KEY`）见根 `.env.example`；
`SECRET_KEY` 决定「看哪个租户数据」那一半权限，泄露 = 能签任意租户的嵌入凭证。

### `POST /reports/reconcile` 的四个差集（spec §7 双写面对账）

响应体 + `console.warn` 双通道（**显式可见**，不静默——M3c 教训）：

| 字段 | 判据 | 作用域 |
|---|---|---|
| `missingInMetabase` | 登记行的 `metabase_id` 不在可嵌入集里 | **本 org** |
| `tenantUnlocked` | 回读 `embedding_params.tenant !== "locked"` | **本 org** |
| `unregistered.recoverable` | 可嵌入集里**不属于任何 org 的任何一行 `metabase_id`**，且名字能解出 `<org>/<title>`（归属确定 ⇒ 重跑 `POST /reports` 按全等命中接管） | 登记侧取**全部租户**并集 |
| `unregistered.needsHuman` | 同上但名字解不出归属（人在 Metabase 侧直接建的 / 本约定之前的遗留）⇒ 必须人判 | 同上 |

`unregistered` **不能**按 `title` 求差：那样同名孤儿（幂等窗口/并发造出的重复 dashboard）看不见，
且多租户下会把别人的 dashboard 恒报成本租户未登记——两种都是**假绿**。跨 org 读是**平台级
对账动作**的一部分（spec §7），只用于这里的并集判据。
报表删除走「**先归档、再删行**」：只删登记行会让该报表恒留在未登记差集里（消不掉的噪声）；
先归档、删行失败则报成 `missingInMetabase`（可恢复、显式可见）。
