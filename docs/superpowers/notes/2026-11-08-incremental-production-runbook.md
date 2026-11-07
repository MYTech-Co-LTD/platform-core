# 增量管线上生产 runbook — `request.order`（第一条）

> **状态：待执行**（2026-11-08 写；本文只写操作步骤与判据，**未动生产**）。
> 机制与真机证据：`docs/superpowers/specs/2026-11-08-incremental-and-run-layout-design.md`；
> 生成器与试点：`scripts/gen-pipeline.mjs` + `deploy/duckle/manifests/pilot.incr_*.json`（PR #1632）。
> 上一次切换（2026-11-07）因**子管线列集不对**（缺 `batch_id/system_book/bizday`）已完整回滚；
> 生成器已修（父页列表产出 ITER 列 + 子管线投影自动改写），并在 `pilot/` 前缀重验：
> **273 行 / 67 单号 / 24 列与契约同序**。下面按修正后的版本写。

---

## 执行记录（2026-11-08，`3120` 已切；`64188` 未切）

| 步骤 | 结果 |
|---|---|
| S3 首跑 | `ok`，9 页 / 16.7s；`probe` 67 行、`tail` 0 行、`dgt` 0 行 |
| S4 湖回读（对象层） | **273 行 / 67 单号**，与旧 `all.parquet` 一致；**24 列**与契约同序；关键列 0 NULL |
| S5 删旧对象 | `all.parquet` 已删；staging `system_book=3120` → **273 / 67**（无重复） |
| S6 第二跑 | `pages=0`、`fe` 0、`ok`，5.2s（1 次探针 + 1 次尾页哨兵） |
| S7 观测面 | owners match 已改 `bizday=*/*.parquet`；catalog 已重建；scorecard **GREEN** |
| console | 已服务级重启（排班定义热加载）；排班条目不变 |

**踩到并已修的三条**（生成器里已固化，见 §1 B1/B3）：
① 身份探针 `w0` 缺 `schema` ⇒ 空响应时 `w0` 直接报错；
② 尾页探针误用 `page_size=1` ⇒ page 10 变成有效页、哨兵假红；
③ 契约生成器会把 `.page` 子管线的 ITER 投影打回父 token ⇒ 已跳过 `.page`（列集仍由 `check-data-contract` 守）。

**下一步**：观察 3120 至少一天（次日 09:21 CST 起的小时档）；无异常后把 `64188` 加入 manifest
`accounts`、生成并重复 S1–S7；两账套都切完再把 owners match 收窄到 `page=*.parquet`。

---

## 0. 对象与基线

| 项 | 值 |
|---|---|
| 首条源 | `request.order`（先 `3120`，观察一天，再 `64188`） |
| 现役管线 | `deploy/duckle/console/pipelines/lemeng.request.order.l0.<acct>.json` |
| 现役形态 | whoami 身份闸（`w0→g0→g1→g2→d0→g3→d1→gv→dv`）+ 9 数据页 + 第 10 页截断哨兵 + `merge/shape/gate` → `.../bizday=<D>/all.parquet` |
| 排班 | `21 9-23 * * *` Asia/Shanghai（3120 `misfire=all` / 64188 `misfire=skip`）——**切流不改排班** |
| 读侧 | `stg_lemeng_request_order` glob `.../lemeng/request_order/*/bizday=**/*.parquet` ⇒ **已覆盖 `page=` 文件，无需改视图** |
| 契约 | `contracts/common/lemeng.request_order.json`，**24 列**；`layout.fileName=all.parquet` |
| 新鲜度锚 | `owners.lemeng.json` → `minio://*/lemeng/request_order/system_book=*/bizday=*/all.parquet` |

---

## 1. 上生产前必须解决（不过不切）

### B1 · 身份闸 / 截断哨兵（**已由生成器解决**，2026-11-08）

生成器新增两个 manifest 开关，增量父管线自动带：

- `identityGate: true` ⇒ 标准 `w0..dv`（whoami → 账套/门店自证 → env 形状闸），用 `on-subjob-ok`
  控制边挂到首个数据节点（`probe`）；**`w0` 必须申报 `schema`**（空响应时引擎按它构造关系，
  否则 `query returned 0 records and no schema is declared` —— 真机踩过）。
- `truncationGuard: true`（增量形态）⇒ 父管线加「第 `pages+1` 页」尾页探针 `tail` + `ctl.die`：
  尾页非空 = 已击穿 `pages × pageSize`。代价是每轮多 1 次请求（无新数据时也跑）。

切前仍要验：生成物里 `w0..dv` 在位、`dv` 有 `on-subjob-ok` 边到 `probe`、`tail/dgt` 在位。

### B2 · 契约 `layout.fileName` 与 page 文件不一致

