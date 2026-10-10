# data-query-plugin（问数通道 C 客户端）

OpenClaw native tool-plugin：把可信企微 userid（`toolContext.requesterSenderId`）+ 渠道凭证
转发到平台问数 API，权限由 platform-core 授权核心按人裁决（词表裁剪/主体钉死/fail-closed）。
本插件**零权限逻辑**。

设计：`docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md`。

## 工具

| 工具 | 作用 |
|---|---|
| `list_metrics` | `GET {DATA_API_BASE}/metrics`——当前用户可见词表（按人裁剪） |
| `query_data` | `POST {DATA_API_BASE}/query` `{metricId,args}`——查数，回包带 subject |

## env 契约（容器注入）

| 键 | 说明 |
|---|---|
| `DATA_API_BASE` | 平台问数 API 基址；缺省 `http://server:13000/api/modules/data`（同 compose 网络服务名） |
| `DATA_WECOM_CHANNEL_KEY` | 渠道服务凭证；与 platform `server` 服务的同名 env **同值**（openship env isSecret） |

## 本地测试

```bash
node --test lib.test.js
```

## 部署

插件源码随仓分发：compose 把本目录只读挂载到容器 `/opt/plugins/data-query-plugin`，
容器内 `openclaw plugins install -l /opt/plugins/data-query-plugin` 一次性注册（写进 state 卷的
openclaw.json，跨部署持久）；部署更新代码后重启容器即生效。
初始化步骤见计划 Task 4（openship exec 操作）。
