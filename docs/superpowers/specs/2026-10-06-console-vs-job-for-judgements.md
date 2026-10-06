# 判据类作业的归口：console vs openship job —— C 方案可行性实测

> 2026-10-06 ｜ 触发：**客户增长下「openship job 会不会治理困难」**的追问
> 状态：**可行性已在真机验证**；**首个迁移案例尚未做** ⇒
> **正典 §1.1.4 若要加这条规则，等案例销账后再立**（根本法则：无案例不立标准）
> 验证环境：数据面机 `8281d598` 上的 **64188 console**（**生产**）。探针只读、跑完即撤（留运行记录当证据）
> 关系：本文是 issue **#428**（「接调度」那条）的选型依据

## 0 结论先行

**「判据类作业能否从 openship job 搬进 duckle console」= 可以，已实测。**

| 待证 | 结果 | 证据（逐条抄录） |
|---|---|---|
| **读湖** | ✅ **通，且账对得上** | `status: ok (1796ms)`；`n_rows,n_branches,n_orders,gross = 6307,74,3382,270847.06` —— 与 #428 记的「64188 2026-10-02 74 店 湖 **270,847.06**」**逐字吻合** |
| **console→pg_duckdb 网络** | ✅ 通 | 报错已到鉴权层：`connection to server at "pg_duckdb" (172.19.0.4), port 5432 failed` |
| **`duckdb.query($$…$$)` 进管线** | ✅ 编译通过 | `pushdown:true` ⇒ `postgres_query('duckle_src_pg','…duckdb.query($$…$$)')`，**`$$` 完整存活** |
| **凭据** | ✅ **本来就齐** | 卷里 `connections/{zos.json(s3), lemeng.json(rest)}` —— 零新凭据、零 openship 改动 |
| **判红→告警** | ⚠️ 未直证 | 64188 的 `alerts.json` 规则按 **`match` 管线名**匹配（只有 dim/windows/tick/close 四条）；§1.5 与 `console/DELIVERY.md` 有既有实测 |

**⇒ 判据类作业能整条搬进 console，于是：不占 openship job、按账套天然隔离、加一个账套只加一条 `schedules` 条目**（不用复制 job、不用改容器名）。

## 1 问题：job 数 = 作业角色 × 部署数

控制面 42 条 job 实测：`kind=system`（平台自带）**25 条**，**不随客户涨**；`kind=custom` **17 条**，是会长的那批。而它们的形态是：

| 观察 | 实测 |
|---|---|
| 绑定**单机** | **15 / 17**（只有「构建缓存现场采集」6 机、`host-metrics` 4 机是多机） |
| 有**告警配置** | **3 / 17**（14 条没接告警） |
| **重名** | `fix-dburl-check` **×2** |

根因在命令**把部署名写死**，不是参数化：

```
lemeng-dbt-materialize :  C=openship-platform-core-shanhai-data-lemeng-console-3120
                          PLAT=openship-platform-core-shanhai-postgres
lemeng-recon-day-heal  :  C=openship-platform-core-shanhai-data-lemeng-console-3120
L1 词表物化             :  docker exec … openship-platform-core-shanhai-server …
```

⇒ **每接一个客户，复制一条 job、逐字改容器名。** 今天 ≈2 个部署 × 约 10 个角色 ≈ 16 条 —— 对得上。**20 个客户就是 160+ 条。**

## 2 两个结构性缺陷（根因不是「job 多」）

1. **扁平命名空间**：job 的字段实测是 `id, key, kind, label, cron, scheduleType, enabled, actionConfig, dependsOn, notifyConfig…` —— **没有 project / tenant / tag**。唯一身份是**人写的 `label`** ⇒ 无分组、无批量、无归属；42 条就已经重名。
2. **命令不自定位**：把 `-shanhai-` / `-3120` 硬编进去 ⇒ 一台机器一条 job，而不是「一个角色一条 job」。

## 3 顺带纠正两条（实测打脸，**都改变了结论**）

### 3.1 「console 带不了 env ⇒ 带凭据的作业放不进去」——**错**

带不了 env 的是**调度条目**（`Schedule` 结构体确实没有 env 字段，实测塞 `env`/`args`/`params` 被静默丢弃）；但 **console 服务本身**带着**整份账套 env**，**管线运行时读得到**。64188 console 容器内 `printenv` 键名实测：