契约声明 `all.parquet`，平台校验器 `modules/data/domain/pipelines/validate.ts` 硬要求
`layout.fileName === 'all.parquet'`；增量产物是 `page=N.parquet`。读侧 glob 不看文件名，所以**读得到**，
但声明不再为真。首条按「已知偏差」记账（不改契约）；批量前再决定是否改契约 + 校验器
（架构级改动，需 spec 与人同意）。

### B3 · 指纹必须能看见「新增」与「修改」

`request.order` 的实测：page 1 按 `request_order_fid` **升序**（低单号在前），且单据号长度不固定
（`YH3120` + 变长门店码 + 日期 + 序号）⇒ **`max(order_no)` 的字符串序不等于业务序，且看不见后页新增**。
改用源端真实存在的 `last_edit_time`（API 文档确认字段，实测有值）做指纹：

```sql
coalesce(max(CAST(last_edit_time AS VARCHAR)), '') || '|' ||
coalesce(max(CAST(request_order_fid AS VARCHAR)), '')
```

生成器同时把 `count(*) AS n` 带进指纹节点；`cmp` 里 `n >= pageSize` 时**强制全量采**
（`probe_full`）——探针页满意味着可能还有后页，不能靠 page 1 的指纹判断「没新数据」。
⇒ 当日单据 ≤ 100 条时能省请求；> 100 条时退化为全量采（正确但不省）。此判据逐源做。

### B4 · 子管线不展开 `${ENV:*}`

- `sink.bucket` 必须写字面量 `shanhai-data`（pilot 已实测可写）；
- `watermarkPath` 每管线唯一：`/workspace/tmp/lemeng.request.order.l0.<acct>.watermark.parquet`；
- 子管线里 `grep -c 'ENV:'` 必须为 **0**（凭据走 `connectionRef`，其余走 `ITER_ITEM_*`）。

---

## 2. 变更清单（本批只上 `3120`；`64188` 观察一天后再加入 manifest `accounts`）

| # | 文件 | 动作 |
|---|---|---|
| 1 | `deploy/duckle/manifests/lemeng.request.order.l0.<acct>.json` | **新增**（`transform.sql` = 现役 `shape` 节点的契约投影原样；`gate.rules` 同现役） |
| 2 | `deploy/duckle/console/pipelines/lemeng.request.order.l0.<acct>.json` | 由生成器**替换**（父） |
| 3 | `deploy/duckle/console/pipelines/lemeng.request.order.l0.<acct>.page.json` | 由生成器**新增**（子） |
| 4 | `deploy/duckle/console/owners.lemeng.json` | `match` 改为 `.../bizday=*/*.parquet`（过渡期同时匹配旧 `all.parquet` 与新 `page=*.parquet`；两账套都切完再收窄） |
| 5 | `deploy/data-plane.lock` | 重生成（`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`） |
| — | `schedules/<acct>.json` | **不改**（`pipeline_id` 不变） |
| — | `dbt/.../stg_lemeng_request_order.sql` | **不改**（glob 已覆盖） |

---

## 3. 执行顺序（每步判据不过就停）

### S0 · 回滚包（先做）

- 记录现役文件 sha：`git rev-parse HEAD:deploy/duckle/console/pipelines/lemeng.request.order.l0.<acct>.json`；
- 记录当日湖对象：`.../bizday=<D>/all.parquet` 的 size / ETag（`D = date-1d`）；
- **不要提前删旧对象**——它是回滚锚，S5 之前一直保留。

### S1 · 生成 + 本地门禁

```sh
pnpm exec tsx scripts/gen-pipeline.mjs deploy/duckle/manifests/lemeng.request.order.l0.<acct>.json
pnpm exec tsx scripts/check-source-manifests.mjs
pnpm exec tsx scripts/check-data-contract.mjs      # 子管线 = 生产者：24 列同序
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs   # 改了管线文件必须重生成 lock
pnpm exec tsx scripts/check-data-plane-lock.mjs
```

判据：全绿；父 + 子两份生成物都在；子管线 `transform.sql` 里 `ENV:` 计数 = 0。

### S2 · seed + 重启 + catalog

1. 确认 console 在运行态（`seed-console.sh` 的校验走 `docker exec`，停着会假红）；
2. `SYNC_PROXY=<控制面公网 EIP:4878> sh /opt/lemeng-seed-console.sh <acct> --seed all`；
3. openship MCP **服务级 restart**（不是定向部署）；
4. `POST /api/catalog`（否则 run 记录不带 `assets`，新鲜度时钟不起算）；
5. `GET /api/schedules` 仍列出同一 `pipeline_id`（排班未变）；`/workspace/pipelines/` 同时有父 + 子。

### S3 · 首跑（手动）

- `POST /api/run`（同步口）或 async + 轮询 `/api/run/status?runId=`；
- 判据：`status=ok`；子管线 run 数 = `pages`；父 run 记录带 `assets`。
- 若 `pages=0`：先确认水位文件是**首次**（旧水位在 `pilot/` 前缀下，生产路径应为空）；否则说明
  「今天确实没有新数据」，换一个已知有数据的窗口重验（或在测试前缀上验）。

