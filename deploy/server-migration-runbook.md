# 跨机迁移 runbook（数据单元/应用单元分机）

> 案例来源：2026-11-19 把 `platform-core-shanhai`（应用单元）从 `8281d598`(10.0.0.5)
> 迁到 `f225d818`(ecm-7d66-0001 / 10.0.0.3)。本文只记**实测过**的步骤与代价；
> 未验证的一律标「待验证」。

## 0. 为什么走 openship 的 migration pipeline

手工重建项目 = 复制 36 个 env 键（含密钥）+ 自己 dump/restore 平台库（全部租户、排班台账、审计）。
pipeline 会连**卷**一起搬，并带健康/路由验证与显式 cutover 确认。

⚠️ **MCP 工具集没有 migration 端点**（`post_deployments` 的 `serverId` 不是它）。入口只有控制台：
项目 → 迁移 / Move to server → 选目标机 → 预览 → 确认 → 等 `awaiting_cutover` → 确认切换。

台账在控制面 DB 的 `public.docker_migration_run`（`status` / `bytes_moved` / `last_event_at` / `logs`），
卡住时先看这张表的 `last_event_at` 与 `logs` 尾部，别只看 UI 转圈。

## 1. 迁移前：目标机就绪（四件，缺一件就会在迁移里踩）

| # | 项 | 判据 |
|---|---|---|
| 1 | 镜像源 = **本机 pull-through 缓存 registry** | `registry-mirrors` 写成两级 `["http://127.0.0.1:5000","<公共镜像源>"]`（2026-11-19 实测：**列表会按序回落**，首项坏掉时 pull 仍成功）。做法与 CA 坑见 `openship-adopt.md` 坑 8；改 `daemon.json` 后 `kill -HUP $(pidof dockerd)` 热加载，**不重启容器** |
| 1′ | 基础镜像预拉 | 就绪后跑 `bash scripts/prewarm-images.sh`（清单解析自 Dockerfile/compose），把「首次穿缓存拉大镜像」从部署期挪到准备期 |
| 2 | 安全组两条 | 目标→源 `18090`（产物服务）、源→目标 `5432`（调度器连平台库）。实测用 `nc -z -w3` 双向验 |
| 3 | 磁盘 | 目标机 ≥ 项目快照大小（`snapshotSizeBytes`）+ 构建余量 |
| 4 | 基础镜像预拉 | `docker pull postgres:16-alpine node:22-bookworm-slim node:22-alpine`（走本地缓存 registry，快）。**openclaw 的基础镜像在 ghcr.io（`Dockerfile.openclaw` 的 FROM），`registry-mirrors` 不管它**——它走 dockerd 的 `HTTPS_PROXY` 直连，也要预拉 |

## 2. 迁移前：源端解耦（**否则迁完即断**）

`platform-core` 曾经有三条宿主 bind：两个 console 的 `runs/` 目录 + dbt 产物目录。
它们指向**源机磁盘**，迁移只搬卷不搬宿主路径 ⇒ 迁到目标机后 server 读到空目录。

现方案（#2519）：数据单元的 `artifacts` 只读服务 + 应用单元的宿主层同步（`artifacts-sync.ts`），
模块仍按文件读，拉不到就 `unknown`。**迁移前确认应用单元 `docker inspect` 的 Mounts 里
没有宿主 bind**（本仓已被 `scripts/` 与 compose 固化）。

## 3. 迁移本身：镜像走公网流式，**这才是耗时所在**

实测（2026-11-19，A 8281d598 → B f225d818，同 VPC）：

| 对象 | 大小 | 耗时 | 速率 |
|---|---|---|---|
| `server` 镜像 | ~270 MB | 7m22s | ~0.6 MB/s |
| `notify-worker` 镜像 | ~270 MB | 7m21s | ~0.6 MB/s |
| `postgres` 镜像 | ~111 MB | 2m58s | ~0.6 MB/s |
| `openclaw` 镜像 | ~5 GB | （进行中） | ~0.9 MB/s（按目标机磁盘增量实测） |

**关键结论（2026-11-19 两次踩实）**：

- **镜像**：经控制面流式推送（公网 ~7 Mbps）；
- **卷**：名义上是 `server-to-server rsync (push)`，但目标写的是**公网 IP**
  （实测 rsync 命令行 `root@113.249.104.180:/…`）⇒ 同样是公网速率
  （`pgdata` 2.3GB 实测 **~0.75 MB/s ≈ 50 分钟**）；
- 两者**都用不上 VPC 带宽**（A↔B 私网 iperf 实测 3 Gbps）。

所以「同 VPC 会很快」是**错的**：迁移总耗时 ≈（镜像总量 + 卷总量）÷ 0.6~0.9 MB/s。
本案例 4 个镜像（~5.7GB）+ 卷（~2.4GB）⇒ **约 2 小时**；而且卷拷贝前会**停源端容器**
（一致性拷贝），所以**停机时长 ≈ 迁移总时长**。排窗口按这个量级，不要按 VPC 带宽估。

- 卡住判据：`last_event_at` 超过 **10 分钟**不前进且目标机磁盘不增长 ⇒ 真卡；
  只有前者不动而磁盘在长 ⇒ 正在搬大镜像，等。
- **待验证的加速法**：迁移前用 `docker save <img> | ssh target docker load` 把大镜像**经 VPC 直传**
  预置到目标机，让 pipeline 跳过。需实测确认 pipeline 认本地已有镜像（本次未验证，别当结论用）。
