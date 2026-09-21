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
