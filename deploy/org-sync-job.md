# 组织同步 job（org-sync-all）：定时执行与新鲜度判据

> 正典：`docs/superpowers/specs/2026-10-30-org-as-platform-primitive-design.md` §3.2.1。
> 形态：**仓内脚本 + openship job**（零常驻），与 `deploy/notify-jobs.md` 同一范式；
> **不要**把定时同步塞进 server 进程（应用进程不跑定时副作用）。
> 运维入口一律走 openship MCP / dashboard，不裸 SSH。

## 0. 前置条件（缺一不可）

| # | 条件 | 说明 |
|---|---|---|
| 1 | 目标实例已部署含 `scripts/org-sync-all.mjs` 的镜像 | 代码合并后自动部署（山海实例是手工更版，见 `deploy/delivery-private.md`） |
| 2 | 租户行有 `wecom_corp_id` | `platform.tenant.wecom_corp_id` |
| 3 | 同步应用 secret 可读 | 优先 `WECOM_SYNC_SECRET__<ORG>`（openship env，isSecret）；缺省回落 `platform.tenant.wecom_secret`（脚本会打 warn） |
| 4 | 该实例出口 IP 在企微可信名单 | 否则 `gettoken` / `department/list` 会 `60020`；**可见范围必须覆盖全量通讯录**（2026-10-26 缺 29 部门的教训） |
| 5 | 容器内有 `DATABASE_URL`、`CASDOOR_URL`、`CASDOOR_ADMIN_USER`、`CASDOOR_ADMIN_PWD` | Casdoor 只用于 `usersNotInCasdoor` 清单；缺失时脚本 exit 2，不猜 |

> 凭证只写「在哪、怎么取」：`WECOM_SYNC_SECRET__<ORG>` 在 openship 项目 env（isSecret）；
> 不要把它写进命令、日志或本文。

## 1. 先 dry-run（默认，零写入）

通过 openship MCP 在目标 server 的容器里执行：

```sh
docker exec openship-platform-core-server sh -lc \
  'pnpm exec tsx scripts/org-sync-all.mjs --org <casdoor_org>'
```

期望输出一行：

```
org-sync: org=<org> dryRun=true depts=... users=... created=... renamed=... reparented=... disabled=... reactivated=... members+... members-... notInCasdoor=...
```

核对：

- `depts` 与企微通讯录部门数一致；`created/disabled` 的变化能逐条解释；
- `notInCasdoor` 是「企微有 / Casdoor 无」的待建号清单（**不会自动建号**）；
- fail-closed 门触发时输出 `EMPTY_DEPARTMENTS` 或 `DEPT_COUNT_DROP` 并以 exit 1 结束——**不要绕过**，
  先查凭证可见范围（`WECOM_SYNC_SECRET__<ORG>` 是否指向通讯录应用、应用可见范围是否全量）。

## 2. 手动 apply 一次（验证写路径）

```sh
docker exec openship-platform-core-server sh -lc \
  'pnpm exec tsx scripts/org-sync-all.mjs --org <casdoor_org> --apply'
```

验收：

```sql
-- 最近一次成功同步（probe 的同一证据源）
select tenant_id, at, detail
  from platform.audit
 where action = 'admin.org-sync'
 order by at desc
 limit 5;

-- 组织表新鲜度
select tenant_id, max(synced_at) from platform.org_node group by tenant_id;
```

失败时审计行带 `detail.failed`，且脚本 exit 1。

## 3. 建 openship job

在目标项目下建 job（`serverId` = 该实例注册的 server；命令用 `docker exec` 进 server 容器）：

| 字段 | 值 |
|---|---|
| 名称 | `org-sync（企微组织同步）` |
| cron | `13 */6 * * *`（UTC，每 6 小时；首版节奏，可按运营需要调整） |
| 命令 | `docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/org-sync-all.mjs --apply'` |
| 通知 | `notifyConfig.states=['failed']`，复用现有通知通道 |
| 超时 | 建议 ≥ 10 分钟（全租户 dry-run + apply；单租户秒级） |

> job key 由 openship 生成（`custom:...`），不要手填。

## 4. 新鲜度探针（已登记，无需手动建）

`deploy/integration-registry.json` 的 `org-sync-freshness`：

- 证据 = `platform.audit` 中 `action='admin.org-sync'`、`dryRun=false`、无 `failed` 的最新行；
- SLA = 8h（6h 一跳，允许错过一轮）；
- 任一配置了企微的租户超过 8h 无成功同步，或从未成功同步 ⇒ **STALE**；
- 本实例没有配置企微的租户 ⇒ 判为不适用（回 `now()`），不会长期假红；
- dry-run 审计**不算数**，避免手动预演把证据刷绿。

查看：控制台「集成健康」页，或 `GET /api/platform/admin/integrations`。

> ⚠️ **探针循环本身要先在跑**：`INTEGRATION_PROBE_INTERVAL_MS=60000` 必须在 openship **项目 env**
> 显式设置。只写在 `deploy/docker-compose.yml` 的 `environment` 里不够——2026-11-10 实测该部署的
> 容器内变量为空，`platform.integration` 全空、集成健康页空白（探针循环按缺省 0=关）。
> 修法：`patch_projects_by_id_env` upsert 该键后重部署；验证
> `docker exec openship-platform-core-server printenv INTEGRATION_PROBE_INTERVAL_MS` 输出 `60000`。

## 5. 失败处置

| 症状 | 首查 | 处置 |
|---|---|---|
| `WECOM_API` / `60020` | 出口 IP 是否在企微可信名单 | 加白名单；不要改用别人的机器 |
| `EMPTY_DEPARTMENTS` / `DEPT_COUNT_DROP` | 同步应用的可见范围 | 换 `WECOM_SYNC_SECRET__<ORG>` 为通讯录应用；确认可见范围全量 |
| `SKIPPED`（无 corp/secret） | `platform.tenant` 行与 env | 补 `wecom_corp_id` / secret；无企微的租户属预期 |
| Casdoor 失败 | `CASDOOR_URL` / admin 凭据 | 修凭据；同步本身可重跑 |
| 审计写失败 | 数据库连通性/权限 | 先修 DB；job 会 exit 1 |
| 探针 STALE 但 job 绿 | 是否只跑了 dry-run / 是否最近 8h 内无 apply | 跑一次 `--apply`；核对审计行的 `dryRun` |

## 6. 回滚与数据安全

- 同步是 **upsert + 软删**：企微侧消失的部门 `status=0`，membership 整组重写；**不物理删**。
- 没有历史快照表；回滚口径 = **修正源（企微/凭证）后重跑**，而不是回滚数据库。
- 写动作只落在 `platform.org_node` / `platform.org_membership` + `platform.audit`；
  不写 Casdoor（建号仍是管理动作）。
- 需要暂停定时任务：在 openship 里 disable job；组织表保持最后一次成功同步的状态。