- 控制面 `.env` 的 `OPENSHIP_TRANSFER_*`（`patch_settings_transfer`）只影响**卷**的传输模式，不影响镜像流。

## 4. cutover 之后：三个必须改的值

迁移完成后项目 `serverId` 才会变（`awaiting_cutover` 期间仍是源机）。切换后立刻改：

| 位置 | 键 | 新值 |
|---|---|---|
| 应用项目 env | `DATA_BIND_ADDR` | 目标机私网 IP（否则平台库只绑回环，源机的调度器连不上） |
| 应用项目 env | `DATA_WAREHOUSE_URL` | `…@<源机私网 IP>:15432/warehouse`（**服务名 `pg_duckdb` 在目标机解析不到**） |
| 数据项目 env | `SCHEDULER_DATABASE_URL` | `…@<目标机私网 IP>:5432/platform` |

改完定向重部署 `postgres`（应用单元）与 `scheduler`（数据单元）。

## 5. 验收口径（缺一条都算没完成）

```sh
# 1) 两站 200
curl -o /dev/null -w '%{http_code}\n' https://platform.shanhaiyiguo.com/
# 2) 调度双实例心跳新鲜
psql -c "select id, to_char(beat_at,'HH24:MI:SS') from platform.job_heartbeat order by id"
# 3) 数据类作业仍 ok（跑在数据单元）
psql -c "select key,status,to_char(started_at,'HH24:MI') from platform.job_run order by started_at desc limit 5"
# 4) 产物链仍通（应用单元日志出现 artifactsSync tick，且 /tmp/dbt-artifacts 有文件）
docker logs <目标机 server> | grep artifactsSync | tail -2
```

## 5.5 迁移会被 compose 评审闸门挡死（2026-11-19 实测，第一次迁移因此回滚）

pipeline 在目标机上执行的部署**不会带 `acceptComposeChanges`**。所以只要项目当前有未清的
compose 漂移（`COMPOSE_REVIEW_REQUIRED`），迁移就会在「data move complete → deploying to target」
这一步失败：

```
FAILED — The Compose configuration has changed. Review the changes before deploying.;
rolling back (restart source, tear down target)
```

后果：源端重启（服务恢复），**目标机新建的卷被删除**（已搬的 4.45GB 白搬），镜像保留。

**迁移前必做**：把每个有漂移的服务用 `drift_keep` 清掉，并用一次**不带 accept 标志**的部署验证
闸门已放行（能起来 = 已清）：
```sh
# MCP：post /projects/:id/services/:serviceId/drift/keep（保本地覆盖）
# 再 post /deployments（**不要**带 acceptComposeChanges）——若返回 409 说明还有漂移
```

## 5.6 兜底：手工迁移路径（2026-11-19 实测，pipeline 连续失败后采用）

当 pipeline 反复失败（本次 4 次：compose 闸门 / 目标机残留 / 中断 / 再撞闸门），可手工完成，
**核心是卷走私网**——同一批量 981MB，pipeline 走公网 78 分钟，私网 rsync **9 秒**：

```sh
# ① 停源端容器（一致性窗口从这里开始）
docker stop <源端 4 个容器>
# ② 私网 rsync 卷（源机 → 目标机 10.0.0.x，需临时 key）
rsync -a --delete -e 'ssh -i /root/.ssh/<tmp-key> -o StrictHostKeyChecking=no' \
  /var/lib/docker/volumes/<proj>-pgdata/_data/ root@<目标私网>:/var/lib/docker/volumes/<proj>-pgdata/_data/
# ③ 控制面 DB 改项目归属（openship 无对应 MCP 工具）
update project set server_id='<目标 serverId>' where id='<projectId>';
# ④ MCP 触发部署，**必须带 acceptComposeChanges:true**（闸门仍会拦）
# ⑤ 改数据单元 SCHEDULER_DATABASE_URL → 目标机私网:5432，refresh 调度器
```

要点：
- 目标机卷目录要先 `mkdir -p`（rsync 不会建父目录），并按镜像 uid `chown -R`（本例 openclaw / dbt 都是 1000）。
- **DNS 不在 openship 手里**（`dns_credentials` 为空）⇒ 迁完要人工把 A 记录改到新机；证书在新机由 edge
  走 HTTP-01 自动重签（实测 1 分钟内 `sslExpiresAt` 更新），不需要动 ACME。
- openclaw 迁完若 403 `Proxy client attribution is required`：它的 `gateway.trustedProxies` 里写死了
  源机的 docker 网段（如 172.18.0.1），目标机网络不同（如 172.22.0.1）⇒ 改 `/home/node/.openclaw/openclaw.json`
  后重启该容器。
- 手工路径**绕过了 pipeline 的健康/路由验证**，所以第 4 步之后必须自己按 §5 的四条验收跑一遍。

## 6. 已知坑

- **服务行的 env 表优先于 `environment` 合并补丁**：对已存在的键用
  `patch services/:id`（environment 合并）**不生效**，必须 `PUT services/:id/env` 整表替换
  （密钥用 `••••••••` 占位保持原值）。本次因它多踩了一次 EACCES。
- **命名卷根目录归 root**：镜像以 `node`(1000) 运行时，新卷要
  `docker run --rm -v <vol>:/v alpine chown 1000:1000 /v` 一次，否则 dbt 直接 exit 1。
- 迁移期间**源端照常服务**，正式切换只发生在 cutover 确认那一刻；切换前不要改源端配置。
