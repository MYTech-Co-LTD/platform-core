# 候选池定时生成 job（`metric-candidates`）

> 代码：`scripts/metric-candidates-job.mjs`（薄 CLI）+ `modules/data/domain/candidate-generator.ts`（规则与退役/复活）。
> 设计出处：`docs/superpowers/specs/2026-11-04-auto-metric-derivation-design.md`；台账 issue #1969。
> 范式与 `deploy/notify-jobs.md` 一致：**仓内脚本 + openship job**（零常驻），命令走
> `docker exec <server 容器> sh -lc '…'`——不把定时副作用塞进 server 进程。

## 它补的是哪条断链

`POST /metrics/candidates/generate` 不只是「产出候选」：**陈旧候选的退役（`expired`）与
重新被画像支持的候选的复活（`revived`）都发生在这一次调用里**（`candidate-generator.ts`）。
没有定时跑 ⇒ 池子只在人手动点生成时才收敛，旧画像推出来的候选会一直挂着。

## 命令

```sh
docker exec openship-platform-core-shanhai-server sh -lc 'pnpm exec tsx scripts/metric-candidates-job.mjs'
```

- env：`DATABASE_URL`（平台库，候选表）+ `DATA_WAREHOUSE_URL`（仓库库，`data.metric_profiles` 画像）。
  两者都已在 server 容器的项目 env 里；**job 不需要额外 secret**。
- 驱动清单 = 画像表里出现过的 org（`orgsWithProfiles`）：没有画像的 org 跑生成只会得到
  「0 条候选」的噪声，而 `orgs=0` 本身就是要被看见的信号（profiler 没投递）。

## 判据（stdout 一行总账 + 退出码）

```
metric-candidates: orgs=1 failed=0 added=3 refreshed=12 expired=2 revived=0 pendingAfter=15
```

| 退出码 | 含义 |
|---|---|
| 0 | 全部租户生成成功（`added=0` 也是成功：没有可推的列是正常结果） |
| 1 | 有租户生成失败（逐行 `org=… code=… detail=…`；code ∈ `DATA_WAREHOUSE_UNCONFIGURED` / `PROFILE_UNAVAILABLE` / `CATALOG_UNAVAILABLE` / `CANDIDATE_STORE_UNAVAILABLE`） |
| 2 | 查不成账（缺 `DATABASE_URL` / `DATA_WAREHOUSE_URL`，或读画像表本身失败） |

- **`orgs=0` 是告警信号**：画像表空 = profiler 没投递（参考 2026-11-09 workspace 堆积事故的同型沉默）。
- `pendingAfter` 是**池级**口径（每关系 ≤ `maxPerRelation`），多次生成不会把池撑爆；
  `capped` 只反映本轮截断。

## openship job（建议排班）

| 字段 | 值 |
|---|---|
| key | `custom:tB6ulrsKtgW852WL`（`job_9Hf_OKt12BYvMthm`，2026-11-11 建） |
| serverId | `8281d598`（山海数据机） |
| cron | `40 6 * * *`（UTC = 北京 14:40，每日一次） |
| 命令 | 见上 |
| `notifyConfig` | `states=['failed']`，通道与其余数据面 job 同一条 |

排班依据：画像管线 `lemeng.metric_profile.3120` 是 **每周**（`10 5 * * 0`）跑的，候选生成按日跑已足够覆盖新画像；更密只会重复产出相同候选（幂等但仍占库）。

## 首次真机跑（2026-11-11T14:58Z，手动触发 `jrun_x0nb662U3mApMrID`，1.96s，exit 0）

```
metric-candidates: org=shanhaiyiguo-org profiles=264 relations=21 added=104 refreshed=167 expired=111 revived=0 pendingAfter=269 skipped=137 capped=28 maxPerRelation=20
metric-candidates: orgs=1 failed=0 added=104 refreshed=167 expired=111 revived=0 pendingAfter=269
```

- `orgs=1`：只有 `shanhaiyiguo-org` 有画像行（与 `data.metric_profiles` 实况一致）。
- `added=104` 是候选池**第一次**被定时任务填充；同时 `expired=111` 证明退役路径真的在跑。
- `pendingAfter=269` ≤ 21 关系 × 20/关系（=420）——池级上限成立。