### S4 · 独立回读湖（F 段硬判据，不能只看 run ok）

直接读对象存储（不是经 staging）：

- `count(*)` 与 `count(distinct order_no)`；
- **列集 == 契约 24 列且同序**；
- 关键列非空率：`batch_id / system_book / bizday / order_no / branch_num / item_num` 全 100%；
- `batch_id` 形如 `rq-<book>-request_order-YYYYMMDDTHHMMSSZ`；
- 与旧输出**同日**对比 `count(*)` / `count(distinct order_no)`；差异必须能归因（源端迟到/补录），
  **不许有列缺失**。
- ⚠️ 对比在**对象层**做：新旧共存时 staging 会把两套都算进去。
- 若本轮 `pages` 是 1..N 且探针页满（`n >= pageSize`）⇒ 属 `probe_full` 强制全量采，**预期行为**，
  不是指纹失效。

### S5 · 删旧对象（新输出验过才做）

- `HEAD` + `DELETE` `.../bizday=<D>/all.parquet`（每账套各自）；
- 回读 staging：行数 == 新对象行数（无重复）。不删就是**同一天双份**。

### S6 · 第二跑（无新数据路径）

- 同一天再跑一次；判据：`pages=0`、**0 个子管线**、run `ok`、湖对象数不变、水位文件 mtime 更新。
- 这是线上每小时的真实路径：**只有 1 次探针请求**（+1 次尾页哨兵）。
- ⚠️ 若当日单据 > `pageSize`（100），探针页满 ⇒ `probe_full` 强制全量采，`pages` 恒为 1..N；
  此时**没有请求节省**，但不会漏数。看 `cmp` 的 `n` 判断是哪条路径。

### S7 · 观测面

- owners `match` 改 `page=*.parquet` 后 seed；`freshness.json` 该资产出现且非 `unknown`；
- 次日 `pipeline-scorecard` 本管线在列且 **GREEN**；
- 观察 24h：每次排班 run 的 `pages` 与湖对象数对得上；无重复键；staging 行数稳定；无告警。

---

## 4. 回滚（照 2026-11-07 实测的完整包）

1. 恢复现役管线文件（`git checkout` / `.bak`），删 `.page.json`；
2. 恢复 `owners.json`（sha 回基线）；
3. **删新写的 `page=*.parquet`**（逐个 HEAD + DELETE）——不删会被 dbt 的 `bizday=**/*.parquet` 读到；
4. seed + restart + `POST /api/catalog`；
5. 验证：旧管线跑一次 `ok`；staging 行数回基线；scorecard 等级与切前一致。

> 旧 `all.parquet` 在 S5 之前一直保留 ⇒ 任何一步失败都可退；S5 之后回滚需从备份/源端补当天数据。

---

## 5. 推广顺序

`request.order 3120`（观察 1 天）→ `64188`（观察 1 天）→ A 类其余逐条重复 S1–S7：
`branch.expense` / `client.expense` / `transfer.in` / `transfer.out` / `wholesale.out` /
`wholesale.return` / `loss.adjustment` / `purchase.analysis`。

B 类 10 条（全量快照/报表类）**不做增量**，走降频方案——需业务确认降频不影响看数。

---

## 6. 已知未验 / 边界

- **foreach 有新数据时更慢**：零售实测 60.7s（静态页）→ 103.4s（foreach c=2）；request.order 10 页需实测，
  别把「无新数据 3.6s」当成常态。
- **`continueOnFailure` 不继续剩余页**：单页失败会中断后续页，当天分区可能是「部分新 + 部分旧」；
  run 红后必须整轮重跑，不能当部分成功。
- **水位文件在 console 卷内**：换卷/重建卷 ⇒ 水位空 ⇒ 下一轮全量重采（安全，多花请求）。
- **探针只看第 1 页**：`request.order` 按单号升序，第 1 页是低单号。当日单据 ≤ `pageSize`（100）时
  第 1 页包含全部单据，指纹有效；> 100 时 `probe_full` 强制全量采（正确、但不省）。**不要**把
  「无新数据 3.6s」当成 >100 条/日场景的常态。
- **跨天/迟到单**：水位是全局单值，不按 bizday 分桶；窗口是 `date-1d`。若迟到单的
  `last_edit_time` 小于当日最大值，指纹不变 ⇒ 该迟到单不会被发现。属**已知口径边界**，推广前记入正典。
- **`last_edit_time` 是源端字段**（API 文档确认；实测有值），不是本地时间；不要拿 `create_time`
  代替——审核/改单不会更新 `create_time`。
- **身份探针 `w0` 必须带 `schema`**（生成器已带 `[{name:'x',type:'string'}]`）：空响应时引擎按它
  构造关系；缺了会在 `w0` 直接 `query returned 0 records and no schema is declared`（2026-11-08 真机）。
- **父 run 与子 run 的状态对应**：按 F 段四层验收逐层看，不能只看父 `ok`。