```
DUCKLE_TOKEN  LEMENG_TOKEN  LEMENG_TOKEN_64188  SYSTEM_BOOK
ZOS_BUCKET  ZOS_REGION  ZOS_ENDPOINT  ZOS_ACCESS_KEY  ZOS_SECRET_KEY
LEMENG_ZOS_*（第二套）  DUCKLE_ALERT_WEBHOOK_URL/TOKEN  POSTGRES_PASSWORD
```

且 `${ENV:ZOS_BUCKET}` 在管线里**实测展开成功**（现有 L0 管线也一直在用 `${ENV:…}`）。

**这条纠正把 C 从「堵死」翻成「可行」。**

### 3.2 openship 的 **env 表列了键 ≠ 容器里有值**

`POSTGRES_PASSWORD` 在 service env 表里**列着**，容器里**键在、值为空** ⇒ `${ENV:POSTGRES_PASSWORD}` 展开成**空串**，表现为
`fe_sendauth: no password supplied`（一个看起来像「网络/权限」的鉴权错）。

⚠️ **这是陷阱不是故障**（今天没有作业用它），但 3120 大概率同病 ⇒ **建议单独开 issue**。

> 既有记忆只记了「表空 ≠ 容器没 env」的**正向**；这条是**反向**，两条都要记。

## 4 已验证的两条通路

| 通路 | 状态 | 说明 |
|---|---|---|
| **直读湖**：`src.minio` + `connectionRef:"zos"` | ✅ **已跑通** | ⚠️ **`glob:true` 时 `key` 必须本身就是通配式**（`…/bizday=2026-10-02/**/*.parquet`）；给**裸前缀**会被当文件读 ⇒ `HTTP 404` |
| **经 pg_duckdb**：`src.postgres` + `pushdown:true` → `duckdb.query($$…$$)` | ✅ 编译通、网络通；**本机因上条空口令跑不通** | **直读湖已够用，不必依赖它** |

## 5 代价与边界（不粉饰）

- ⚠️ **一账套一 console 是结构性约束** ⇒ 客户多了，**job 的账换成 container 的账**，不是白拿。
- ⚠️ **写动作（回填）不该跟着上**：console 管线做**判据**合适；做**写回填**要谨慎（§1.4.1：管线内是 fail-closed，会拦采集）。合理切分 = **判据在 console、回填仍在 job**。
- ⚠️ 与 §1.1.4「duckle 优先」的关系：这只改**归口**，不改**执行器**——判据类本来就该在**管线外**（§1.4.1），现在只是把「管线外」落在**同一台 console** 而不是一条 job。

## 6 探针的做法（可复用，影响面可做到极小）

```
curl -s -X POST http://127.0.0.1:<port>/api/run \
  -H "Authorization: Bearer $DUCKLE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"file":"tmp/<名>.json"}'
```

- body 的键是 **`file`**（值 = **工作区相对路径**）⇒ 管线丢进 `${workspace}/tmp/` 即可跑，**不用 seed、不用加排班、不用重启、不碰仓内 `pipelines/`**。
- 端口：64188 = `18081`、3120 = `18080`，均只绑回环。
- **清理口径**（沿用仓内先例）：删管线文件与产物，**留 `runs/` 运行记录当证据**。
- ⚠️ **告警面要预料**：`alerts.json` 的 `on:[failure,recovery]` 规则按 `match` 管线名匹配；但 OO `data_alerts` 流里**有**过去 `_render_probe*` / `task7c.probe.run` 的 error 条目 ⇒ **该通路对未匹配名也会播报**，做探针前先想好会不会刷群。

## 7 待办（首个迁移案例）

**建议样板 = `recon-preagg`**，理由：它现在**只能手工跑**，#428 正卡在「接调度」——搬进 console 恰好把那条一并解了。

拟定的切分：

| 件 | 去哪 |
|---|---|
| **判据**（湖侧净化净额 vs 预聚合端点，逐店 diff） | **console 管线**（64188 起，3120 待其端点修复） |
| **写动作**（不平→回填→复验 = `recon-day-heal`） | **仍留 openship job**（见 §5 第 2 条） |
| **定稿线 T-3 两档**（未定稿只报数不判红 / 已定稿零容差） | 管线内用 SQL 条件 + `ctl.die` 表达 |
| 壳脚本 `scripts/lemeng/recon-preagg.sh` | 待定：保留为「免 console 的手工/排障入口」，另加一条**一致性测试**防两边漂移 |

**销账判据**（做完才算案例成立）：排班触发一次且如实入账 / 跑的是**已定稿营业日（T-3）** / 3120 通道不可用时**不刷红** / 连续 ≥3 天无假绿。

**销账之后**：再把规则写进正典 §1.1.4（无案例不立标准）。
