# 已验证问答的回归 job（`verify-regression-shanhai`）

> 代码：`scripts/verify-regression.mjs`（本地可跑，`--org <casdoor org> --limit N`）。
> 本文件是**入仓记录**（2026-11-11，Wave 1.4 / issue #1969）：job 早已在生产，但 `deploy/`
> 零命中——换台机器重建不出来。**只补文档，不改 job 行为。**

## 生产实例（2026-11-11 从控制面读回）

| 字段 | 值 |
|---|---|
| key | `custom:V_Kmm5HiLDgnBFQn`（`job_sUsMh1nX7WL52ydu`） |
| label | `verify-regression-shanhai` |
| serverId | `8281d598-af73-4d0b-99dd-bc8681fcc8bb`（山海数据机） |
| cron | `10 4 * * *`（UTC = 北京 **12:10**） |
| timeout | 300s |
| 通知 | `states=['failed']`，通道 `nch_XBUs425hd_KsA_lt`（与其余数据面 job 同一条） |
| 最近一次 | 2026-11-11T04:10Z `success`（10s） |

## 命令（生产原文）

```sh
CID=$(docker ps -q --filter 'name=openship-platform-core-shanhai-server' | head -1)
[ -z "$CID" ] && { echo NO_SERVER_CONTAINER; exit 1; }
docker exec "$CID" sh -lc 'cd /app && npx tsx scripts/verify-regression.mjs --org shanhaiyiguo-org'
```

包装层另外做两件事（不是判据，是**观测**）：

1. 把最后一行输出截 300 字当 detail；
2. `python3 /opt/lemeng-emit-probe.py regression:shanhaiyiguo-org OK|RED "<detail>"` 发探针
   （OO 面能看见历史曲线，`PROBE_EMIT_FAILED` 不改变退出码）。

## 判据

- 退出码 = `verify-regression.mjs` 的退出码：0 = 全部通过；1 = 有 `fail`/`error` 行（回归破了）；
  2 = 跑不成账（缺 `DATABASE_URL` / `DATA_WAREHOUSE_URL`，或读基线失败）。
- 台账口径（`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`）：
  该 org 现有 `verified_questions` 逐条重放，**结构 + 相对容差**比对，滚动窗口的题不入集
  （`open_period_not_stable`）。
- **改口径是唯一的红因**：题集与基线不变时它必须恒绿；红了先看最近合并的 dbt 改动，不要先怀疑 job。

## 重建步骤（换机器时）

1. 确认 server 容器里 `scripts/verify-regression.mjs` 与 `dbt/target` 都在（镜像自带）；
2. `DATABASE_URL` / `DATA_WAREHOUSE_URL` 走 server 的项目 env（job 本身不注入 secret）；
3. 照上表建 job 后**手动触发一次**：`post_jobs_by_key_run` → 看输出首行
   `total=N pass=N fail=0 error=0` 与 exit 0。
